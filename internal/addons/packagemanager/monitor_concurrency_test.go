package packagemanager

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func awaitMonitorOperation(t *testing.T, operation func() error) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- operation() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("operation waited for an unrelated health probe")
	}
}

func startHeldMonitorProbe(t *testing.T, manager *Manager, runtime *monitoredRuntime) (func(), <-chan error) {
	t.Helper()
	manager.monitoring.config.HealthTimeout = 10 * time.Second
	entered, release := make(chan struct{}, 2), make(chan struct{})
	runtime.entered, runtime.release = entered, release
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		done <- manager.checkWorkers(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-joined:
		case <-time.After(3 * time.Second):
			t.Error("held probe did not stop")
		}
	})
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("health probe did not start")
	}
	return func() { close(release) }, done
}

func TestWorkerMonitoringRejectsLateHealthAfterLifecycleChange(t *testing.T) {
	for _, action := range []string{"disable", "reload", "replace", "recover-same-state"} {
		t.Run(action, func(t *testing.T) {
			ctx := context.Background()
			manager, factory, now := monitoringFixture(t)
			installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
			state, err := manager.store.state(ctx, "provider")
			if err != nil {
				t.Fatal(err)
			}
			var replacement Generation
			if action == "replace" {
				replacement, err = manager.Stage(ctx, writeAddonPackage(t, packageSpec{ID: "provider", Version: "2.0.0", Worker: true}))
				if err != nil {
					t.Fatal(err)
				}
			}
			old := factory.runtimes["provider"]
			old.health = "failed"
			*now = now.Add(time.Second)
			release, done := startHeldMonitorProbe(t, manager, old)
			awaitMonitorOperation(t, func() error {
				switch action {
				case "disable":
					review, err := manager.PrepareDisable(ctx, "provider")
					if err != nil {
						return err
					}
					_, err = manager.DisableReviewed(ctx, "provider", review.ReviewSHA256)
					return err
				case "reload":
					_, err := manager.Reload(ctx, "provider", state.Revision)
					return err
				case "replace":
					_, err := manager.Activate(ctx, ActivationPlan{AddonID: "provider", GenerationID: replacement.GenerationID, ExpectedStateRevision: state.Revision})
					return err
				default:
					manager.mu.Lock()
					defer manager.mu.Unlock()
					return manager.recoverWorkerCohortLocked(ctx, []string{"provider"})
				}
			})
			before, err := manager.BrowserGraph(ctx)
			if err != nil {
				t.Fatal(err)
			}
			factory.mu.Lock()
			current, calls := factory.runtimes["provider"], len(factory.log)
			factory.mu.Unlock()
			if action != "disable" && current == old {
				t.Fatal("fixture did not replace runtime")
			}
			release()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			after, err := manager.BrowserGraph(ctx)
			if err != nil || before.GraphRevision != after.GraphRevision || len(factory.log) != calls {
				t.Fatal("obsolete health result restarted the replacement", err)
			}
			if action != "disable" {
				watch := manager.monitoring.watches["provider"]
				if watch == nil || watch.blocked || watch.failures != 0 || watch.observation != nil {
					t.Fatal("obsolete result changed the new runtime health", watch)
				}
			}
		})
	}
}

func TestWorkerMonitoringSharesPendingProbeAndReleasesCancelledObservation(t *testing.T) {
	manager, factory, now := monitoringFixture(t)
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	runtime := factory.runtimes["provider"]
	*now = now.Add(time.Second)
	release, done := startHeldMonitorProbe(t, manager, runtime)
	awaitMonitorOperation(t, func() error { return manager.checkWorkers(context.Background()) })
	factory.mu.Lock()
	checks := runtime.healthCalls
	factory.mu.Unlock()
	if checks != 1 {
		t.Fatalf("pending probe was duplicated: %d calls", checks)
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Second)
	runtime.hang = true
	ctx, cancel := context.WithCancel(context.Background())
	cancelledDone := make(chan error, 1)
	go func() { cancelledDone <- manager.checkWorkers(ctx) }()
	select {
	case <-runtime.entered:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("next scheduled probe did not start")
	}
	cancel()
	if err := <-cancelledDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled probe = %v", err)
	}
	watch := manager.monitoring.watches["provider"]
	if watch.blocked || watch.failures != 0 || watch.observation != nil {
		t.Fatal("monitor cancellation consumed retry budget or retained a probe", watch)
	}
	runtime.hang = false
	tickWorkers(t, manager)
	if runtime.healthCalls != 3 {
		t.Fatalf("cancelled observation blocked later checks: %d calls", runtime.healthCalls)
	}
}

