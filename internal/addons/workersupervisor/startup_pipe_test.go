package workersupervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestSupervisorStartupWritesHonorCancellation(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		name := "inherited deadline"
		if explicit {
			name = "caller cancellation"
		}
		t.Run(name, func(t *testing.T) {
			supervisor := newPipeSupervisor(t, "blocked-initialize-input", func(config *Config) {
				config.Grants = []any{map[string]any{"fixture": strings.Repeat("x", 2<<20)}}
				config.Environment["CODEX_TEST_PIPE_BOOT_DELAY"] = "350ms"
				config.StartupTimeout = 5 * time.Second
			})
			parent, cancel := context.WithCancelCause(context.Background())
			defer cancel(context.Canceled)
			var ctx context.Context = parent
			if !explicit {
				ctx = pipeDeadlineContext{Context: context.Background(), done: parent.Done()}
			}
			result := make(chan error, 1)
			go func() { result <- supervisor.Start(ctx) }()
			waitPipeMarker(t, supervisor, "initialize-input-prefix")
			wantCause := context.DeadlineExceeded
			if explicit {
				wantCause = context.Canceled
			}
			cancel(wantCause)
			select {
			case err := <-result:
				want := CodeStartupTimed
				if explicit {
					want = CodeStartupFailed
				}
				if !errors.Is(err, wantCause) {
					t.Fatalf("startup cancellation lost %v: %v", wantCause, err)
				}
				assertLifecycleCode(t, err, want)
			case <-time.After(time.Second):
				t.Fatal("startup remained blocked writing the initialization frame")
			}
			if snapshot := supervisor.Snapshot(); snapshot.State != StateFailed || snapshot.ExitedAt == nil {
				t.Fatalf("cancelled startup did not reap its process: %+v", snapshot)
			}
		})
	}
}

// Expire the inherited deadline only after the worker confirms blocked OS-pipe
// input. Race-instrumented process startup is setup, not the cancellation trigger.
// TestSupervisorBoundsStartupAndShutdown separately checks the configured timer.
type pipeDeadlineContext struct {
	context.Context
	done <-chan struct{}
}

func (ctx pipeDeadlineContext) Done() <-chan struct{} { return ctx.done }

func (ctx pipeDeadlineContext) Err() error {
	select {
	case <-ctx.done:
		return context.DeadlineExceeded
	default:
		return nil
	}
}

func TestSupervisorStartupDrainHonorsDeadlineAfterExit(t *testing.T) {
	supervisor := newPipeSupervisor(t, "exit-with-inherited-stdout", nil)
	result := make(chan error, 1)
	go func() { result <- supervisor.Start(context.Background()) }()
	select {
	case err := <-result:
		assertLifecycleCode(t, err, CodeStartupFailed)
	case <-time.After(2 * time.Second):
		t.Fatal("startup ignored its deadline draining an exited worker's inherited stdout")
	}
	snapshot := supervisor.Snapshot()
	if snapshot.State != StateFailed || snapshot.ExitCode == nil || *snapshot.ExitCode != 19 || SafeFailureCode(snapshot.LastError) != CodeProcessExited {
		t.Fatalf("startup lost the exited process evidence: %+v", snapshot)
	}
	assertPipeHolderStillOpen(t, supervisor)
}

