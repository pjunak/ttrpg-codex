package packagemanager

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

// disconnectingFactory makes runtimes that honour cancellation the way
// workersupervisor.Supervisor does. It can cancel the browser request when the
// next worker starts or stops, and can make chosen add-ons fail to stop.
type disconnectingFactory struct {
	fakeRuntimeFactory
	created  []*fakeRuntime
	atStart  context.CancelFunc
	atStop   context.CancelFunc
	stopFail map[string]error
}

func (factory *disconnectingFactory) New(spec RuntimeSpec) (Runtime, error) {
	runtime, err := factory.fakeRuntimeFactory.New(spec)
	if err != nil {
		return nil, err
	}
	fake := runtime.(*fakeRuntime)
	factory.mu.Lock()
	factory.created = append(factory.created, fake)
	factory.mu.Unlock()
	return supervisedRuntime{fakeRuntime: fake, factory: factory}, nil
}

func (factory *disconnectingFactory) disconnect(hook *context.CancelFunc) {
	factory.mu.Lock()
	cancel := *hook
	*hook = nil
	factory.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

type supervisedRuntime struct {
	*fakeRuntime
	factory *disconnectingFactory
}

// A supervisor given a cancelled context returns at once and leaves the
// worker as it was.
func (runtime supervisedRuntime) Start(ctx context.Context) error {
	runtime.factory.disconnect(&runtime.factory.atStart)
	if err := ctx.Err(); err != nil {
		return err
	}
	return runtime.fakeRuntime.Start(ctx)
}

func (runtime supervisedRuntime) Shutdown(ctx context.Context) error {
	runtime.factory.disconnect(&runtime.factory.atStop)
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := runtime.factory.stopFail[runtime.spec.Identity.AddonID]; err != nil {
		// A failed graceful stop terminates the process.
		_ = runtime.fakeRuntime.Shutdown(ctx)
		return err
	}
	return runtime.fakeRuntime.Shutdown(ctx)
}

func assertNoUntrackedWorkers(t *testing.T, manager *Manager, factory *disconnectingFactory) {
	t.Helper()
	manager.mu.Lock()
	tracked := make(map[*fakeRuntime]bool, len(manager.runtimes))
	for _, active := range manager.runtimes {
		if runtime, ok := active.runtime.(supervisedRuntime); ok {
			tracked[runtime.fakeRuntime] = true
		}
	}
	manager.mu.Unlock()
	factory.mu.Lock()
	defer factory.mu.Unlock()
	for _, runtime := range factory.created {
		if runtime.started && !tracked[runtime] {
			t.Fatalf("worker %s %s is running but untracked", runtime.spec.Identity.AddonID, runtime.spec.Identity.Version)
		}
	}
}

// transitionFixture runs engine-addon 1.0.0 and, for a cohort, a consumer of
// its service. It returns an approved review of engine-addon 2.0.0.
func transitionFixture(t *testing.T, cohort bool) (*Manager, *disconnectingFactory, string) {
	t.Helper()
	ctx := context.Background()
	factory := &disconnectingFactory{}
	manager, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), factory)
	t.Cleanup(func() { _ = manager.Shutdown(context.Background()) })
	provider := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	if _, err := manager.Activate(ctx, ActivationPlan{
		AddonID: "engine-addon", GenerationID: provider.GenerationID, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	if cohort {
		consumer := stageConsumerPackage(t, manager, "sheet-addon", "1.0.0")
		if _, err := manager.Activate(ctx, ActivationPlan{AddonID: "sheet-addon", GenerationID: consumer.GenerationID}); err != nil {
			t.Fatal(err)
		}
	}
	next := stageServicePackage(t, manager, "engine-addon", "2.0.0", "3.2.0")
	review, err := manager.PrepareActivationReview(ctx, "engine-addon", next.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if (len(review.Proposal.RestartedAddonIDs) != 0) != cohort {
		t.Fatalf("restarted add-ons = %v", review.Proposal.RestartedAddonIDs)
	}
	if _, err := manager.ApproveActivationReview(ctx, review.ReviewID, []string{"core.data.read"}); err != nil {
		t.Fatal(err)
	}
	return manager, factory, review.ReviewID
}

func TestConfirmedTransitionsFinishAfterTheBrowserDisconnects(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		cohort bool
		atStop bool
		run    func(context.Context, *Manager, string) (string, error)
	}{
		{name: "activation while the new worker starts", run: activateReviewed},
		{name: "activation while the old worker stops", atStop: true, run: activateReviewed},
		{name: "cohort activation while the graph stops", cohort: true, atStop: true, run: activateReviewed},
		{name: "reload while the new worker starts", run: reloadEngine},
		{name: "reload while the old worker stops", atStop: true, run: reloadEngine},
		{name: "disable while the worker stops", atStop: true, run: disableEngine},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			manager, factory, reviewID := transitionFixture(t, test.cohort)
			request, cancel := context.WithCancel(context.Background())
			defer cancel()
			factory.mu.Lock()
			if test.atStop {
				factory.atStop = cancel
			} else {
				factory.atStart = cancel
			}
			factory.mu.Unlock()
			problem, err := test.run(request, manager, reviewID)
			if err != nil || problem != "" {
				t.Fatalf("transition = %q, %v", problem, err)
			}
			if request.Err() == nil {
				t.Fatal("the browser request was never cancelled")
			}
			assertNoUntrackedWorkers(t, manager, factory)
		})
	}
}

func activateReviewed(ctx context.Context, manager *Manager, reviewID string) (string, error) {
	result, err := manager.ActivateReviewed(ctx, reviewID)
	return result.CleanupError + result.RecoveryError, err
}

func reloadEngine(ctx context.Context, manager *Manager, _ string) (string, error) {
	result, err := manager.Reload(ctx, "engine-addon", 1)
	return result.CleanupError, err
}

func disableEngine(ctx context.Context, manager *Manager, _ string) (string, error) {
	result, err := manager.Disable(ctx, DisablePlan{AddonID: "engine-addon", ExpectedStateRevision: 1})
	return result.CleanupError, err
}

func TestCohortStopFailureRestartsTheSelectedGraph(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	manager, factory, reviewID := transitionFixture(t, true)
	factory.mu.Lock()
	factory.stopFail = map[string]error{"sheet-addon": errors.New("worker did not stop in time")}
	factory.mu.Unlock()
	if _, err := manager.ActivateReviewed(ctx, reviewID); !errors.Is(err, ErrActivationFailed) {
		t.Fatalf("activation error = %v", err)
	}
	state, err := manager.store.state(ctx, "engine-addon")
	if err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	engine, engineRunning := manager.runtimes["engine-addon"]
	_, sheetRunning := manager.runtimes["sheet-addon"]
	manager.mu.Unlock()
	if !engineRunning || !sheetRunning || engine.generation.GenerationID != state.ActiveGenerationID || engine.generation.Version != "1.0.0" {
		t.Fatalf("graph after a failed stop: engine %v (%s), sheet %v", engineRunning, engine.generation.Version, sheetRunning)
	}
	assertNoUntrackedWorkers(t, manager, factory)
}
