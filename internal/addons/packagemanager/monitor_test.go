package packagemanager

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type monitoredFactory struct {
	mu        sync.Mutex
	runtimes  map[string]*monitoredRuntime
	failStart map[string]bool
	log       []string
	calls     int
	waitStart bool
}
type monitoredRuntime struct {
	factory    *monitoredFactory
	spec       RuntimeSpec
	state      workersupervisor.State
	health     string
	hang       bool
	entered    chan struct{}
	onShutdown func()
}

func (factory *monitoredFactory) New(spec RuntimeSpec) (Runtime, error) {
	factory.mu.Lock()
	defer factory.mu.Unlock()
	runtime := &monitoredRuntime{factory: factory, spec: spec, state: workersupervisor.StateCreated, health: "ok"}
	factory.runtimes[spec.Identity.AddonID] = runtime
	return runtime, nil
}
func (runtime *monitoredRuntime) Start(ctx context.Context) error {
	factory := runtime.factory
	factory.mu.Lock()
	defer factory.mu.Unlock()
	factory.log = append(factory.log, "start:"+runtime.spec.Identity.AddonID)
	if factory.waitStart {
		factory.mu.Unlock()
		<-ctx.Done()
		factory.mu.Lock()
		runtime.state = workersupervisor.StateFailed
		return ctx.Err()
	}
	if factory.failStart[runtime.spec.Identity.AddonID] {
		runtime.state = workersupervisor.StateFailed
		return errors.New("fixture startup failure")
	}
	runtime.state = workersupervisor.StateReady
	return nil
}
func (runtime *monitoredRuntime) Shutdown(context.Context) error {
	runtime.factory.mu.Lock()
	runtime.factory.log = append(runtime.factory.log, "stop:"+runtime.spec.Identity.AddonID)
	runtime.state = workersupervisor.StateStopped
	hook := runtime.onShutdown
	runtime.factory.mu.Unlock()
	if hook != nil {
		hook()
	}
	return nil
}
func (runtime *monitoredRuntime) Snapshot() workersupervisor.Snapshot {
	runtime.factory.mu.Lock()
	defer runtime.factory.mu.Unlock()
	return workersupervisor.Snapshot{Identity: runtime.spec.Identity, State: runtime.state}
}
func (runtime *monitoredRuntime) Health(ctx context.Context) (workersupervisor.Health, error) {
	runtime.factory.mu.Lock()
	status, hang, entered := runtime.health, runtime.hang, runtime.entered
	runtime.factory.mu.Unlock()
	if entered != nil {
		select {
		case entered <- struct{}{}:
		default:
		}
	}
	if hang {
		<-ctx.Done()
		return workersupervisor.Health{}, ctx.Err()
	}
	return workersupervisor.Health{Status: status}, nil
}
func (runtime *monitoredRuntime) Call(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) {
	runtime.factory.mu.Lock()
	defer runtime.factory.mu.Unlock()
	runtime.factory.calls++
	return nil, errors.New("write outcome unknown")
}
func monitoringFixture(t *testing.T) (*Manager, *monitoredFactory, *time.Time) {
	t.Helper()
	factory := &monitoredFactory{runtimes: map[string]*monitoredRuntime{}, failStart: map[string]bool{}}
	manager, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), factory)
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	manager.store.now = func() time.Time { return now }
	var err error
	manager.monitoring, err = newWorkerMonitor(&MonitoringConfig{HealthInterval: time.Second, HealthTimeout: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Shutdown(context.Background()) })
	return manager, factory, &now
}
func tickWorkers(t *testing.T, manager *Manager) {
	t.Helper()
	if err := manager.checkWorkers(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func TestWorkerMonitoringRecoversOnlyAffectedCohort(t *testing.T) {
	ctx := context.Background()
	manager, factory, now := monitoringFixture(t)
	provider := installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true, Contract: "example.rules", ContractVersion: "3.0.0"})
	installUninstallFixture(t, manager, packageSpec{ID: "required", Version: "1.0.0", Worker: true, ConsumeContract: "example.rules"})
	installUninstallFixture(t, manager, packageSpec{ID: "transitive", Version: "1.0.0", Worker: true, DependencyID: "required", DependencyRange: "^1.0.0"})
	installUninstallFixture(t, manager, packageSpec{ID: "optional", Version: "1.0.0", Worker: true, ConsumeContract: "example.rules", OptionalConsume: true})
	installUninstallFixture(t, manager, packageSpec{ID: "unrelated", Version: "1.0.0", Worker: true})
	unrelated := factory.runtimes["unrelated"]
	beforeGraph, _ := manager.BrowserGraph(ctx)
	beforeState, _ := manager.store.state(ctx, "provider")
	beforeLog := len(factory.log)
	// The coordinator may restart the process, never the failed domain operation.
	_, _ = factory.runtimes["provider"].Call(ctx, "write", nil, nil)
	factory.runtimes["provider"].state = workersupervisor.StateFailed
	tickWorkers(t, manager)
	failedGraph, _ := manager.BrowserGraph(ctx)
	if beforeGraph.GraphRevision == failedGraph.GraphRevision {
		t.Fatal("headless failure did not invalidate browser handles")
	}
	if _, live := manager.runtimes["provider"]; live {
		t.Fatal("failed provider remains live")
	}
	if _, live := manager.runtimes["required"]; live {
		t.Fatal("required consumer remains live")
	}
	if _, live := manager.runtimes["transitive"]; live {
		t.Fatal("transitive consumer remains live")
	}
	if manager.runtimes["optional"].runtime == nil || len(factory.runtimes["optional"].spec.BoundServices) != 0 {
		t.Fatal("optional consumer did not recover without its provider")
	}
	if factory.runtimes["unrelated"] != unrelated {
		t.Fatal("unrelated runtime restarted")
	}
	stops := []string{}
	for _, entry := range factory.log[beforeLog:] {
		if strings.HasPrefix(entry, "stop:") {
			stops = append(stops, strings.TrimPrefix(entry, "stop:"))
		}
	}
	if slices.Contains(stops, "unrelated") || slices.Index(stops, "transitive") > slices.Index(stops, "required") || slices.Index(stops, "required") > slices.Index(stops, "provider") {
		t.Fatalf("unsafe stop order: %v", stops)
	}
	providers, _ := manager.broker.ListProviders(ctx, "example.rules")
	if len(providers) != 1 || providers[0].ActiveGeneration != "" {
		t.Fatal("failed provider still routable", providers)
	}
	state, _ := manager.store.state(ctx, "provider")
	if state.ActiveGenerationID != provider.GenerationID || state.Revision != beforeState.Revision {
		t.Fatal("monitor changed durable activation", state)
	}
	snapshot, _ := manager.Snapshot(ctx, "provider", 20)
	if snapshot.Runtime == nil || snapshot.Runtime.State != workersupervisor.StateFailed || snapshot.Runtime.Identity.Version != "1.0.0" || !strings.Contains(snapshot.Runtime.LastError, "attempt 1") {
		t.Fatal("failure not visible", snapshot)
	}
	*now = now.Add(time.Second)
	tickWorkers(t, manager)
	afterGraph, _ := manager.BrowserGraph(ctx)
	if afterGraph.GraphRevision == failedGraph.GraphRevision || afterGraph.GraphRevision == beforeGraph.GraphRevision {
		t.Fatal("restart reused a browser graph revision")
	}
	for _, id := range []string{"provider", "required", "transitive", "optional"} {
		if _, live := manager.runtimes[id]; !live {
			t.Fatal("cohort not recovered", id)
		}
	}
	if len(factory.runtimes["optional"].spec.BoundServices) != 1 || factory.calls != 1 || factory.runtimes["unrelated"] != unrelated {
		t.Fatal("recovery lost optional binding, replayed a write or restarted unrelated code")
	}
}
func TestWorkerMonitoringBackoffExhaustionAndExplicitRetry(t *testing.T) {
	manager, factory, now := monitoringFixture(t)
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	factory.runtimes["provider"].state = workersupervisor.StateFailed
	factory.failStart["provider"] = true
	tickWorkers(t, manager)
	for attempt, delay := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second} {
		watch := manager.monitoring.watches["provider"]
		if watch.failures != attempt+1 || watch.retryAt.Sub(*now) != delay {
			t.Fatal("wrong backoff", *watch)
		}
		before := len(factory.log)
		*now = now.Add(delay - time.Nanosecond)
		tickWorkers(t, manager)
		if len(factory.log) != before {
			t.Fatal("restart before deadline")
		}
		*now = now.Add(time.Nanosecond)
		tickWorkers(t, manager)
	}
	watch := manager.monitoring.watches["provider"]
	if watch.failures != 4 || !watch.retryAt.IsZero() {
		t.Fatal("crash-loop budget not exhausted", *watch)
	}
	before := len(factory.log)
	*now = now.Add(time.Hour)
	tickWorkers(t, manager)
	if len(factory.log) != before {
		t.Fatal("exhausted worker kept restarting")
	}
	factory.failStart["provider"] = false
	state, _ := manager.store.state(context.Background(), "provider")
	if _, err := manager.Reload(context.Background(), "provider", state.Revision-1); !errors.Is(err, ErrStaleActivationPlan) {
		t.Fatal("stale retry accepted", err)
	}
	result, err := manager.Reload(context.Background(), "provider", state.Revision)
	if err != nil || result.State.Revision != state.Revision+1 || manager.monitoring.watches["provider"].failures != 0 {
		t.Fatal("explicit reload did not reset exhausted recovery", result, err)
	}
}
func TestWorkerMonitoringStableResetAndDegradedHealth(t *testing.T) {
	manager, factory, now := monitoringFixture(t)
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	factory.runtimes["provider"].state = workersupervisor.StateFailed
	tickWorkers(t, manager)
	*now = now.Add(time.Second)
	tickWorkers(t, manager)
	factory.runtimes["provider"].health = "degraded"
	*now = now.Add(6 * time.Minute)
	before := len(factory.log)
	tickWorkers(t, manager)
	watch := manager.monitoring.watches["provider"]
	if watch.failures != 1 || !watch.readySince.IsZero() || len(factory.log) != before {
		t.Fatal("degraded health caused restart or stability reset", *watch)
	}
	factory.runtimes["provider"].health = "ok"
	*now = now.Add(time.Second)
	tickWorkers(t, manager)
	*now = now.Add(5 * time.Minute)
	tickWorkers(t, manager)
	factory.runtimes["provider"].state = workersupervisor.StateFailed
	tickWorkers(t, manager)
	if manager.monitoring.watches["provider"].failures != 1 {
		t.Fatal("healthy stability did not restore the retry budget")
	}
}
func TestWorkerMonitoringHealthDeadlineAndDisableCancelRetry(t *testing.T) {
	manager, factory, now := monitoringFixture(t)
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	factory.runtimes["provider"].hang = true
	*now = now.Add(time.Second)
	tickWorkers(t, manager)
	if watch := manager.monitoring.watches["provider"]; watch == nil || !watch.blocked || !strings.Contains(watch.message, "HEALTH_FAILED") {
		t.Fatal("hung health did not withdraw worker", watch)
	}
	review, err := manager.PrepareDisable(context.Background(), "provider")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DisableReviewed(context.Background(), "provider", review.ReviewSHA256); err != nil {
		t.Fatal(err)
	}
	before := len(factory.log)
	*now = now.Add(time.Hour)
	tickWorkers(t, manager)
	if len(factory.log) != before || manager.monitoring.watches["provider"] != nil {
		t.Fatal("disabled worker resurrected")
	}
}
func TestWorkerMonitoringStartupFailureAndGenerationReplacement(t *testing.T) {
	manager, factory, now := monitoringFixture(t)
	old := installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	factory.failStart["provider"] = true
	results, err := manager.Recover(context.Background())
	if err != nil || len(results) != 1 || results[0].Recovered || manager.monitoring.watches["provider"].failures != 1 {
		t.Fatal("startup failure not scheduled", results, err)
	}
	review, err := manager.PrepareDisable(context.Background(), "provider")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DisableReviewed(context.Background(), "provider", review.ReviewSHA256); err != nil {
		t.Fatal(err)
	}
	factory.failStart["provider"] = false
	replacement := installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "2.0.0", Worker: true})
	if replacement.GenerationID == old.GenerationID {
		t.Fatal("fixture did not replace generation")
	}
	*now = now.Add(time.Hour)
	tickWorkers(t, manager)
	if manager.monitoring.watches["provider"].generation != replacement.GenerationID || manager.monitoring.watches["provider"].failures != 0 {
		t.Fatal("old generation retry state leaked")
	}
}

