package workersupervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"sync"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type Supervisor struct {
	config      Config
	environment []string
	stderr      *tailBuffer
	operation   chan struct{}

	mu          sync.Mutex
	rpc         sync.Mutex
	state       State
	transitions []Transition
	command     *exec.Cmd
	codec       *workerrpc.Codec
	peer        *workerrpc.Peer
	stdin       *os.File
	stdout      *os.File
	closeOnce   sync.Once
	done        chan struct{}
	waitError   error
	startedAt   *time.Time
	exitedAt    *time.Time
	lastError   error
	negotiated  *Negotiated
	nextID      uint64
}

func New(config Config) (*Supervisor, error) {
	normalized, environment, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	supervisor := &Supervisor{
		config:      normalized,
		environment: environment,
		stderr:      newTailBuffer(normalized.MaxStderrBytes),
		operation:   make(chan struct{}, 1),
		state:       StateCreated,
		transitions: make([]Transition, 0, 10),
	}
	supervisor.operation <- struct{}{}
	return supervisor, nil
}

func (supervisor *Supervisor) Start(ctx context.Context) error {
	if err := supervisor.acquireOperation(ctx); err != nil {
		return err
	}
	defer supervisor.releaseOperation()
	if err := supervisor.transition(StateSpawning, "process launch requested"); err != nil {
		return err
	}
	command := exec.Command(supervisor.config.Executable, supervisor.config.Arguments...)
	command.Dir = supervisor.config.WorkingDirectory
	command.Env = append([]string{}, supervisor.environment...)
	command.Stderr = supervisor.stderr
	workerStdin, hostStdin, err := os.Pipe()
	if err != nil {
		return supervisor.fail(CodeSpawnFailed, fmt.Errorf("open worker stdin: %w", err))
	}
	hostStdout, workerStdout, err := os.Pipe()
	if err != nil {
		_ = workerStdin.Close()
		_ = hostStdin.Close()
		return supervisor.fail(CodeSpawnFailed, fmt.Errorf("open worker stdout: %w", err))
	}
	closePipes := func() {
		_ = workerStdin.Close()
		_ = hostStdin.Close()
		_ = hostStdout.Close()
		_ = workerStdout.Close()
	}
	command.Stdin = workerStdin
	command.Stdout = workerStdout
	codec, err := workerrpc.NewCodec(hostStdout, hostStdin, workerrpc.Limits{
		MaxHeaderBytes: workerrpc.DefaultLimits.MaxHeaderBytes,
		MaxFrameBytes:  supervisor.config.Limits.MaxFrameBytes,
	})
	if err != nil {
		closePipes()
		return supervisor.fail(CodeSpawnFailed, err)
	}
	if err := command.Start(); err != nil {
		closePipes()
		return supervisor.fail(CodeSpawnFailed, fmt.Errorf("start worker: %w", err))
	}
	_ = workerStdin.Close()
	_ = workerStdout.Close()
	started := time.Now().UTC()
	supervisor.mu.Lock()
	supervisor.command = command
	supervisor.codec = codec
	supervisor.stdin = hostStdin
	supervisor.stdout = hostStdout
	supervisor.done = make(chan struct{})
	supervisor.startedAt = &started
	supervisor.mu.Unlock()
	go supervisor.watchProcess(command)

	startupCtx, cancel := context.WithTimeout(ctx, supervisor.config.StartupTimeout)
	defer cancel()
	if err := supervisor.transition(StateInitializing, "process started"); err != nil {
		return supervisor.fail(CodeStartupFailed, err)
	}
	initialize, err := supervisor.exchange(startupCtx, "codex/initialize", supervisor.initializeParams())
	if err != nil {
		return supervisor.fail(startupCode(err), fmt.Errorf("initialize worker: %w", err))
	}
	negotiated, err := supervisor.validateInitialize(initialize)
	if err != nil {
		return supervisor.fail(CodeStartupFailed, err)
	}
	supervisor.mu.Lock()
	supervisor.negotiated = &negotiated
	supervisor.mu.Unlock()

	if err := supervisor.transition(StateStarting, "protocol negotiated"); err != nil {
		return supervisor.fail(CodeStartupFailed, err)
	}
	startedBody, err := supervisor.exchange(startupCtx, "codex/start", map[string]any{})
	if err != nil {
		return supervisor.fail(startupCode(err), fmt.Errorf("start worker runtime: %w", err))
	}
	var startResult struct {
		Ready bool `json:"ready"`
	}
	if err := json.Unmarshal(startedBody, &startResult); err != nil || !startResult.Ready {
		return supervisor.fail(CodeStartupFailed, errors.New("worker did not report ready after codex/start"))
	}

	if err := supervisor.transition(StateChecking, "worker reported ready"); err != nil {
		return supervisor.fail(CodeStartupFailed, err)
	}
	healthCtx, healthCancel := context.WithTimeout(startupCtx, supervisor.config.HealthTimeout)
	health, err := supervisor.exchange(healthCtx, "codex/health", map[string]any{})
	healthCancel()
	if err != nil {
		return supervisor.fail(startupCode(err), fmt.Errorf("initial worker health check: %w", err))
	}
	status, err := decodeHealth(health)
	if err != nil || status.Status != "ok" {
		if err == nil {
			err = fmt.Errorf("worker health status is %q", status.Status)
		}
		return supervisor.fail(CodeHealthFailed, err)
	}
	peer, err := workerrpc.NewPeer(codec, workerrpc.PeerConfig{
		IDPrefix:            "host-runtime",
		Generation:          supervisor.config.Identity.Generation,
		MaxOutgoingRequests: supervisor.config.Limits.MaxConcurrentRequests,
		MaxIncomingRequests: supervisor.config.Limits.MaxConcurrentRequests,
		RequireIncomingMeta: true,
		Handler:             supervisor.config.Handler,
		OnTerminal:          supervisor.handlePeerTerminal,
	})
	if err != nil {
		return supervisor.fail(CodeStartupFailed, fmt.Errorf("create worker RPC peer: %w", err))
	}
	supervisor.mu.Lock()
	supervisor.peer = peer
	supervisor.mu.Unlock()
	if err := peer.Start(); err != nil {
		return supervisor.fail(CodeStartupFailed, fmt.Errorf("start worker RPC peer: %w", err))
	}
	if err := supervisor.transition(StateReady, "initial health check passed"); err != nil {
		return supervisor.fail(CodeStartupFailed, err)
	}
	return nil
}