func TestSupervisorBoundsInheritedStderrCleanup(t *testing.T) {
	for _, test := range []struct {
		mode string
		code string
		exit int
	}{
		{"startup-timeout", CodeStartupTimed, -1},
		{"health-timeout", CodeHealthFailed, -1},
		{"shutdown-timeout", CodeShutdownFailed, -1},
		{"shutdown-exit", CodeShutdownFailed, 0},
		{"unexpected-zero", CodeProcessExited, 0},
		{"unexpected-nonzero", CodeProcessExited, 17},
	} {
		t.Run(test.mode, func(t *testing.T) {
			supervisor := newPipeSupervisor(t, "inherited-stderr-"+test.mode, nil)
			result := make(chan error, 1)
			go func() {
				if err := supervisor.Start(context.Background()); err != nil {
					result <- err
					return
				}
				switch test.mode {
				case "health-timeout":
					_, err := supervisor.Health(context.Background())
					result <- err
				case "shutdown-timeout", "shutdown-exit":
					result <- supervisor.Shutdown(context.Background())
				default:
					_, _ = supervisor.Call(context.Background(), "fixture/exit", map[string]any{}, &workerrpc.Meta{
						RequestID: "pipe-exit", CorrelationID: "pipe-exit", Generation: "generation-42", Deadline: time.Now().Add(time.Second),
					})
					result <- supervisor.Wait(context.Background())
				}
			}()
			select {
			case err := <-result:
				assertLifecycleCode(t, err, test.code)
			case <-time.After(2 * time.Second):
				t.Fatal("inherited stderr kept process completion or termination blocked")
			}
			snapshot := supervisor.Snapshot()
			if snapshot.State != StateFailed || snapshot.ExitedAt == nil || snapshot.ExitCode == nil {
				t.Fatalf("missing actual process exit evidence: %+v", snapshot)
			}
			if test.exit >= 0 && *snapshot.ExitCode != test.exit {
				t.Fatalf("exit code = %d, want %d", *snapshot.ExitCode, test.exit)
			}
			code := *snapshot.ExitCode
			*snapshot.ExitCode = 99
			if actual := supervisor.Snapshot().ExitCode; actual == nil || *actual != code {
				t.Fatal("the process snapshot exposed its live exit code")
			}
			if !strings.Contains(snapshot.StderrTail, "pipe-holder-ready") {
				t.Fatalf("lost bounded stderr before closure: %q", snapshot.StderrTail)
			}
			assertPipeHolderStillOpen(t, supervisor)
		})
	}
}

func newPipeSupervisor(t *testing.T, mode string, mutate func(*Config)) *Supervisor {
	t.Helper()
	supervisor := newTestSupervisor(t, mode, func(config *Config) {
		config.Arguments = []string{"-test.run=^TestSupervisorPipeHelperProcess$"}
		config.Environment["CODEX_TEST_PIPE_PATH"] = config.WorkingDirectory
		config.Environment["GORACE"] = "atexit_sleep_ms=0"
		config.StartupTimeout = 250 * time.Millisecond
		config.HealthTimeout = 100 * time.Millisecond
		config.ShutdownTimeout = 250 * time.Millisecond
		if mutate != nil {
			mutate(config)
		}
	})
	// Release the test-owned descendant before the supervisor's own cleanup.
	// Otherwise the pre-fix failure would also hang the test cleanup itself.
	t.Cleanup(func() {
		body, err := os.ReadFile(filepath.Join(supervisor.config.WorkingDirectory, "holder-ready"))
		if err != nil {
			return
		}
		pid, err := strconv.Atoi(string(body))
		if err != nil {
			t.Error(err)
			return
		}
		process, err := os.FindProcess(pid)
		if err == nil {
			_ = process.Kill()
			_ = process.Release()
		}
	})
	return supervisor
}

func assertPipeHolderStillOpen(t *testing.T, supervisor *Supervisor) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(supervisor.config.WorkingDirectory, "holder-ready")); err != nil {
		t.Fatal("the descendant did not retain the inherited pipe", err)
	}
	if _, err := os.Stat(filepath.Join(supervisor.config.WorkingDirectory, "holder-exited")); !os.IsNotExist(err) {
		t.Fatal("the pipe holder exited before the supervisor settled", err)
	}
	if err := os.WriteFile(filepath.Join(supervisor.config.WorkingDirectory, "holder-probe"), []byte("probe"), 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(filepath.Join(supervisor.config.WorkingDirectory, "holder-alive")); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the descendant did not acknowledge a probe after supervisor completion")
		}
		time.Sleep(time.Millisecond)
	}
}

