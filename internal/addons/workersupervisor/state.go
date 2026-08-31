package workersupervisor

import (
	"fmt"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type State string

const (
	StateCreated      State = "created"
	StateSpawning     State = "spawning"
	StateInitializing State = "initializing"
	StateStarting     State = "starting"
	StateChecking     State = "checking"
	StateReady        State = "ready"
	StateStopping     State = "stopping"
	StateStopped      State = "stopped"
	StateFailed       State = "failed"
)

const (
	CodeInvalidState    = "INVALID_STATE"
	CodeSpawnFailed     = "SPAWN_FAILED"
	CodeStartupFailed   = "STARTUP_FAILED"
	CodeStartupTimed    = "STARTUP_TIMEOUT"
	CodeHealthFailed    = "HEALTH_FAILED"
	CodeShutdownFailed  = "SHUTDOWN_FAILED"
	CodeProcessExited   = "PROCESS_EXITED"
	CodeTransportFailed = "TRANSPORT_FAILED"
)

type LifecycleError struct {
	Code  string
	Cause error
}

func (e *LifecycleError) Error() string {
	return fmt.Sprintf("%s: %v", e.Code, e.Cause)
}

func (e *LifecycleError) Unwrap() error {
	return e.Cause
}

func lifecycleError(code string, cause error) error {
	return &LifecycleError{Code: code, Cause: cause}
}

type Transition struct {
	At     time.Time `json:"at"`
	From   State     `json:"from"`
	To     State     `json:"to"`
	Reason string    `json:"reason"`
}

var allowedTransitions = map[State]map[State]bool{
	StateCreated:      {StateSpawning: true, StateStopped: true, StateFailed: true},
	StateSpawning:     {StateInitializing: true, StateFailed: true},
	StateInitializing: {StateStarting: true, StateFailed: true},
	StateStarting:     {StateChecking: true, StateFailed: true},
	StateChecking:     {StateReady: true, StateFailed: true},
	StateReady:        {StateStopping: true, StateFailed: true},
	StateStopping:     {StateStopped: true, StateFailed: true},
	StateStopped:      {},
	StateFailed:       {},
}

type Negotiated struct {
	ProtocolVersion string            `json:"protocolVersion"`
	Capabilities    []string          `json:"capabilities"`
	Methods         map[string]string `json:"methods"`
	HealthCheck     bool              `json:"healthCheck"`
}

type Snapshot struct {
	Identity    Identity                `json:"identity"`
	State       State                   `json:"state"`
	PID         int                     `json:"pid,omitempty"`
	StartedAt   *time.Time              `json:"startedAt,omitempty"`
	ExitedAt    *time.Time              `json:"exitedAt,omitempty"`
	LastError   string                  `json:"lastError,omitempty"`
	ExitError   string                  `json:"exitError,omitempty"`
	StderrTail  string                  `json:"stderrTail,omitempty"`
	Negotiated  *Negotiated             `json:"negotiated,omitempty"`
	RPC         *workerrpc.PeerSnapshot `json:"rpc,omitempty"`
	Transitions []Transition            `json:"transitions"`
}

type RestartPolicy struct {
	MaxRestarts  int
	InitialDelay time.Duration
	MaxDelay     time.Duration
	StableAfter  time.Duration
}

type RestartDecision struct {
	Allowed bool
	Delay   time.Duration
}

var DefaultRestartPolicy = RestartPolicy{
	MaxRestarts:  3,
	InitialDelay: time.Second,
	MaxDelay:     30 * time.Second,
	StableAfter:  5 * time.Minute,
}

// Decide returns bounded deterministic exponential backoff. The generation
// manager, not an individual process instance, owns attempts and stability.
func (policy RestartPolicy) Decide(consecutiveFailures int) RestartDecision {
	if policy.MaxRestarts <= 0 {
		policy.MaxRestarts = DefaultRestartPolicy.MaxRestarts
	}
	if policy.InitialDelay <= 0 {
		policy.InitialDelay = DefaultRestartPolicy.InitialDelay
	}
	if policy.MaxDelay <= 0 {
		policy.MaxDelay = DefaultRestartPolicy.MaxDelay
	}
	if consecutiveFailures < 1 || consecutiveFailures > policy.MaxRestarts {
		return RestartDecision{}
	}
	delay := policy.InitialDelay
	for attempt := 1; attempt < consecutiveFailures && delay < policy.MaxDelay; attempt++ {
		if delay > policy.MaxDelay/2 {
			delay = policy.MaxDelay
			break
		}
		delay *= 2
	}
	if delay > policy.MaxDelay {
		delay = policy.MaxDelay
	}
	return RestartDecision{Allowed: true, Delay: delay}
}
