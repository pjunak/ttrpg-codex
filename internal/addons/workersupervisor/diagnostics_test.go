package workersupervisor

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
	"strings"
	"testing"
	"time"
)

func TestAdministrativeDiagnosticsNeverExposeWorkerTextOrMutableSnapshots(t *testing.T) {
	secret := "private password campaign token"
	snapshot := Snapshot{LastError: CodeHealthFailed + ": " + secret, ExitError: secret, StderrTail: secret,
		Transitions: []Transition{{From: StateReady, To: StateFailed, Reason: secret}},
		RPC:         &workerrpc.PeerSnapshot{LastError: secret}, Negotiated: &Negotiated{Methods: map[string]string{secret: secret}},
		Health:   &HealthDiagnostic{Status: "failed", At: time.Now()},
		Requests: []RequestDiagnostic{{Method: "service/read", Outcome: "OK"}},
	}
	public := AdministrativeSnapshot(snapshot)
	body, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), secret) || public.LastError != CodeHealthFailed || public.ExitError != "INTERNAL" {
		t.Fatalf("unsafe diagnostic: %s", body)
	}
	public.Transitions[0].Reason = "changed"
	public.Requests[0].Outcome = "changed"
	public.Health.Status = "changed"
	public.RPC.LastError = "changed"
	if snapshot.Transitions[0].Reason != secret || snapshot.Requests[0].Outcome != "OK" || snapshot.Health.Status != "failed" || snapshot.RPC.LastError != secret {
		t.Fatal("snapshot aliases runtime state")
	}
}

func TestRequestDiagnosticsBoundHistoryAndCorrelateWithoutKeepingInputs(t *testing.T) {
	supervisor := newTestSupervisor(t, "service-call", nil)
	for i := 0; i < 40; i++ {
		supervisor.recordRequest("service/example/read", &workerrpc.Meta{RequestID: "request-secret", CorrelationID: "correlation-secret"}, time.Now(), context.DeadlineExceeded)
	}
	snapshot := supervisor.Snapshot()
	if len(snapshot.Requests) != 32 {
		t.Fatalf("unbounded ring: %d", len(snapshot.Requests))
	}
	first := snapshot.Requests[0]
	if first.Outcome != "DEADLINE_EXCEEDED" || len(first.RequestRef) != 16 || first.RequestRef == first.CorrelationRef || first.CorrelationRef != snapshot.Requests[31].CorrelationRef {
		t.Fatalf("bad correlation: %+v", first)
	}
	body, _ := json.Marshal(snapshot.Requests)
	if strings.Contains(string(body), "secret") {
		t.Fatal("raw IDs retained")
	}
	supervisor.recordRequest("unsafe method\nsecret", nil, time.Now(), errors.New("private failure"))
	if got := supervisor.Snapshot().Requests[31]; got.Method != "service" || got.Outcome != "INTERNAL" {
		t.Fatalf("unsafe fallback: %+v", got)
	}
}
