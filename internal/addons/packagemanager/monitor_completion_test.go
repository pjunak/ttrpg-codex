package packagemanager

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
)

type completingHealthFactory struct {
	*monitoredFactory
	probe func(context.Context) (workersupervisor.Health, error)
}

func (factory *completingHealthFactory) New(spec RuntimeSpec) (Runtime, error) {
	runtime, err := factory.monitoredFactory.New(spec)
	if err != nil {
		return nil, err
	}
	return &completingHealthRuntime{Runtime: runtime, probe: factory.probe}, nil
}

type completingHealthRuntime struct {
	Runtime
	probe func(context.Context) (workersupervisor.Health, error)
}

func (runtime *completingHealthRuntime) Health(ctx context.Context) (workersupervisor.Health, error) {
	return runtime.probe(ctx)
}

func TestWorkerMonitoringRejectsExpiredHealthyCompletion(t *testing.T) {
	for _, status := range []string{"ok", "degraded"} {
		for _, late := range []bool{false, true} {
			name := status + "/timely"
			if late {
				name = status + "/expired"
			}
			t.Run(name, func(t *testing.T) {
				ctx := context.Background()
				factory := &completingHealthFactory{
					monitoredFactory: &monitoredFactory{runtimes: map[string]*monitoredRuntime{}, failStart: map[string]bool{}},
					probe: func(probeCtx context.Context) (workersupervisor.Health, error) {
						if late {
							<-probeCtx.Done()
							if !errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
								t.Errorf("probe did not reach its own deadline: %v", probeCtx.Err())
							}
						}
						return workersupervisor.Health{Status: status}, nil
					},
				}
				manager, broker := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), factory)
				t.Cleanup(func() { _ = manager.Shutdown(context.Background()) })
				now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
				manager.store.now = func() time.Time { return now }
				var err error
				manager.monitoring, err = newWorkerMonitor(&MonitoringConfig{
					HealthInterval: time.Second, HealthTimeout: 20 * time.Millisecond,
				})
				if err != nil {
					t.Fatal(err)
				}
				generation := installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0",
					Worker: true, Contract: "example.rules", ContractVersion: "3.0.0"})
				before, err := manager.store.state(ctx, "provider")
				if err != nil {
					t.Fatal(err)
				}
				now = now.Add(time.Second)
				tickWorkers(t, manager)
				watch := manager.monitoring.watches["provider"]
				if watch == nil || watch.observation != nil {
					t.Fatal("health observation was not released")
				}
				_, live := manager.runtimes["provider"]
				if late {
					if live || !watch.blocked || watch.failures != 1 || watch.retryAt.Sub(now) != time.Second ||
						!strings.HasPrefix(watch.message, workersupervisor.CodeHealthFailed+":") {
						t.Errorf("expired %s probe remained available or skipped backoff: live=%v watch=%+v", status, live, *watch)
					}
				} else if !live || watch.blocked || watch.failures != 0 || !watch.retryAt.IsZero() ||
					(status == "degraded" && !watch.readySince.IsZero()) {
					t.Errorf("timely %s probe was not retained: live=%v watch=%+v", status, live, *watch)
				}
				after, err := manager.store.state(ctx, "provider")
				if err != nil || after.ActiveGenerationID != generation.GenerationID || after.Revision != before.Revision {
					t.Fatalf("health completion changed durable selection: %+v, %v", after, err)
				}
				providers, err := broker.ListProviders(ctx, "example.rules")
				if err != nil || len(providers) != 1 || (providers[0].ActiveGeneration != "") != live {
					t.Fatalf("service availability disagrees with health completion: %+v, %v", providers, err)
				}
			})
		}
	}
}

func TestWorkerMonitoringRetainsNativeHealthTransportFailure(t *testing.T) {
	manager, _, now := monitoringFixture(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	factory := &nativeMonitorFactory{executable: executable, directory: t.TempDir(), firstMode: "health-transport"}
	manager.runtimeFactory = factory
	manager.monitoring.config.HealthTimeout = time.Second
	generation := installUninstallFixture(t, manager, packageSpec{ID: "native-worker", Version: "1.0.0", Worker: true})
	before, err := manager.store.state(context.Background(), "native-worker")
	if err != nil {
		t.Fatal(err)
	}
	first := factory.instances[0]
	*now = now.Add(time.Second)
	tickWorkers(t, manager)
	if snapshot := first.Snapshot(); snapshot.State != workersupervisor.StateFailed || snapshot.ExitedAt == nil ||
		workersupervisor.SafeFailureCode(snapshot.LastError) != workersupervisor.CodeTransportFailed {
		t.Fatalf("native health exchange did not fail and reap the transport: %+v", snapshot)
	}
	snapshot, err := manager.Snapshot(context.Background(), "native-worker", 20)
	if err != nil || snapshot.Runtime == nil {
		t.Fatal("missing native health failure snapshot", err)
	}
	if !strings.HasPrefix(snapshot.Runtime.LastError, workersupervisor.CodeTransportFailed+":") ||
		strings.Contains(snapshot.Runtime.LastError, "not-a-number") || snapshot.Runtime.StderrTail != "" {
		t.Errorf("monitor changed the native health transport cause or exposed raw data: %+v", snapshot.Runtime)
	}
	watch := manager.monitoring.watches["native-worker"]
	if watch == nil || watch.failures != 1 || !watch.blocked || watch.retryAt.Sub(*now) != time.Second {
		t.Fatalf("native health failure did not retain bounded backoff: %+v", watch)
	}
	after, err := manager.store.state(context.Background(), "native-worker")
	if err != nil || after.ActiveGenerationID != generation.GenerationID || after.Revision != before.Revision {
		t.Fatalf("native health failure changed durable selection: %+v, %v", after, err)
	}
	*now = now.Add(time.Second)
	tickWorkers(t, manager)
	if len(factory.instances) != 2 || factory.instances[1].Snapshot().State != workersupervisor.StateReady ||
		factory.instances[1].Snapshot().PID == first.Snapshot().PID {
		t.Fatal("native health failure did not recover a fresh worker")
	}
}