func TestWorkerMonitoringOldResultCannotReleaseNewProbe(t *testing.T) {
	ctx := context.Background()
	manager, factory, now := monitoringFixture(t)
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	old := factory.runtimes["provider"]
	old.health = "failed"
	*now = now.Add(time.Second)
	releaseOld, oldDone := startHeldMonitorProbe(t, manager, old)
	awaitMonitorOperation(t, func() error {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		return manager.recoverWorkerCohortLocked(ctx, []string{"provider"})
	})
	*now = now.Add(time.Second)
	releaseNew, newDone := startHeldMonitorProbe(t, manager, factory.runtimes["provider"])
	manager.mu.Lock()
	pending := manager.monitoring.watches["provider"].observation
	manager.mu.Unlock()
	releaseOld()
	if err := <-oldDone; err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	retained := pending != nil && manager.monitoring.watches["provider"].observation == pending
	manager.mu.Unlock()
	if !retained {
		t.Fatal("old result released the replacement's pending health probe")
	}
	awaitMonitorOperation(t, func() error { return manager.checkWorkers(ctx) })
	releaseNew()
	if err := <-newDone; err != nil {
		t.Fatal(err)
	}
	watch := manager.monitoring.watches["provider"]
	if watch.blocked || watch.failures != 0 || watch.observation != nil {
		t.Fatal("old result affected the replacement health", watch)
	}
}

func TestWorkerMonitoringHealthDoesNotBlockBrowserAccess(t *testing.T) {
	manager, factory, now := monitoringFixture(t)
	installUninstallFixture(t, manager, packageSpec{ID: "slow-worker", Version: "1.0.0", Worker: true})
	spec := packageSpec{ID: "healthy-worker", Version: "1.0.0", Worker: true, UIEntry: "web/index.js",
		Contract: "example.rules", ContractVersion: "3.0.0", ConsumeContract: "example.rules", OptionalConsume: true}
	generation := installUninstallFixture(t, manager, spec)
	*now = now.Add(time.Second)
	release, done := startHeldMonitorProbe(t, manager, factory.runtimes["slow-worker"])
	ctx := context.Background()
	awaitMonitorOperation(t, func() error {
		if _, err := manager.BrowserGraph(ctx); err != nil {
			return err
		}
		if _, err := manager.Snapshot(ctx, "slow-worker", 20); err != nil {
			return err
		}
		connection, err := manager.ConnectBrowserService(ctx, spec.ID, generation.GenerationID,
			BrowserServiceRequest{Contract: spec.Contract, Range: "^3.0.0", Cardinality: "one", IncludeOwn: true})
		if err != nil || len(connection.Providers) != 1 {
			return errors.Join(errors.New("healthy browser service was unavailable"), err)
		}
		provider := connection.Providers[0]
		_, err = manager.CallBrowserService(ctx, spec.ID, generation.GenerationID,
			BrowserServiceTarget{Contract: spec.Contract, ProviderAddonID: provider.AddonID,
				ContractVersion: provider.ContractVersion, Generation: provider.Generation, BindingRevision: provider.BindingRevision},
			servicebroker.MethodCall{Method: "evaluate-character", Params: map[string]any{"value": 4},
				Context: servicebroker.CallContext{Actor: workerrpc.Actor{Role: "dm", ID: "test-dm"}}})
		// The fixture reports an uncertain write after the provider is called.
		// Reaching it, rather than its result, proves service admission stayed open.
		factory.mu.Lock()
		called := factory.calls == 1
		factory.mu.Unlock()
		if !called {
			return errors.Join(errors.New("service did not reach the healthy worker"), err)
		}
		return nil
	})
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