func TestWorkerMonitoringExplicitRetrySurvivesBrowserDisconnect(t *testing.T) {
	manager, factory, _ := monitoringFixture(t)
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true, Contract: "example.rules", ContractVersion: "3.0.0"})
	installUninstallFixture(t, manager, packageSpec{ID: "optional", Version: "1.0.0", Worker: true, ConsumeContract: "example.rules", OptionalConsume: true})
	factory.runtimes["provider"].state = workersupervisor.StateFailed
	tickWorkers(t, manager)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	factory.runtimes["optional"].onShutdown = cancel
	state, _ := manager.store.state(ctx, "provider")
	result, err := manager.Reload(ctx, "provider", state.Revision)
	if err != nil || ctx.Err() == nil || result.State.ActiveGenerationID != state.ActiveGenerationID {
		t.Fatal("accepted recovery was stranded by a browser disconnect", result, err)
	}
	if _, live := manager.runtimes["provider"]; !live {
		t.Fatal("provider not recovered after disconnect")
	}
	if len(factory.runtimes["optional"].spec.BoundServices) != 1 {
		t.Fatal("consumer not reconnected")
	}
}

func TestWorkerMonitoringTransitionDeadlineConsumesRetryBudget(t *testing.T) {
	manager, factory, now := monitoringFixture(t)
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	factory.runtimes["provider"].state = workersupervisor.StateFailed
	tickWorkers(t, manager)
	factory.waitStart = true
	manager.monitoring.config.TransitionTimeout = 20 * time.Millisecond
	*now = now.Add(time.Second)
	_ = manager.checkWorkers(context.Background())
	watch := manager.monitoring.watches["provider"]
	if watch.failures != 2 || watch.retryAt.Sub(*now) != 2*time.Second {
		t.Fatal("timed-out transition escaped the restart budget", *watch)
	}
}