type Health struct {
	Status  string         `json:"status"`
	Details map[string]any `json:"details,omitempty"`
}

func (supervisor *Supervisor) Health(ctx context.Context) (Health, error) {
	if err := supervisor.acquireOperation(ctx); err != nil {
		return Health{}, err
	}
	defer supervisor.releaseOperation()
	if supervisor.State() != StateReady {
		return Health{}, lifecycleError(CodeInvalidState, fmt.Errorf("health requires %s state", StateReady))
	}
	healthCtx, cancel := context.WithTimeout(ctx, supervisor.config.HealthTimeout)
	defer cancel()
	peer := supervisor.runtimePeer()
	if peer == nil {
		return Health{}, supervisor.fail(CodeHealthFailed, errors.New("worker RPC peer is not active"))
	}
	body, err := peer.Call(healthCtx, "codex/health", map[string]any{}, nil)
	if err != nil {
		var protocol *workerrpc.ProtocolError
		if errors.As(err, &protocol) {
			return Health{}, supervisor.fail(CodeTransportFailed, err)
		}
		return Health{}, supervisor.fail(CodeHealthFailed, err)
	}
	status, err := decodeHealth(body)
	if err != nil {
		return Health{}, supervisor.fail(CodeHealthFailed, err)
	}
	return status, nil
}

// Call routes one generation-scoped domain request through the active peer.
// Contract selection and schema validation remain the service broker's job.
func (supervisor *Supervisor) Call(
	ctx context.Context,
	method string,
	params any,
	meta *workerrpc.Meta,
) (json.RawMessage, error) {
	if meta == nil || meta.Generation != supervisor.config.Identity.Generation {
		return nil, workerrpc.NewRPCError(
			workerrpc.JSONRPCApplication,
			workerrpc.KindStaleBinding,
			"The service handle targets a stale worker generation.",
			false,
			nil,
		)
	}
	if supervisor.State() != StateReady {
		return nil, lifecycleError(CodeInvalidState, fmt.Errorf("service call requires %s state", StateReady))
	}
	peer := supervisor.runtimePeer()
	if peer == nil {
		return nil, lifecycleError(CodeInvalidState, errors.New("worker RPC peer is not active"))
	}
	return peer.Call(ctx, method, params, meta)
}