func waitPipeMarker(t *testing.T, supervisor *Supervisor, marker string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(supervisor.Snapshot().StderrTail, marker) {
		if time.Now().After(deadline) {
			snapshot := supervisor.Snapshot()
			t.Fatalf("native worker did not reach %q: state=%s failure=%s exited=%t", marker, snapshot.State, SafeFailureCode(snapshot.LastError), snapshot.ExitedAt != nil)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSupervisorPipeHelperProcess(t *testing.T) {
	if os.Getenv(helperProcessEnvironment) != "1" {
		return
	}
	mode := os.Getenv("CODEX_TEST_WORKER_MODE")
	directory := os.Getenv("CODEX_TEST_PIPE_PATH")
	if mode == "pipe-holder" {
		fmt.Fprint(os.Stderr, "pipe-holder-ready\n")
		if err := os.WriteFile(filepath.Join(directory, "holder-ready"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
			helperExit(err.Error(), 2)
		}
		deadline := time.Now().Add(time.Minute)
		acknowledged := false
		for time.Now().Before(deadline) {
			if !acknowledged {
				if _, err := os.Stat(filepath.Join(directory, "holder-probe")); err == nil {
					if err := os.WriteFile(filepath.Join(directory, "holder-alive"), []byte("alive"), 0o600); err != nil {
						helperExit(err.Error(), 2)
					}
					acknowledged = true
				}
			}
			time.Sleep(5 * time.Millisecond)
		}
		_ = os.WriteFile(filepath.Join(directory, "holder-exited"), []byte("exited"), 0o600)
		os.Exit(0)
	}
	if mode == "blocked-initialize-input" {
		if delay := os.Getenv("CODEX_TEST_PIPE_BOOT_DELAY"); delay != "" {
			bootDelay, err := time.ParseDuration(delay)
			if err != nil {
				helperExit(err.Error(), 2)
			}
			time.Sleep(bootDelay)
		}
		if _, err := io.ReadFull(os.Stdin, make([]byte, 4)); err != nil {
			helperExit(err.Error(), 2)
		}
		fmt.Fprint(os.Stderr, "initialize-input-prefix\n")
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	executable, err := os.Executable()
	if err != nil {
		helperExit(err.Error(), 2)
	}
	holder := exec.Command(executable, "-test.run=^TestSupervisorPipeHelperProcess$")
	holder.Env = []string{helperProcessEnvironment + "=1", "CODEX_TEST_WORKER_MODE=pipe-holder", "CODEX_TEST_PIPE_PATH=" + directory, "GORACE=atexit_sleep_ms=0"}
	if mode == "exit-with-inherited-stdout" {
		holder.Stdout = os.Stdout
	} else {
		holder.Stderr = os.Stderr
	}
	if err := holder.Start(); err != nil {
		helperExit(err.Error(), 2)
	}
	_ = holder.Process.Release()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(directory, "holder-ready")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			helperExit("pipe holder did not start", 2)
		}
		time.Sleep(time.Millisecond)
	}
	codec, err := workerrpc.NewCodec(os.Stdin, os.Stdout, workerrpc.DefaultLimits)
	if err != nil {
		helperExit(err.Error(), 2)
	}
	initialize := helperRead(codec, "codex/initialize")
	if mode == "exit-with-inherited-stdout" {
		os.Exit(19)
	}
	if mode == "inherited-stderr-startup-timeout" {
		time.Sleep(time.Minute)
	}
	helperSuccess(codec, initialize, map[string]any{"protocolVersion": "1.0.0", "capabilities": []string{}, "methods": map[string]string{"codex/health": "1.0.0"}, "healthCheck": true})
	helperSuccess(codec, helperRead(codec, "codex/start"), map[string]any{"ready": true})
	helperSuccess(codec, helperRead(codec, "codex/health"), map[string]any{"status": "ok"})
	for {
		message, err := codec.Read(context.Background())
		if err != nil {
			helperExit(err.Error(), 3)
		}
		switch message.Value["method"] {
		case "codex/health":
			if mode == "inherited-stderr-health-timeout" {
				time.Sleep(time.Minute)
			}
			helperSuccess(codec, message, map[string]any{"status": "ok"})
		case "codex/shutdown":
			if mode == "inherited-stderr-shutdown-timeout" {
				time.Sleep(time.Minute)
			}
			helperSuccess(codec, message, map[string]any{})
			os.Exit(0)
		case "fixture/exit":
			if mode == "inherited-stderr-unexpected-zero" {
				os.Exit(0)
			}
			os.Exit(17)
		default:
			helperFailure(codec, message, -32601, "method not found")
		}
	}
}
