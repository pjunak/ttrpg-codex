package packagemanager

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type nativeMonitorFactory struct {
	executable    string
	directory     string
	firstMode     string
	retryMode     string
	started       string
	release       string
	concurrent    int
	healthTimeout time.Duration
	instances     []*workersupervisor.Supervisor
}

func (factory *nativeMonitorFactory) New(spec RuntimeSpec) (Runtime, error) {
	mode := "healthy"
	if len(factory.instances) == 0 {
		mode = factory.firstMode
	} else if factory.retryMode != "" {
		mode = factory.retryMode
	}
	environment := map[string]string{"CODEX_MONITOR_WORKER_TEST": mode}
	if factory.started != "" {
		environment["CODEX_MONITOR_WORKER_STARTED"] = factory.started
		environment["CODEX_MONITOR_WORKER_RELEASE"] = factory.release
	}
	healthTimeout := factory.healthTimeout
	if healthTimeout == 0 {
		healthTimeout = time.Second
	}
	runtime, err := workersupervisor.New(workersupervisor.Config{
		Identity: spec.Identity, Host: workersupervisor.HostInfo{Version: "2.0.0", Locale: "en", TimeZone: "UTC"},
		ProtocolVersion: "1.0.0", Executable: factory.executable, WorkingDirectory: factory.directory,
		Arguments:      []string{"-test.run=^TestMonitoredNativeWorkerProcess$"},
		Environment:    environment,
		Limits:         workersupervisor.WorkerLimits{MaxConcurrentRequests: factory.concurrent},
		StartupTimeout: 5 * time.Second, HealthTimeout: healthTimeout, ShutdownTimeout: 3 * time.Second,
		Logger: slog.New(slog.DiscardHandler),
	})
	if err == nil {
		factory.instances = append(factory.instances, runtime)
	}
	return runtime, err
}
func TestWorkerMonitoringWithNativeCrashAndHealthHang(t *testing.T) {
	for _, mode := range []string{"crash", "hang"} {
		t.Run(mode, func(t *testing.T) {
			manager, _, now := monitoringFixture(t)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			factory := &nativeMonitorFactory{executable: executable, directory: t.TempDir(), firstMode: mode}
			manager.runtimeFactory = factory
			manager.monitoring.config.HealthTimeout = 100 * time.Millisecond
			installUninstallFixture(t, manager, packageSpec{ID: "native-worker", Version: "1.0.0", Worker: true})
			first := factory.instances[0]
			if mode == "crash" {
				waitCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := first.Wait(waitCtx); err == nil || waitCtx.Err() != nil {
					t.Fatal("fixture did not crash", err)
				}
			} else {
				*now = now.Add(time.Second)
			}
			tickWorkers(t, manager)
			if snapshot := first.Snapshot(); snapshot.State != workersupervisor.StateFailed || snapshot.ExitedAt == nil {
				t.Fatal("failed native worker was not reaped", snapshot)
			}
			*now = now.Add(time.Second)
			tickWorkers(t, manager)
			if len(factory.instances) != 2 || factory.instances[1].Snapshot().State != workersupervisor.StateReady {
				t.Fatal("native worker was not restarted")
			}
			if factory.instances[1].Snapshot().PID == first.Snapshot().PID {
				t.Fatal("restart reused failed process")
			}
			if err := manager.Shutdown(context.Background()); err != nil {
				t.Fatal(err)
			}
			if factory.instances[1].Snapshot().State != workersupervisor.StateStopped {
				t.Fatal("replacement worker survived shutdown")
			}
		})
	}
}