func decodeHealth(body json.RawMessage) (Health, error) {
	var health Health
	if err := json.Unmarshal(body, &health); err != nil {
		return Health{}, fmt.Errorf("decode health result: %w", err)
	}
	if health.Status != "ok" && health.Status != "degraded" {
		return Health{}, fmt.Errorf("invalid health status %q", health.Status)
	}
	return health, nil
}

func (supervisor *Supervisor) Shutdown(ctx context.Context) error {
	if err := supervisor.acquireOperation(ctx); err != nil {
		return err
	}
	defer supervisor.releaseOperation()
	state := supervisor.State()
	switch state {
	case StateCreated:
		return supervisor.transition(StateStopped, "stopped before launch")
	case StateStopped, StateFailed:
		if peer := supervisor.runtimePeer(); peer != nil {
			peer.CancelIncoming()
		}
		supervisor.terminate()
		return nil
	case StateReady:
		if err := supervisor.transition(StateStopping, "graceful shutdown requested"); err != nil {
			return err
		}
	default:
		return lifecycleError(CodeInvalidState, fmt.Errorf("cannot shut down worker in %s state", state))
	}

	shutdownCtx, cancel := context.WithTimeout(ctx, supervisor.config.ShutdownTimeout)
	defer cancel()
	peer := supervisor.runtimePeer()
	if peer == nil {
		failure := lifecycleError(CodeShutdownFailed, errors.New("worker RPC peer is not active"))
		supervisor.markFailed(failure)
		supervisor.terminate()
		return failure
	}
	peer.CancelIncoming()
	if _, err := peer.Call(shutdownCtx, "codex/shutdown", map[string]any{}, nil); err != nil {
		failure := lifecycleError(CodeShutdownFailed, err)
		supervisor.markFailed(failure)
		supervisor.terminate()
		return failure
	}
	done := supervisor.processDone()
	select {
	case <-done:
		if err := supervisor.rawProcessError(); err != nil {
			failure := lifecycleError(CodeShutdownFailed, fmt.Errorf("worker exited after shutdown: %w", err))
			supervisor.markFailed(failure)
			supervisor.closeTransport()
			return failure
		}
		supervisor.closeTransport()
		return supervisor.transition(StateStopped, "worker exited after graceful shutdown")
	case <-shutdownCtx.Done():
		failure := lifecycleError(CodeShutdownFailed, shutdownCtx.Err())
		supervisor.markFailed(failure)
		supervisor.terminate()
		return failure
	}
}

