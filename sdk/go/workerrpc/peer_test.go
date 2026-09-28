package workerrpc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPeerRoutesConcurrentBidirectionalCalls(t *testing.T) {
	t.Parallel()

	host, worker := newTestPeerPair(t,
		RequestHandlerFunc(func(_ context.Context, request Request) (any, error) {
			return map[string]any{"handledBy": "host", "method": request.Method}, nil
		}),
		RequestHandlerFunc(func(_ context.Context, request Request) (any, error) {
			return map[string]any{"handledBy": "worker", "method": request.Method}, nil
		}),
		nil,
		nil,
	)

	type outcome struct {
		body json.RawMessage
		err  error
	}
	hostResult := make(chan outcome, 1)
	workerResult := make(chan outcome, 1)
	go func() {
		body, err := host.Call(context.Background(), "addon/service.call", map[string]any{"value": 1}, testMeta())
		hostResult <- outcome{body: body, err: err}
	}()
	go func() {
		body, err := worker.Call(context.Background(), "host/data.get", map[string]any{"id": "one"}, testMeta())
		workerResult <- outcome{body: body, err: err}
	}()

	assertResultField(t, <-hostResult, "handledBy", "worker")
	assertResultField(t, <-workerResult, "handledBy", "host")
	if snapshot := host.Snapshot(); snapshot.OutgoingCalls != 1 || snapshot.IncomingCalls != 1 || snapshot.PendingOutgoing != 0 {
		t.Fatalf("host snapshot = %+v", snapshot)
	}
}

func TestPeerPropagatesCancellationAndDiscardsLateResponse(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	release := make(chan struct{})
	host, worker := newTestPeerPair(t, nil,
		RequestHandlerFunc(func(ctx context.Context, _ Request) (any, error) {
			close(started)
			<-ctx.Done()
			<-release
			return map[string]any{"late": true}, nil
		}),
		nil,
		nil,
	)

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := host.Call(ctx, "addon/service.call", map[string]any{}, testMeta())
		result <- err
	}()
	<-started
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("Call error = %v, want context.Canceled", err)
	}
	waitFor(t, func() bool { return worker.Snapshot().CancelledIncoming == 1 })
	close(release)
	waitFor(t, func() bool { return host.Snapshot().LateResponses == 1 })
	if snapshot := host.Snapshot(); snapshot.CancelledOutgoing != 1 || snapshot.PendingOutgoing != 0 {
		t.Fatalf("host cancellation snapshot = %+v", snapshot)
	}
}

func TestPeerRejectsExcessIncomingWorkWithoutQueueing(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	host, _ := newTestPeerPair(t, nil,
		RequestHandlerFunc(func(_ context.Context, _ Request) (any, error) {
			once.Do(func() { close(started) })
			<-release
			return map[string]any{"ok": true}, nil
		}),
		func(config *PeerConfig) { config.MaxOutgoingRequests = 2 },
		func(config *PeerConfig) { config.MaxIncomingRequests = 1 },
	)

	first := make(chan error, 1)
	go func() {
		_, err := host.Call(context.Background(), "addon/service.call", map[string]any{"call": 1}, testMeta())
		first <- err
	}()
	<-started
	_, err := host.Call(context.Background(), "addon/service.call", map[string]any{"call": 2}, testMeta())
	assertRPCError(t, err, KindRateLimited)
	close(release)
	if err := <-first; err != nil {
		t.Fatalf("first Call: %v", err)
	}
}