func TestWorkerMonitoringBoundsFailedPackageReinspection(t *testing.T) {
	manager, factory, now := monitoringFixture(t)
	generation := installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	factory.runtimes["provider"].state = workersupervisor.StateFailed
	tickWorkers(t, manager)
	archive := filepath.Join(manager.directory, "provider", "generations", generation.GenerationID, "package.zip")
	if err := os.WriteFile(archive, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, delay := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second} {
		*now = now.Add(delay)
		tickWorkers(t, manager)
	}
	watch := manager.monitoring.watches["provider"]
	if watch.failures != 4 || !watch.retryAt.IsZero() {
		t.Fatal("failed reinspection escaped the restart budget", *watch)
	}
	before := len(factory.log)
	*now = now.Add(time.Hour)
	tickWorkers(t, manager)
	if len(factory.log) != before {
		t.Fatal("corrupt package triggered endless recovery")
	}
}

func TestWorkerMonitoringShutdownCancelsInFlightHealth(t *testing.T) {
	manager, factory, _ := monitoringFixture(t)
	manager.store.now = time.Now
	manager.monitoring.config.PollInterval = time.Millisecond
	manager.monitoring.config.HealthInterval = time.Millisecond
	manager.monitoring.config.HealthTimeout = 10 * time.Second
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	entered := make(chan struct{}, 1)
	factory.runtimes["provider"].hang, factory.runtimes["provider"].entered = true, entered
	manager.StartMonitoring(context.Background())
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("production monitor did not call health")
	}
	done := make(chan error, 1)
	go func() { done <- manager.Shutdown(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel the health request")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.runtimes) != 0 || manager.monitorCancel != nil {
		t.Fatal("shutdown left a runtime or monitor")
	}
}
