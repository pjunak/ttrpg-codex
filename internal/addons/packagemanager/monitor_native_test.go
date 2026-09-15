package packagemanager

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type nativeMonitorFactory struct {
	executable string
	directory  string
	firstMode  string
	instances  []*workersupervisor.Supervisor
}

func (factory *nativeMonitorFactory) New(spec RuntimeSpec) (Runtime, error) {
	mode := "healthy"
	if len(factory.instances) == 0 {
		mode = factory.firstMode
	}
	runtime, err := workersupervisor.New(workersupervisor.Config{
		Identity: spec.Identity, Host: workersupervisor.HostInfo{Version: "2.0.0", Locale: "en", TimeZone: "UTC"},
		ProtocolVersion: "1.0.0", Executable: factory.executable, WorkingDirectory: factory.directory,
		Arguments:      []string{"-test.run=^TestMonitoredNativeWorkerProcess$"},
		Environment:    map[string]string{"CODEX_MONITOR_WORKER_TEST": mode},
		StartupTimeout: 5 * time.Second, HealthTimeout: time.Second, ShutdownTimeout: 3 * time.Second,
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
func TestMonitoredNativeWorkerProcess(t *testing.T) {
	mode := os.Getenv("CODEX_MONITOR_WORKER_TEST")
	if mode == "" {
		return
	}
	checks := 0
	err := workerrpc.RunNativeWorker(context.Background(), workerrpc.NativeWorkerConfig{
		Reader: os.Stdin, Writer: os.Stdout,
		HandlerFactory: workerrpc.NativeWorkerHandlerFactoryFunc(func(workerrpc.NativeWorkerContext) (workerrpc.RequestHandler, error) {
			return workerrpc.RequestHandlerFunc(func(context.Context, workerrpc.Request) (any, error) { return nil, nil }), nil
		}),
		Health: func(ctx context.Context) (workerrpc.NativeWorkerHealth, error) {
			checks++
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