func (supervisor *Supervisor) acquireOperation(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-supervisor.operation:
		if err := ctx.Err(); err != nil {
			supervisor.releaseOperation()
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (supervisor *Supervisor) releaseOperation() {
	supervisor.operation <- struct{}{}
}

func (supervisor *Supervisor) State() State {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.state
}

// Wait observes process completion without taking ownership of shutdown.
// Generation managers use it to apply restart policy to unexpected exits.
func (supervisor *Supervisor) Wait(ctx context.Context) error {
	done := supervisor.processDone()
	if done == nil {
		return lifecycleError(CodeInvalidState, errors.New("worker process has not started"))
	}
	select {
	case <-done:
		supervisor.mu.Lock()
		defer supervisor.mu.Unlock()
		if supervisor.lastError != nil {
			return supervisor.lastError
		}
		return supervisor.waitError
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (supervisor *Supervisor) Snapshot() Snapshot {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	snapshot := Snapshot{
		Identity:    supervisor.config.Identity,
		State:       supervisor.state,
		StartedAt:   cloneTime(supervisor.startedAt),
		ExitedAt:    cloneTime(supervisor.exitedAt),
		StderrTail:  supervisor.stderr.String(),
		Transitions: append([]Transition(nil), supervisor.transitions...),
	}
	if supervisor.command != nil && supervisor.command.Process != nil {
		snapshot.PID = supervisor.command.Process.Pid
	}
	if supervisor.lastError != nil {
		snapshot.LastError = supervisor.lastError.Error()
	}
	if supervisor.waitError != nil {
		snapshot.ExitError = supervisor.waitError.Error()
	}
	if supervisor.negotiated != nil {
		value := *supervisor.negotiated
		value.Capabilities = append([]string(nil), value.Capabilities...)
		value.Methods = cloneMap(value.Methods)
		snapshot.Negotiated = &value
	}
	if supervisor.peer != nil {
		value := supervisor.peer.Snapshot()
		snapshot.RPC = &value
	}
	return snapshot
}

func (supervisor *Supervisor) initializeParams() map[string]any {
	return map[string]any{
		"protocolVersion": supervisor.config.ProtocolVersion,
		"addon":           supervisor.config.Identity,
		"host":            supervisor.config.Host,
		"grants":          supervisor.config.Grants,
		"services":        supervisor.config.Services,
		"limits":          supervisor.config.Limits,
	}
}

func (supervisor *Supervisor) validateInitialize(body json.RawMessage) (Negotiated, error) {
	var result Negotiated
	if err := json.Unmarshal(body, &result); err != nil {
		return Negotiated{}, fmt.Errorf("decode initialize result: %w", err)
	}
	if result.ProtocolVersion != supervisor.config.ProtocolVersion {
		return Negotiated{}, fmt.Errorf("worker negotiated protocol %q, want %q", result.ProtocolVersion, supervisor.config.ProtocolVersion)
	}
	if !result.HealthCheck {
		return Negotiated{}, errors.New("worker must support codex/health")
	}
	seen := make(map[string]struct{}, len(result.Capabilities))
	for _, capability := range result.Capabilities {
		if capability == "" {
			return Negotiated{}, errors.New("worker returned an empty capability")
		}
		if _, exists := seen[capability]; exists {
			return Negotiated{}, fmt.Errorf("worker returned duplicate capability %q", capability)
		}
		seen[capability] = struct{}{}
	}
	for method, version := range result.Methods {
		if method == "" || version == "" {
			return Negotiated{}, errors.New("worker returned an empty method or method version")
		}
	}
	if result.Methods["codex/health"] == "" {
		return Negotiated{}, errors.New("worker must declare a codex/health method version")
	}
	slices.Sort(result.Capabilities)
	return result, nil
}

func (supervisor *Supervisor) exchange(ctx context.Context, method string, params any) (json.RawMessage, error) {
	supervisor.rpc.Lock()
	defer supervisor.rpc.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	supervisor.mu.Lock()
	codec := supervisor.codec
	done := supervisor.done
	supervisor.nextID++
	id := fmt.Sprintf("host-%d", supervisor.nextID)
	supervisor.mu.Unlock()
	if codec == nil || done == nil {
		return nil, lifecycleError(CodeInvalidState, errors.New("worker transport is not active"))
	}
	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	if err := codec.Write(ctx, request); err != nil {
		return nil, err
	}
	type readResult struct {
		message workerrpc.Message
		err     error
	}
	result := make(chan readResult, 1)
	go func() {
		message, err := codec.Read(context.Background())
		result <- readResult{message: message, err: err}
	}()

	select {
	case value := <-result:
		if value.err != nil {
			return nil, value.err
		}
		return responseResult(value.message, id)
	case <-done:
		// Process exit closes stdout. Drain the read result so a final complete
		// shutdown response wins over the concurrently observed exit.
		value := <-result
		if value.err == nil {
			return responseResult(value.message, id)
		}
		return nil, lifecycleError(CodeProcessExited, supervisor.processError())
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func responseResult(message workerrpc.Message, expectedID string) (json.RawMessage, error) {
	if message.Kind != workerrpc.KindSuccess && message.Kind != workerrpc.KindFailure {
		return nil, fmt.Errorf("worker sent %s while a response was required", message.Kind)
	}
	var response struct {
		ID     json.RawMessage `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *RemoteError    `json:"error"`
	}
	if err := json.Unmarshal(message.Raw, &response); err != nil {
		return nil, err
	}
	var responseID string
	if err := json.Unmarshal(response.ID, &responseID); err != nil || responseID != expectedID {
		return nil, fmt.Errorf("worker response id does not match %q", expectedID)
	}
	if response.Error != nil {
		return nil, response.Error
	}
	return response.Result, nil
}

type RemoteError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (remote *RemoteError) Error() string {
	return fmt.Sprintf("worker RPC %d: %s", remote.Code, remote.Message)
}

func (supervisor *Supervisor) transition(to State, reason string) error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.transitionLocked(to, reason)
}

func (supervisor *Supervisor) transitionLocked(to State, reason string) error {
	from := supervisor.state
	if !allowedTransitions[from][to] {
		return lifecycleError(CodeInvalidState, fmt.Errorf("transition %s -> %s is forbidden", from, to))
	}
	supervisor.state = to
	supervisor.transitions = append(supervisor.transitions, Transition{
		At:     time.Now().UTC(),
		From:   from,
		To:     to,
		Reason: reason,
	})
	supervisor.config.Logger.Info("worker lifecycle transition",
		"addon", supervisor.config.Identity.AddonID,
		"generation", supervisor.config.Identity.Generation,
		"from", from,
		"to", to,
		"reason", reason,
	)
	return nil
}

func (supervisor *Supervisor) fail(code string, cause error) error {
	failure := lifecycleError(code, cause)
	supervisor.markFailed(failure)
	supervisor.terminate()
	return failure
}

func (supervisor *Supervisor) markFailed(failure error) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.state == StateFailed || supervisor.state == StateStopped {
		return
	}
	supervisor.lastError = failure
	_ = supervisor.transitionLocked(StateFailed, failure.Error())
}

func (supervisor *Supervisor) handlePeerTerminal(err error) {
	if errors.Is(err, io.EOF) || errors.Is(err, workerrpc.ErrPeerClosed) {
		return
	}
	failure := lifecycleError(CodeTransportFailed, fmt.Errorf("worker RPC peer failed: %w", err))
	supervisor.markFailed(failure)
	supervisor.terminate()
}

func startupCode(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return CodeStartupTimed
	}
	return CodeStartupFailed
}

func (supervisor *Supervisor) watchProcess(command *exec.Cmd) {
	err := command.Wait()
	exited := time.Now().UTC()
	supervisor.mu.Lock()
	supervisor.waitError = err
	supervisor.exitedAt = &exited
	if supervisor.state != StateStopping && supervisor.state != StateStopped && supervisor.state != StateFailed {
		failure := lifecycleError(CodeProcessExited, processExitCause(err))
		supervisor.lastError = failure
		_ = supervisor.transitionLocked(StateFailed, failure.Error())
	}
	close(supervisor.done)
	supervisor.mu.Unlock()
	if peer := supervisor.runtimePeer(); peer != nil {
		timer := time.NewTimer(supervisor.config.ShutdownTimeout)
		defer timer.Stop()
		select {
		case <-peer.Done():
		case <-timer.C:
		}
		supervisor.closeTransport()
	}
}

func processExitCause(err error) error {
	if err == nil {
		return errors.New("worker exited unexpectedly with status 0")
	}
	return err
}

func (supervisor *Supervisor) terminate() {
	supervisor.mu.Lock()
	command := supervisor.command
	done := supervisor.done
	supervisor.mu.Unlock()
	if command == nil || command.Process == nil || done == nil {
		return
	}
	select {
	case <-done:
		supervisor.closeTransport()
		return
	default:
	}
	_ = command.Process.Kill()
	<-done
	supervisor.closeTransport()
}

func (supervisor *Supervisor) closeTransport() {
	supervisor.closeOnce.Do(func() {
		supervisor.mu.Lock()
		stdin := supervisor.stdin
		stdout := supervisor.stdout
		supervisor.mu.Unlock()
		if stdin != nil {
			_ = stdin.Close()
		}
		if stdout != nil {
			_ = stdout.Close()
		}
	})
}

func (supervisor *Supervisor) processDone() <-chan struct{} {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.done
}

func (supervisor *Supervisor) runtimePeer() *workerrpc.Peer {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.peer
}

func (supervisor *Supervisor) processError() error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return processExitCause(supervisor.waitError)
}

func (supervisor *Supervisor) rawProcessError() error {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	return supervisor.waitError
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneMap[K comparable, V any](value map[K]V) map[K]V {
	result := make(map[K]V, len(value))
	for key, item := range value {
		result[key] = item
	}
	return result
}

var _ io.Writer = (*tailBuffer)(nil)
