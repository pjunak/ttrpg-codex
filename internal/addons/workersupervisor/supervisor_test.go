package workersupervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

const helperProcessEnvironment = "CODEX_TEST_NATIVE_WORKER"

func TestSupervisorRunsReviewedLifecycle(t *testing.T) {
	t.Parallel()

	supervisor := newTestSupervisor(t, "healthy", nil)
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	snapshot := supervisor.Snapshot()
	if snapshot.State != StateReady || snapshot.PID == 0 || snapshot.Negotiated == nil {
		t.Fatalf("incomplete ready snapshot: %+v", snapshot)
	}
	if snapshot.Negotiated.ProtocolVersion != "1.0.0" || !snapshot.Negotiated.HealthCheck {
		t.Fatalf("negotiation = %+v", snapshot.Negotiated)
	}
	snapshot.Negotiated.Capabilities[0] = "changed"
	snapshot.Negotiated.Methods["codex/health"] = "changed"
	immutable := supervisor.Snapshot().Negotiated
	if immutable.Capabilities[0] == "changed" || immutable.Methods["codex/health"] == "changed" {
		t.Fatal("snapshot exposed live negotiated state")
	}
	wantStates := []State{StateSpawning, StateInitializing, StateStarting, StateChecking, StateReady}
	if len(snapshot.Transitions) != len(wantStates) {
		t.Fatalf("transitions = %+v", snapshot.Transitions)
	}
	for index, want := range wantStates {
		if snapshot.Transitions[index].To != want {
			t.Fatalf("transition %d = %s, want %s", index, snapshot.Transitions[index].To, want)
		}
	}
	health, err := supervisor.Health(context.Background())
	if err != nil || health.Status != "ok" {
		t.Fatalf("health = %+v, %v", health, err)
	}
	if err := supervisor.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if snapshot := supervisor.Snapshot(); snapshot.State != StateStopped || snapshot.ExitedAt == nil {
		t.Fatalf("stopped snapshot: %+v", snapshot)
	}
}

func TestSupervisorFailsClosedDuringStartup(t *testing.T) {
	t.Parallel()

	tests := []struct {
		mode string
		code string
	}{
		{"malformed", CodeStartupFailed},
		{"wrong-protocol", CodeStartupFailed},
		{"missing-health-method", CodeStartupFailed},
		{"reject-start", CodeStartupFailed},
		{"unhealthy", CodeHealthFailed},
	}
	for _, test := range tests {
		test := test
		t.Run(test.mode, func(t *testing.T) {
			t.Parallel()
			supervisor := newTestSupervisor(t, test.mode, nil)
			err := supervisor.Start(context.Background())
			assertLifecycleCode(t, err, test.code)
			snapshot := supervisor.Snapshot()
			if snapshot.State != StateFailed || snapshot.ExitedAt == nil || snapshot.LastError == "" {
				t.Fatalf("failure snapshot: %+v", snapshot)
			}
		})
	}
}

func TestSupervisorFailsClosedWhenSpawnFails(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "not-an-executable")
	if err := os.WriteFile(path, []byte("not a native executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	supervisor := newTestSupervisor(t, "healthy", func(config *Config) {
		config.Executable = path
	})
	assertLifecycleCode(t, supervisor.Start(context.Background()), CodeSpawnFailed)
	snapshot := supervisor.Snapshot()
	if snapshot.State != StateFailed || snapshot.LastError == "" || snapshot.ExitedAt != nil {
		t.Fatalf("spawn failure snapshot: %+v", snapshot)
	}
	if err := supervisor.Shutdown(context.Background()); err != nil {
		t.Fatalf("failed-generation shutdown: %v", err)
	}
}

func TestSupervisorBoundsStartupAndShutdown(t *testing.T) {
	t.Parallel()

	t.Run("startup timeout", func(t *testing.T) {
		t.Parallel()
		supervisor := newTestSupervisor(t, "hang-initialize", func(config *Config) {
			config.StartupTimeout = 250 * time.Millisecond
		})
		started := time.Now()
		err := supervisor.Start(context.Background())
		assertLifecycleCode(t, err, CodeStartupTimed)
		if elapsed := time.Since(started); elapsed > 3*time.Second {
			t.Fatalf("startup timeout took %s", elapsed)
		}
		if snapshot := supervisor.Snapshot(); snapshot.State != StateFailed || snapshot.ExitedAt == nil {
			t.Fatalf("timeout snapshot: %+v", snapshot)
		}
	})

	t.Run("shutdown timeout", func(t *testing.T) {
		t.Parallel()
		supervisor := newTestSupervisor(t, "ignore-shutdown", func(config *Config) {
			config.ShutdownTimeout = 250 * time.Millisecond
		})
		if err := supervisor.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		err := supervisor.Shutdown(context.Background())
		assertLifecycleCode(t, err, CodeShutdownFailed)
		if snapshot := supervisor.Snapshot(); snapshot.State != StateFailed || snapshot.ExitedAt == nil {
			t.Fatalf("forced-stop snapshot: %+v", snapshot)
		}
	})

	t.Run("shutdown rejected", func(t *testing.T) {
		t.Parallel()
		supervisor := newTestSupervisor(t, "reject-shutdown", nil)
		if err := supervisor.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		err := supervisor.Shutdown(context.Background())
		assertLifecycleCode(t, err, CodeShutdownFailed)
		if snapshot := supervisor.Snapshot(); snapshot.State != StateFailed || snapshot.ExitedAt == nil {
			t.Fatalf("rejected-shutdown snapshot: %+v", snapshot)
		}
	})
}

