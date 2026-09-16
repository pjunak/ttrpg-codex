package workersupervisor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type RequestDiagnostic struct {
	Method         string    `json:"method"`
	RequestRef     string    `json:"requestRef,omitempty"`
	CorrelationRef string    `json:"correlationRef,omitempty"`
	Outcome        string    `json:"outcome"`
	At             time.Time `json:"at"`
	Milliseconds   int64     `json:"milliseconds"`
}
type HealthDiagnostic struct {
	Status string    `json:"status"`
	At     time.Time `json:"at"`
}

var diagnosticMethod = regexp.MustCompile(`^[a-zA-Z0-9._/-]{1,120}$`)

func reference(value string) string {
	if value == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}
func outcome(err error) string {
	if err == nil {
		return "OK"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return workerrpc.KindDeadlineExceeded
	}
	if errors.Is(err, context.Canceled) {
		return workerrpc.KindCancelled
	}
	var rpc *workerrpc.RPCError
	if errors.As(err, &rpc) && rpc.Data != nil {
		return workerrpc.NewRPCError(0, rpc.Data.Kind, "", false, nil).Data.Kind
	}
	return SafeFailureCode(err.Error())
}
func (supervisor *Supervisor) recordRequest(method string, meta *workerrpc.Meta, started time.Time, err error) {
	if !diagnosticMethod.MatchString(method) {
		method = "service"
	}
	entry := RequestDiagnostic{Method: method, Outcome: outcome(err), At: time.Now().UTC(), Milliseconds: max(0, time.Since(started).Milliseconds())}
	if meta != nil {
		entry.RequestRef = reference(meta.RequestID)
		entry.CorrelationRef = reference(meta.CorrelationID)
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	supervisor.requests = append(supervisor.requests, entry)
	if len(supervisor.requests) > 32 {
		supervisor.requests = append([]RequestDiagnostic(nil), supervisor.requests[len(supervisor.requests)-32:]...)
	}
}
func (supervisor *Supervisor) recordHealth(status string) {
	if status != "ok" && status != "degraded" {
		status = "failed"
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	supervisor.health = &HealthDiagnostic{Status: status, At: time.Now().UTC()}
}

// SafeFailureCode deliberately discards free text. Pattern-based secret
// redaction cannot reliably remove arbitrary worker or campaign contents.
func SafeFailureCode(message string) string {
	if message == "" {
		return ""
	}
	for _, code := range []string{CodeInvalidState, CodeSpawnFailed, CodeStartupFailed, CodeStartupTimed, CodeHealthFailed, CodeShutdownFailed, CodeProcessExited, CodeTransportFailed} {
		if strings.HasPrefix(message, code+":") {
			return code
		}
	}
	return workerrpc.KindInternal
}

// AdministrativeSnapshot projects only bounded structure. Raw stderr,
// exception text, worker-provided health details and request bodies never leave
// the process through the administrative API.
func AdministrativeSnapshot(snapshot Snapshot) Snapshot {
	snapshot.LastError = SafeFailureCode(snapshot.LastError)
	snapshot.ExitError = SafeFailureCode(snapshot.ExitError)
	snapshot.StderrTail = ""
	if snapshot.ExitCode != nil {
		value := *snapshot.ExitCode
		snapshot.ExitCode = &value
	}
	snapshot.Negotiated = nil
	snapshot.Transitions = append([]Transition(nil), snapshot.Transitions...)
	for i := range snapshot.Transitions {
		snapshot.Transitions[i].Reason = ""
	}
	if snapshot.RPC != nil {
		value := *snapshot.RPC
		value.LastError = SafeFailureCode(value.LastError)
		snapshot.RPC = &value
	}
	snapshot.Requests = append([]RequestDiagnostic(nil), snapshot.Requests...)
	if snapshot.Health != nil {
		value := *snapshot.Health
		snapshot.Health = &value
	}
	return snapshot
}
