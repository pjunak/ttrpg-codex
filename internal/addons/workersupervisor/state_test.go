package workersupervisor

import (
	"testing"
	"time"
)

func TestRestartPolicyUsesBoundedExponentialBackoff(t *testing.T) {
	t.Parallel()

	policy := RestartPolicy{
		MaxRestarts:  4,
		InitialDelay: 100 * time.Millisecond,
		MaxDelay:     250 * time.Millisecond,
	}
	tests := []struct {
		failures int
		allowed  bool
		delay    time.Duration
	}{
		{0, false, 0},
		{1, true, 100 * time.Millisecond},
		{2, true, 200 * time.Millisecond},
		{3, true, 250 * time.Millisecond},
		{4, true, 250 * time.Millisecond},
		{5, false, 0},
	}
	for _, test := range tests {
		decision := policy.Decide(test.failures)
		if decision.Allowed != test.allowed || decision.Delay != test.delay {
			t.Fatalf("failures %d: decision = %+v", test.failures, decision)
		}
	}
}

func TestLifecycleTransitionGraphRejectsShortcuts(t *testing.T) {
	t.Parallel()

	if allowedTransitions[StateCreated][StateReady] {
		t.Fatal("created worker can skip directly to ready")
	}
	if !allowedTransitions[StateChecking][StateReady] {
		t.Fatal("checked worker cannot become ready")
	}
	if len(allowedTransitions[StateFailed]) != 0 {
		t.Fatal("failed process instance has outgoing transitions")
	}
}