func TestWorkerMonitoringNativeHealthLeavesBrowserAccessOpen(t *testing.T) {
	manager, _, now := monitoringFixture(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	factory := &nativeMonitorFactory{executable: executable, directory: directory, firstMode: "held-health",
		started: filepath.Join(directory, "health-started"), release: filepath.Join(directory, "health-release"),
		healthTimeout: 10 * time.Second}
	manager.runtimeFactory = factory
	manager.monitoring.config.HealthTimeout = 10 * time.Second
	installUninstallFixture(t, manager, packageSpec{ID: "native-worker", Version: "1.0.0", Worker: true})
	*now = now.Add(time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	done, joined := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(joined)
		done <- manager.checkWorkers(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-joined:
		case <-time.After(3 * time.Second):
			t.Error("native health did not stop")
		}
	})
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(factory.started); err == nil {
			break
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("native health probe did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	awaitMonitorOperation(t, func() error {
		if _, err := manager.BrowserGraph(ctx); err != nil {
			return err
		}
		_, err := manager.Snapshot(ctx, "native-worker", 20)
		return err
	})
	select {
	case err := <-done:
		t.Fatalf("native probe ended before release: %v", err)
	default:
	}
	if err := os.WriteFile(factory.release, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if factory.instances[0].Snapshot().State != workersupervisor.StateReady || manager.monitoring.watches["native-worker"].failures != 0 {
		t.Fatal("successful native health check caused a recovery")
	}
}

func TestWorkerMonitoringKeepsHealthyWorkerDuringDomainSaturation(t *testing.T) {
	manager, _, now := monitoringFixture(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	factory := &nativeMonitorFactory{
		executable: executable,
		directory:  directory,
		firstMode:  "saturated",
		started:    filepath.Join(directory, "started"),
		release:    filepath.Join(directory, "release"),
		concurrent: 1,
	}
	manager.runtimeFactory = factory
	manager.monitoring.config.HealthTimeout = time.Second
	installUninstallFixture(t, manager, packageSpec{ID: "native-worker", Version: "1.0.0", Worker: true})
	first := factory.instances[0]
	callDone := make(chan error, 1)
	callCtx, cancelCall := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelCall()
	go func() {
		_, callErr := first.Call(callCtx, "fixture/block", map[string]any{}, &workerrpc.Meta{
			RequestID: "saturated-request", CorrelationID: "saturated-correlation",
			Generation: first.Snapshot().Identity.Generation, Deadline: time.Now().Add(5 * time.Second),
		})
		callDone <- callErr
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(factory.started); err == nil {
			break
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("blocking domain call did not reach native worker")
		}
		time.Sleep(10 * time.Millisecond)
	}
	*now = now.Add(time.Second)
	tickWorkers(t, manager)
	if snapshot := first.Snapshot(); snapshot.State != workersupervisor.StateReady {
		t.Fatalf("ordinary request saturation failed a healthy worker: %+v", snapshot)
	}
	if len(factory.instances) != 1 {
		t.Fatalf("ordinary request saturation restarted a healthy worker: %d instances", len(factory.instances))
	}
	if err := os.WriteFile(factory.release, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-callDone; err != nil {
		t.Fatal(err)
	}
}

func TestWorkerMonitoringRetainsNativeTransportFailure(t *testing.T) {
	manager, _, now := monitoringFixture(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	factory := &nativeMonitorFactory{executable: executable, directory: t.TempDir(), firstMode: "transport"}
	manager.runtimeFactory = factory
	installUninstallFixture(t, manager, packageSpec{ID: "native-worker", Version: "1.0.0", Worker: true})
	first := factory.instances[0]
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, callErr := first.Call(ctx, "fixture/break", map[string]any{}, &workerrpc.Meta{
		RequestID: "broken-request", CorrelationID: "broken-correlation",
		Generation: first.Snapshot().Identity.Generation, Deadline: time.Now().Add(5 * time.Second),
	})
	if callErr == nil || ctx.Err() != nil {
		t.Fatal("malformed frame did not fail the native transport", callErr)
	}
	if err := first.Wait(ctx); err == nil || ctx.Err() != nil {
		t.Fatal("failed native worker was not reaped", err)
	}
	if snapshot := first.Snapshot(); workersupervisor.SafeFailureCode(snapshot.LastError) != workersupervisor.CodeTransportFailed {
		t.Fatalf("supervisor lost transport cause: %+v", snapshot)
	}
	tickWorkers(t, manager)
	snapshot, err := manager.Snapshot(context.Background(), "native-worker", 20)
	if err != nil || snapshot.Runtime == nil {
		t.Fatal("missing failure snapshot", err)
	}
	if !strings.HasPrefix(snapshot.Runtime.LastError, workersupervisor.CodeTransportFailed+":") {
		t.Fatalf("monitor replaced the transport cause: %+v", snapshot.Runtime)
	}
	if strings.Contains(snapshot.Runtime.LastError, "not-a-number") || snapshot.Runtime.StderrTail != "" {
		t.Fatal("monitor exposed raw transport data", snapshot.Runtime)
	}
	*now = now.Add(time.Second)
	tickWorkers(t, manager)
	if len(factory.instances) != 2 || factory.instances[1].Snapshot().State != workersupervisor.StateReady {
		t.Fatal("diagnostics changed automatic recovery")
	}
}

func TestWorkerMonitoringRetainsFailedNativeStartup(t *testing.T) {
	for _, fixture := range []struct {
		name, mode, code string
		retry            bool
	}{
		{"boot-health", "startup-health", workersupervisor.CodeHealthFailed, false},
		{"retry-health", "startup-health", workersupervisor.CodeHealthFailed, true},
		{"retry-timeout", "startup-hang", workersupervisor.CodeStartupTimed, true},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			ctx := context.Background()
			manager, _, now := monitoringFixture(t)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			factory := &nativeMonitorFactory{executable: executable, directory: t.TempDir(), firstMode: "healthy", retryMode: fixture.mode}
			if fixture.retry {
				factory.firstMode = "crash"
			}
			manager.runtimeFactory = factory
			installUninstallFixture(t, manager, packageSpec{ID: "native-worker", Version: "1.0.0", Worker: true})
			first := factory.instances[0]
			failures := 1
			if fixture.retry {
				waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				defer cancel()
				if err := first.Wait(waitCtx); err == nil || waitCtx.Err() != nil {
					t.Fatal("fixture did not crash", err)
				}
				tickWorkers(t, manager)
				*now = now.Add(time.Second)
				tickWorkers(t, manager)
				failures = 2
			} else {
				if err := manager.Shutdown(ctx); err != nil {
					t.Fatal(err)
				}
				results, err := manager.Recover(ctx)
				if err != nil || len(results) != 1 || results[0].Recovered {
					t.Fatal("fixture did not fail startup", results, err)
				}
			}
			if len(factory.instances) != 2 {
				t.Fatalf("expected one recovery attempt, got %d instances", len(factory.instances))
			}
			failed := factory.instances[1].Snapshot()
			if failed.PID == first.Snapshot().PID || failed.PID == 0 || failed.ExitedAt == nil || failed.ExitCode == nil ||
				workersupervisor.SafeFailureCode(failed.LastError) != fixture.code || !strings.Contains(failed.StderrTail, "private-startup-diagnostic") {
				t.Fatalf("failed process fixture is incomplete: %+v", failed)
			}
			snapshot, err := manager.Snapshot(ctx, "native-worker", 20)
			if err != nil || snapshot.Runtime == nil {
				t.Fatal("missing failure snapshot", err)
			}
			if snapshot.Runtime.PID != failed.PID {
				t.Errorf("failed startup retained an earlier process: got PID %d, want %d", snapshot.Runtime.PID, failed.PID)
			}
			if !strings.HasPrefix(snapshot.Runtime.LastError, fixture.code+":") {
				t.Errorf("failed startup lost its category: %q", snapshot.Runtime.LastError)
			}
			expected := workersupervisor.AdministrativeSnapshot(failed)
			expected.LastError = snapshot.Runtime.LastError
			if !reflect.DeepEqual(*snapshot.Runtime, expected) {
				t.Errorf("failed startup lost its sanitized process evidence: got %+v, want %+v", snapshot.Runtime, expected)
			}
			watch := manager.monitoring.watches["native-worker"]
			if watch.failures != failures || watch.retryAt.Sub(*now) != time.Duration(failures)*time.Second {
				t.Fatalf("failed startup changed recovery accounting: %+v", watch)
			}
			tickWorkers(t, manager)
			if len(factory.instances) != 2 {
				t.Fatal("failed startup bypassed backoff")
			}
			factory.retryMode = "healthy"
			*now = watch.retryAt
			tickWorkers(t, manager)
			if len(factory.instances) != 3 || factory.instances[2].Snapshot().State != workersupervisor.StateReady {
				t.Fatal("failed startup diagnostics prevented the next recovery")
			}
		})
	}
}

func TestMonitoredNativeWorkerProcess(t *testing.T) {
	mode := os.Getenv("CODEX_MONITOR_WORKER_TEST")
	if mode == "" {
		return
	}
	checks := 0
	err := workerrpc.RunNativeWorker(context.Background(), workerrpc.NativeWorkerConfig{
		Reader: os.Stdin, Writer: os.Stdout,
		HandlerFactory: workerrpc.NativeWorkerHandlerFactoryFunc(func(workerrpc.NativeWorkerContext) (workerrpc.RequestHandler, error) {
			return workerrpc.RequestHandlerFunc(func(ctx context.Context, request workerrpc.Request) (any, error) {
				if mode == "transport" && request.Method == "fixture/break" {
					_, _ = fmt.Fprint(os.Stdout, "Content-Length: not-a-number\r\n\r\n")
					<-ctx.Done()
					return nil, ctx.Err()
				}
				if mode != "saturated" || request.Method != "fixture/block" {
					return nil, nil
				}
				started, release := os.Getenv("CODEX_MONITOR_WORKER_STARTED"), os.Getenv("CODEX_MONITOR_WORKER_RELEASE")
				if err := os.WriteFile(started, []byte("started"), 0o600); err != nil {
					return nil, err
				}
				for {
					if _, err := os.Stat(release); err == nil {
						return map[string]any{}, nil
					} else if !os.IsNotExist(err) {
						return nil, err
					}
					select {
					case <-ctx.Done():
						return nil, ctx.Err()
					case <-time.After(10 * time.Millisecond):
					}
				}
			}), nil
		}),
		Health: func(ctx context.Context) (workerrpc.NativeWorkerHealth, error) {
			checks++
			if checks > 1 && mode == "held-health" {
				if err := os.WriteFile(os.Getenv("CODEX_MONITOR_WORKER_STARTED"), []byte("started"), 0o600); err != nil {
					return workerrpc.NativeWorkerHealth{}, err
				}
				for {
					if _, err := os.Stat(os.Getenv("CODEX_MONITOR_WORKER_RELEASE")); err == nil {
						break
					} else if !os.IsNotExist(err) {
						return workerrpc.NativeWorkerHealth{}, err
					}
					select {
					case <-ctx.Done():
						return workerrpc.NativeWorkerHealth{}, ctx.Err()
					case <-time.After(10 * time.Millisecond):
					}
				}
			}
			if checks == 1 && (mode == "startup-health" || mode == "startup-hang") {
				_, _ = fmt.Fprintln(os.Stderr, "private-startup-diagnostic")
				if mode == "startup-hang" {
					select {
					case <-ctx.Done():
						return workerrpc.NativeWorkerHealth{}, ctx.Err()
					case <-time.After(time.Minute):
						return workerrpc.NativeWorkerHealth{}, context.DeadlineExceeded
					}
				}
				return workerrpc.NativeWorkerHealth{Status: "degraded"}, nil
			}
			if checks == 1 && mode == "crash" {
				go func() { time.Sleep(250 * time.Millisecond); os.Exit(17) }()
			}
			if checks > 1 && mode == "hang" {
				<-ctx.Done()
				return workerrpc.NativeWorkerHealth{}, ctx.Err()
			}
			return workerrpc.NativeWorkerHealth{Status: "ok"}, nil
		},
	})
	if err != nil {
		os.Exit(3)
	}
	os.Exit(0)
}