func TestPeerReservesLifecycleControlDuringDomainSaturation(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	release := make(chan struct{})
	host, _ := newTestPeerPair(t, nil,
		RequestHandlerFunc(func(_ context.Context, request Request) (any, error) {
			if request.Method == "codex/health" {
				return map[string]any{"status": "ok"}, nil
			}
			if request.Method == "codex/shutdown" {
				return map[string]any{}, nil
			}
			close(started)
			<-release
			return map[string]any{"ok": true}, nil
		}),
		func(config *PeerConfig) { config.MaxOutgoingRequests = 1 },
		func(config *PeerConfig) {
			config.MaxIncomingRequests = 1
			config.RequireIncomingMeta = false
		},
	)

	domain := make(chan error, 1)
	go func() {
		_, err := host.Call(context.Background(), "addon/service.call", map[string]any{}, testMeta())
		domain <- err
	}()
	<-started
	if _, err := host.Call(context.Background(), "addon/service.call", map[string]any{}, testMeta()); err == nil {
		t.Fatal("domain request exceeded the configured capacity")
	} else {
		assertRPCError(t, err, KindRateLimited)
	}
	for _, method := range []string{"codex/health", "codex/shutdown"} {
		if _, err := host.Call(context.Background(), method, map[string]any{}, testMeta()); err == nil {
			t.Fatalf("metadata-bearing %s request used reserved lifecycle capacity", method)
		} else {
			assertRPCError(t, err, KindRateLimited)
		}
	}
	body, err := host.Call(context.Background(), "codex/health", map[string]any{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var health struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(body, &health); err != nil || health.Status != "ok" {
		t.Fatalf("health = %s, %v", body, err)
	}
	if _, err := host.Call(context.Background(), "codex/shutdown", map[string]any{}, nil); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-domain; err != nil {
		t.Fatal(err)
	}
}

func TestPeerBoundsLifecycleHandlersBehindBlockedWriter(t *testing.T) {
	for _, test := range []struct {
		name       string
		handlerErr error
	}{
		{name: "success"},
		{name: "failure", handlerErr: NewRPCError(JSONRPCApplication, KindUnavailable, "not ready", true, nil)},
	} {
		t.Run(test.name, func(t *testing.T) {
			inputReader, inputWriter := io.Pipe()
			output := newBlockingWriter()
			codec := newTestCodec(t, inputReader, output, DefaultLimits)
			invoked := make(chan struct{}, 3)
			peer, err := NewPeer(codec, PeerConfig{
				IDPrefix:            "bounded-control",
				MaxIncomingRequests: 1,
				RequireIncomingMeta: false,
				Handler: RequestHandlerFunc(func(_ context.Context, _ Request) (any, error) {
					invoked <- struct{}{}
					return map[string]any{"status": "ok"}, test.handlerErr
				}),
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := peer.Start(); err != nil {
				t.Fatal(err)
			}
			encoder := newTestCodec(t, strings.NewReader(""), inputWriter, DefaultLimits)
			var releaseOnce sync.Once
			releaseOutput := func() { releaseOnce.Do(func() { close(output.release) }) }
			t.Cleanup(func() {
				releaseOutput()
				_ = inputWriter.Close()
				_ = inputReader.Close()
				peer.Close()
			})

			writeHealth := func(id string) {
				t.Helper()
				if err := encoder.Write(context.Background(), map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"method":  "codex/health",
					"params":  map[string]any{},
				}); err != nil {
					t.Fatal(err)
				}
			}

			writeHealth("health-1")
			select {
			case <-output.entered:
			case <-time.After(2 * time.Second):
				t.Fatal("first lifecycle response did not block in writer")
			}
			writeHealth("health-2")
			waitFor(t, func() bool { return len(invoked) == 2 })
			writeHealth("health-3")
			waitFor(t, func() bool { return peer.Snapshot().RejectedIncoming == 1 })

			if got := len(invoked); got != 2 {
				t.Fatalf("blocked writer admitted %d lifecycle handlers, want 2", got)
			}
			if got := len(peer.controlInbound); got != 1 {
				t.Fatalf("reserved lifecycle admission usage = %d, want 1", got)
			}

			releaseOutput()
			waitFor(t, func() bool {
				return peer.Snapshot().ActiveIncoming == 0 && len(peer.controlInbound) == 0
			})
		})
	}
}

func TestPeerValidatesDomainMetadataAtBothEnds(t *testing.T) {
	t.Parallel()

	host, worker := newTestPeerPair(t,
		RequestHandlerFunc(func(_ context.Context, _ Request) (any, error) { return map[string]any{}, nil }),
		nil,
		nil,
		nil,
	)

	_, err := worker.Call(context.Background(), "host/data.get", map[string]any{}, nil)
	assertRPCError(t, err, KindInvalidRequest)

	stale := testMeta()
	stale.Generation = "old-generation"
	_, err = host.Call(context.Background(), "addon/service.call", map[string]any{}, stale)
	assertRPCError(t, err, KindStaleBinding)

	expired := testMeta()
	expired.Deadline = time.Now().Add(-time.Second)
	_, err = host.Call(context.Background(), "addon/service.call", map[string]any{}, expired)
	assertRPCError(t, err, KindDeadlineExceeded)
}

func TestPeerNormalizesUnknownRemoteErrorKind(t *testing.T) {
	t.Parallel()

	host, _ := newTestPeerPair(t, nil,
		RequestHandlerFunc(func(_ context.Context, _ Request) (any, error) {
			return nil, &RPCError{
				Code:    JSONRPCApplication,
				Message: "future failure",
				Data: &ErrorData{
					Kind:      "FUTURE_FAILURE",
					Message:   "future failure",
					Retryable: false,
				},
			}
		}),
		nil,
		nil,
	)
	_, err := host.Call(context.Background(), "addon/service.call", map[string]any{}, testMeta())
	var failure *RPCError
	if !errors.As(err, &failure) || failure.Data == nil {
		t.Fatalf("Call error = %T %v", err, err)
	}
	if failure.Data.Kind != KindInternal || failure.ReportedKind != "FUTURE_FAILURE" {
		t.Fatalf("normalized error = %+v", failure)
	}
}

func TestPeerTreatsRemoteErrorWithoutApplicationDataAsInternal(t *testing.T) {
	t.Parallel()

	host, _ := newTestPeerPair(t, nil,
		RequestHandlerFunc(func(_ context.Context, _ Request) (any, error) {
			return nil, &RPCError{Code: JSONRPCInternalError, Message: "legacy failure"}
		}),
		nil,
		nil,
	)
	_, err := host.Call(context.Background(), "addon/service.call", map[string]any{}, testMeta())
	assertRPCError(t, err, KindInternal)
}

func TestPeerFailsPendingCallsWhenTransportCloses(t *testing.T) {
	t.Parallel()

	handlerStarted := make(chan struct{})
	var workerConnection net.Conn
	host, _ := newTestPeerPairWithConnections(t, nil,
		RequestHandlerFunc(func(ctx context.Context, _ Request) (any, error) {
			close(handlerStarted)
			<-ctx.Done()
			return nil, ctx.Err()
		}),
		nil,
		nil,
		func(_ net.Conn, worker net.Conn) { workerConnection = worker },
	)
	result := make(chan error, 1)
	go func() {
		_, err := host.Call(context.Background(), "addon/service.call", map[string]any{}, testMeta())
		result <- err
	}()
	<-handlerStarted
	if err := workerConnection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil {
		t.Fatal("Call succeeded after transport close")
	}
	select {
	case <-host.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("host peer did not stop")
	}
}

func newTestPeerPair(
	t *testing.T,
	hostHandler RequestHandler,
	workerHandler RequestHandler,
	mutateHost func(*PeerConfig),
	mutateWorker func(*PeerConfig),
) (*Peer, *Peer) {
	t.Helper()
	return newTestPeerPairWithConnections(t, hostHandler, workerHandler, mutateHost, mutateWorker, nil)
}

func newTestPeerPairWithConnections(
	t *testing.T,
	hostHandler RequestHandler,
	workerHandler RequestHandler,
	mutateHost func(*PeerConfig),
	mutateWorker func(*PeerConfig),
	observe func(net.Conn, net.Conn),
) (*Peer, *Peer) {
	t.Helper()
	hostConnection, workerConnection := net.Pipe()
	if observe != nil {
		observe(hostConnection, workerConnection)
	}
	t.Cleanup(func() {
		_ = hostConnection.Close()
		_ = workerConnection.Close()
	})
	hostCodec := newTestCodec(t, hostConnection, hostConnection, DefaultLimits)
	workerCodec := newTestCodec(t, workerConnection, workerConnection, DefaultLimits)
	hostConfig := PeerConfig{
		IDPrefix:            "host",
		Generation:          "generation-42",
		MaxOutgoingRequests: 16,
		MaxIncomingRequests: 16,
		RequireIncomingMeta: true,
		Handler:             hostHandler,
	}
	workerConfig := PeerConfig{
		IDPrefix:            "worker",
		Generation:          "generation-42",
		MaxOutgoingRequests: 16,
		MaxIncomingRequests: 16,
		RequireIncomingMeta: true,
		Handler:             workerHandler,
	}
	if mutateHost != nil {
		mutateHost(&hostConfig)
	}
	if mutateWorker != nil {
		mutateWorker(&workerConfig)
	}
	host, err := NewPeer(hostCodec, hostConfig)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := NewPeer(workerCodec, workerConfig)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}
	return host, worker
}

func testMeta() *Meta {
	return &Meta{
		RequestID:     "request-1",
		CorrelationID: "correlation-1",
		Generation:    "generation-42",
		Deadline:      time.Now().Add(3 * time.Second),
		Actor:         &Actor{Role: "system"},
	}
}

func assertResultField(t *testing.T, outcome struct {
	body json.RawMessage
	err  error
}, field string, want string) {
	t.Helper()
	if outcome.err != nil {
		t.Fatal(outcome.err)
	}
	var result map[string]any
	if err := json.Unmarshal(outcome.body, &result); err != nil {
		t.Fatal(err)
	}
	if result[field] != want {
		t.Fatalf("result[%q] = %v, want %q", field, result[field], want)
	}
}

func assertRPCError(t *testing.T, err error, kind string) {
	t.Helper()
	var failure *RPCError
	if !errors.As(err, &failure) || failure.Data == nil {
		t.Fatalf("error = %T %v, want RPCError %s", err, err, kind)
	}
	if failure.Data.Kind != kind {
		t.Fatalf("error kind = %s, want %s: %v", failure.Data.Kind, kind, err)
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition was not met")
		}
		time.Sleep(time.Millisecond)
	}
}

type blockingWriter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func newBlockingWriter() *blockingWriter {
	return &blockingWriter{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (writer *blockingWriter) Write(body []byte) (int, error) {
	writer.once.Do(func() { close(writer.entered) })
	<-writer.release
	return len(body), nil
}