func TestSupervisorRuntimeHealthContract(t *testing.T) {
	t.Parallel()

	t.Run("degraded is reportable", func(t *testing.T) {
		t.Parallel()
		supervisor := newTestSupervisor(t, "degraded-runtime", nil)
		if err := supervisor.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		health, err := supervisor.Health(context.Background())
		if err != nil || health.Status != "degraded" {
			t.Fatalf("Health = %+v, %v", health, err)
		}
		if supervisor.State() != StateReady {
			t.Fatalf("state = %s, want %s", supervisor.State(), StateReady)
		}
		if err := supervisor.Shutdown(context.Background()); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("invalid status fails closed", func(t *testing.T) {
		t.Parallel()
		supervisor := newTestSupervisor(t, "invalid-runtime-health", nil)
		if err := supervisor.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		_, err := supervisor.Health(context.Background())
		assertLifecycleCode(t, err, CodeHealthFailed)
		if snapshot := supervisor.Snapshot(); snapshot.State != StateFailed || snapshot.ExitedAt == nil {
			t.Fatalf("invalid-health snapshot: %+v", snapshot)
		}
	})
}

func TestSupervisorSerializesControlOperationsWithContext(t *testing.T) {
	t.Parallel()

	supervisor := newTestSupervisor(t, "hang-runtime-health", func(config *Config) {
		config.HealthTimeout = 250 * time.Millisecond
	})
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	healthResult := make(chan error, 1)
	go func() {
		_, err := supervisor.Health(context.Background())
		healthResult <- err
	}()
	deadline := time.Now().Add(time.Second)
	for len(supervisor.operation) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(supervisor.operation) != 0 {
		t.Fatal("health did not acquire the control operation")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := supervisor.Shutdown(shutdownCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown error = %v, want context deadline", err)
	}
	assertLifecycleCode(t, <-healthResult, CodeHealthFailed)
}

func TestSupervisorRecordsUnexpectedExit(t *testing.T) {
	t.Parallel()

	supervisor := newTestSupervisor(t, "exit-after-ready", nil)
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	assertLifecycleCode(t, supervisor.Wait(waitCtx), CodeProcessExited)
	snapshot := supervisor.Snapshot()
	if snapshot.State != StateFailed || snapshot.ExitError == "" || !strings.Contains(snapshot.LastError, CodeProcessExited) {
		t.Fatalf("unexpected-exit snapshot: %+v", snapshot)
	}
}

func TestSupervisorWaitBeforeStartIsInvalid(t *testing.T) {
	t.Parallel()

	supervisor := newTestSupervisor(t, "healthy", nil)
	assertLifecycleCode(t, supervisor.Wait(context.Background()), CodeInvalidState)
}

func TestSupervisorBoundsStderrDiagnostics(t *testing.T) {
	t.Parallel()

	supervisor := newTestSupervisor(t, "stderr", func(config *Config) {
		config.MaxStderrBytes = 32
	})
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	tail := supervisor.Snapshot().StderrTail
	if len(tail) > 32 || !strings.HasSuffix(tail, "END\n") {
		t.Fatalf("stderr tail = %q (%d bytes)", tail, len(tail))
	}
	if err := supervisor.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorDoesNotInheritParentEnvironment(t *testing.T) {
	t.Setenv("CODEX_PARENT_SECRET_TEST", "must-not-leak")

	supervisor := newTestSupervisor(t, "check-environment", nil)
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func newTestSupervisor(t *testing.T, mode string, mutate func(*Config)) *Supervisor {
	t.Helper()
	config := validTestConfig(t, mode)
	if mutate != nil {
		mutate(&config)
	}
	supervisor, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	return supervisor
}

func validTestConfig(t *testing.T, mode string) Config {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Config{
		Identity: Identity{
			AddonID:    "example-addon",
			Version:    "1.0.0",
			Generation: "generation-42",
		},
		Host: HostInfo{
			Version:  "2.0.0-dev",
			Locale:   "en",
			TimeZone: "Europe/Prague",
		},
		ProtocolVersion:  "1.0.0",
		Executable:       executable,
		Arguments:        []string{"-test.run=TestNativeWorkerHelperProcess"},
		WorkingDirectory: t.TempDir(),
		Environment: map[string]string{
			helperProcessEnvironment: "1",
			"CODEX_TEST_WORKER_MODE": mode,
		},
		StartupTimeout:  5 * time.Second,
		HealthTimeout:   2 * time.Second,
		ShutdownTimeout: 2 * time.Second,
		MaxStderrBytes:  4 << 10,
		Logger:          slog.New(slog.DiscardHandler),
	}
}

func assertLifecycleCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("operation succeeded, want %s", want)
	}
	var lifecycle *LifecycleError
	if !errors.As(err, &lifecycle) {
		t.Fatalf("got %T %v, want LifecycleError", err, err)
	}
	if lifecycle.Code != want {
		t.Fatalf("code = %s, want %s: %v", lifecycle.Code, want, err)
	}
}

func TestNativeWorkerHelperProcess(t *testing.T) {
	if os.Getenv(helperProcessEnvironment) != "1" {
		return
	}
	mode := os.Getenv("CODEX_TEST_WORKER_MODE")
	if mode == "check-environment" && os.Getenv("CODEX_PARENT_SECRET_TEST") != "" {
		helperExit("parent environment leaked", 23)
	}
	codec, err := workerrpc.NewCodec(os.Stdin, os.Stdout, workerrpc.DefaultLimits)
	if err != nil {
		helperExit(err.Error(), 2)
	}
	initialize := helperRead(codec, "codex/initialize")
	if mode == "stderr" {
		fmt.Fprint(os.Stderr, strings.Repeat("x", 128)+"END\n")
	}
	switch mode {
	case "hang-initialize":
		time.Sleep(10 * time.Minute)
	case "malformed":
		_, _ = fmt.Fprint(os.Stdout, "Content-Length: nope\r\n\r\n")
		time.Sleep(10 * time.Minute)
	}
	protocolVersion := "1.0.0"
	if mode == "wrong-protocol" {
		protocolVersion = "9.0.0"
	}
	methods := map[string]string{"codex/health": "1.0.0"}
	if mode == "missing-health-method" {
		methods = map[string]string{}
	}
	helperSuccess(codec, initialize, map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    []string{"worker.health"},
		"methods":         methods,
		"healthCheck":     true,
	})

	start := helperRead(codec, "codex/start")
	if mode == "reject-start" {
		helperFailure(codec, start, -32000, "start rejected")
		time.Sleep(10 * time.Minute)
	}
	helperSuccess(codec, start, map[string]any{"ready": true})

	health := helperRead(codec, "codex/health")
	status := "ok"
	if mode == "unhealthy" {
		status = "degraded"
	}
	helperSuccess(codec, health, map[string]any{"status": status})
	if mode == "exit-after-ready" {
		time.Sleep(100 * time.Millisecond)
		os.Exit(17)
	}

	for {
		message, err := codec.Read(context.Background())
		if err != nil {
			helperExit(err.Error(), 3)
		}
		method, _ := message.Value["method"].(string)
		switch method {
		case "codex/health":
			if mode == "hang-runtime-health" {
				time.Sleep(10 * time.Minute)
			}
			status := "ok"
			if mode == "degraded-runtime" {
				status = "degraded"
			} else if mode == "invalid-runtime-health" {
				status = "unknown"
			}
			helperSuccess(codec, message, map[string]any{"status": status})
		case "codex/shutdown":
			if mode == "ignore-shutdown" {
				time.Sleep(10 * time.Minute)
			}
			if mode == "reject-shutdown" {
				helperFailure(codec, message, -32001, "shutdown rejected")
				time.Sleep(10 * time.Minute)
			}
			helperSuccess(codec, message, map[string]any{})
			os.Exit(0)
		default:
			helperFailure(codec, message, -32601, "method not found")
		}
	}
}

func helperRead(codec *workerrpc.Codec, method string) workerrpc.Message {
	message, err := codec.Read(context.Background())
	if err != nil {
		helperExit(err.Error(), 4)
	}
	if message.Kind != workerrpc.KindRequest || message.Value["method"] != method {
		helperExit(fmt.Sprintf("got %v, want %s", message.Value["method"], method), 5)
	}
	return message
}

func helperSuccess(codec *workerrpc.Codec, request workerrpc.Message, result any) {
	if err := codec.Write(context.Background(), map[string]any{
		"jsonrpc": "2.0",
		"id":      request.Value["id"],
		"result":  result,
	}); err != nil {
		helperExit(err.Error(), 6)
	}
}

func helperFailure(codec *workerrpc.Codec, request workerrpc.Message, code int, message string) {
	if err := codec.Write(context.Background(), map[string]any{
		"jsonrpc": "2.0",
		"id":      request.Value["id"],
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	}); err != nil {
		helperExit(err.Error(), 7)
	}
}

func helperExit(message string, code int) {
	_, _ = io.WriteString(os.Stderr, message+"\n")
	os.Exit(code)
}
