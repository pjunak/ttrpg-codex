package workersupervisor

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestHealthDeadlineTerminatesWorkerWithBlockedInput(t *testing.T) {
	supervisor := newTestSupervisor(t, "blocked-input", func(config *Config) {
		config.HealthTimeout = 100 * time.Millisecond
	})
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	callCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	callDone := make(chan error, 1)
	go func() {
		_, err := supervisor.Call(callCtx, "fixture/large", map[string]any{"body": strings.Repeat("x", 2<<20)}, &workerrpc.Meta{
			RequestID: "blocked-input", CorrelationID: "blocked-input", Generation: "generation-42", Deadline: time.Now().Add(5 * time.Second),
		})
		callDone <- err
	}()
	defer func() {
		supervisor.terminate()
		select {
		case err := <-callDone:
			if err == nil {
				t.Error("blocked domain request succeeded after transport termination")
			}
		case <-time.After(3 * time.Second):
			t.Error("blocked domain writer survived transport termination")
		}
	}()
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(supervisor.Snapshot().StderrTail, "blocked-input-prefix") {
		if time.Now().After(deadline) {
			t.Fatal("native worker did not consume the frame prefix")
		}
		time.Sleep(time.Millisecond)
	}
	healthDone := make(chan error, 1)
	go func() {
		_, err := supervisor.Health(context.Background())
		healthDone <- err
	}()
	select {
	case err := <-healthDone:
		assertLifecycleCode(t, err, CodeHealthFailed)
	case <-time.After(time.Second):
		t.Fatal("health deadline remained blocked behind the domain writer")
	}
	if snapshot := supervisor.Snapshot(); snapshot.State != StateFailed || SafeFailureCode(snapshot.LastError) != CodeHealthFailed {
		t.Fatalf("blocked transport did not fail with its health deadline: %+v", snapshot)
	}
	waitCtx, stopWait := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopWait()
	if err := supervisor.Wait(waitCtx); err == nil || waitCtx.Err() != nil {
		t.Fatal("failed worker was not reaped", err)
	}
}
