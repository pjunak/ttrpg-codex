package workerrpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

var ErrPeerClosed = errors.New("worker RPC peer is closed")

type Actor struct {
	Role string `json:"role"`
	ID   string `json:"id,omitempty"`
}

type Meta struct {
	RequestID      string    `json:"requestId"`
	CorrelationID  string    `json:"correlationId"`
	Generation     string    `json:"generation"`
	Deadline       time.Time `json:"deadline"`
	Actor          *Actor    `json:"actor,omitempty"`
	IdempotencyKey string    `json:"idempotencyKey,omitempty"`
	Traceparent    string    `json:"traceparent,omitempty"`
}

type Request struct {
	ID     json.RawMessage
	Method string
	Params json.RawMessage
	Meta   *Meta
}

type RequestHandler interface {
	HandleRPC(context.Context, Request) (any, error)
}

type RequestHandlerFunc func(context.Context, Request) (any, error)

func (handler RequestHandlerFunc) HandleRPC(ctx context.Context, request Request) (any, error) {
	return handler(ctx, request)
}

type PeerConfig struct {
	IDPrefix            string
	Generation          string
	MaxOutgoingRequests int
	MaxIncomingRequests int
	RequireIncomingMeta bool
	Handler             RequestHandler
	OnTerminal          func(error)
}

type PeerSnapshot struct {
	Started              bool   `json:"started"`
	Closed               bool   `json:"closed"`
	LastError            string `json:"lastError,omitempty"`
	PendingOutgoing      int    `json:"pendingOutgoing"`
	ActiveIncoming       int    `json:"activeIncoming"`
	OutgoingCalls        uint64 `json:"outgoingCalls"`
	IncomingCalls        uint64 `json:"incomingCalls"`
	CancelledOutgoing    uint64 `json:"cancelledOutgoing"`
	CancelledIncoming    uint64 `json:"cancelledIncoming"`
	RejectedIncoming     uint64 `json:"rejectedIncoming"`
	LateResponses        uint64 `json:"lateResponses"`
	IgnoredNotifications uint64 `json:"ignoredNotifications"`
}

type pendingResponse struct {
	result json.RawMessage
	err    error
}

type Peer struct {
	codec  *Codec
	config PeerConfig

	mu       sync.Mutex
	started  bool
	closed   bool
	lastErr  error
	nextID   uint64
	pending  map[string]chan pendingResponse
	incoming map[string]context.CancelFunc
	done     chan struct{}
	stopOnce sync.Once

	outgoing chan struct{}
	inbound  chan struct{}
	stats    PeerSnapshot
}

func NewPeer(codec *Codec, config PeerConfig) (*Peer, error) {
	if codec == nil {
		return nil, errors.New("worker RPC codec is required")
	}
	if config.IDPrefix == "" {
		config.IDPrefix = "peer"
	}
	if len(config.IDPrefix) > 100 {
		return nil, errors.New("worker RPC peer ID prefix is too long")
	}
	if config.MaxOutgoingRequests <= 0 {
		config.MaxOutgoingRequests = 16
	}
	if config.MaxIncomingRequests <= 0 {
		config.MaxIncomingRequests = 16
	}
	return &Peer{
		codec:    codec,
		config:   config,
		pending:  make(map[string]chan pendingResponse),
		incoming: make(map[string]context.CancelFunc),
		done:     make(chan struct{}),
		outgoing: make(chan struct{}, config.MaxOutgoingRequests),
		inbound:  make(chan struct{}, config.MaxIncomingRequests),
	}, nil
}

func (peer *Peer) Start() error {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if peer.closed {
		return ErrPeerClosed
	}
	if peer.started {
		return errors.New("worker RPC peer already started")
	}
	peer.started = true
	peer.stats.Started = true
	go peer.readLoop()
	return nil
}

// Call sends one request and waits for its correlated response. A non-nil
// Meta marks a domain request and is checked before anything is written.
func (peer *Peer) Call(ctx context.Context, method string, params any, meta *Meta) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	callCtx, cancel, err := peer.callContext(ctx, meta)
	if err != nil {
		return nil, err
	}
	defer cancel()
	select {
	case peer.outgoing <- struct{}{}:
		defer func() { <-peer.outgoing }()
	default:
		return nil, NewRPCError(JSONRPCApplication, KindRateLimited, "The peer outgoing request limit was reached.", true, nil)
	}

	id, key, response, err := peer.registerCall()
	if err != nil {
		return nil, err
	}
	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
	}
	if params != nil {
		request["params"] = params
	}
	if meta != nil {
		request["meta"] = meta
	}
	if err := peer.codec.Write(callCtx, request); err != nil {
		peer.removePending(key)
		if !isLocalWriteFailure(err) {
			peer.stop(err)
		}
		return nil, err
	}

	select {
	case value := <-response:
		return value.result, value.err
	case <-callCtx.Done():
		select {
		case value := <-response:
			return value.result, value.err
		default:
		}
		if peer.removePending(key) {
			peer.increment(func(stats *PeerSnapshot) { stats.CancelledOutgoing++ })
			go peer.sendCancellation(id)
			return nil, callCtx.Err()
		}
		value := <-response
		return value.result, value.err
	}
}

func (peer *Peer) Done() <-chan struct{} {
	return peer.done
}

func (peer *Peer) Err() error {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return peer.lastErr
}

// Close stops logical routing. The owner of the underlying streams must close
// them separately when it needs to unblock the reader at the operating-system
// boundary.
func (peer *Peer) Close() {
	peer.stop(ErrPeerClosed)
}

func (peer *Peer) CancelIncoming() {
	peer.mu.Lock()
	cancellations := make([]context.CancelFunc, 0, len(peer.incoming))
	for _, cancel := range peer.incoming {
		cancellations = append(cancellations, cancel)
	}
	peer.mu.Unlock()
	for _, cancel := range cancellations {
		cancel()
	}
}

func (peer *Peer) Snapshot() PeerSnapshot {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	snapshot := peer.stats
	snapshot.Started = peer.started
	snapshot.Closed = peer.closed
	snapshot.PendingOutgoing = len(peer.pending)
	snapshot.ActiveIncoming = len(peer.incoming)
	if peer.lastErr != nil {
		snapshot.LastError = peer.lastErr.Error()
	}
	return snapshot
}

func (peer *Peer) callContext(ctx context.Context, meta *Meta) (context.Context, context.CancelFunc, error) {
	if meta == nil {
		callCtx, cancel := context.WithCancel(ctx)
		return callCtx, cancel, nil
	}
	if meta.RequestID == "" || meta.CorrelationID == "" || meta.Generation == "" || meta.Deadline.IsZero() {
		return nil, nil, NewRPCError(JSONRPCInvalidRequest, KindInvalidRequest, "Domain request metadata is incomplete.", false, nil)
	}
	if peer.config.Generation != "" && meta.Generation != peer.config.Generation {
		return nil, nil, NewRPCError(JSONRPCApplication, KindStaleBinding, "The request targets a stale worker generation.", false, nil)
	}
	if !meta.Deadline.After(time.Now()) {
		return nil, nil, ErrorFromContext(context.DeadlineExceeded)
	}
	callCtx, cancel := context.WithDeadline(ctx, meta.Deadline)
	return callCtx, cancel, nil
}

func (peer *Peer) registerCall() (string, string, chan pendingResponse, error) {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if !peer.started {
		return "", "", nil, errors.New("worker RPC peer is not started")
	}
	if peer.closed {
		return "", "", nil, peer.closedErrorLocked()
	}
	peer.nextID++
	id := fmt.Sprintf("%s-%d", peer.config.IDPrefix, peer.nextID)
	key := "s:" + id
	response := make(chan pendingResponse, 1)
	peer.pending[key] = response
	peer.stats.OutgoingCalls++
	return id, key, response, nil
}

func (peer *Peer) removePending(key string) bool {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if _, exists := peer.pending[key]; !exists {
		return false
	}
	delete(peer.pending, key)
	return true
}

func (peer *Peer) readLoop() {
	for {
		message, err := peer.codec.Read(context.Background())
		if err != nil {
			peer.stop(err)
			return
		}
		switch message.Kind {
		case KindSuccess, KindFailure:
			if err := peer.routeResponse(message); err != nil {
				peer.stop(err)
				return
			}
		case KindRequest:
			peer.routeRequest(message)
		case KindNotification:
			peer.routeNotification(message)
		}
	}
}

func (peer *Peer) routeResponse(message Message) error {
	var envelope struct {
		ID     json.RawMessage `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *RPCError       `json:"error"`
	}
	if err := json.Unmarshal(message.Raw, &envelope); err != nil {
		return fmt.Errorf("decode worker response: %w", err)
	}
	key, err := rpcIDKey(envelope.ID)
	if err != nil {
		return err
	}
	peer.mu.Lock()
	response := peer.pending[key]
	if response != nil {
		delete(peer.pending, key)
	} else {
		peer.stats.LateResponses++
	}
	peer.mu.Unlock()
	if response == nil {
		return nil
	}
	if envelope.Error != nil {
		response <- pendingResponse{err: normalizeRemoteError(envelope.Error)}
	} else {
		response <- pendingResponse{result: envelope.Result}
	}
	return nil
}

func (peer *Peer) routeRequest(message Message) {
	var envelope struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
		Meta   *Meta           `json:"meta"`
	}
	if err := json.Unmarshal(message.Raw, &envelope); err != nil {
		peer.stop(fmt.Errorf("decode worker request: %w", err))
		return
	}
	key, err := rpcIDKey(envelope.ID)
	if err != nil {
		peer.stop(err)
		return
	}
	select {
	case peer.inbound <- struct{}{}:
	default:
		peer.increment(func(stats *PeerSnapshot) { stats.RejectedIncoming++ })
		peer.writeFailure(envelope.ID, NewRPCError(JSONRPCApplication, KindRateLimited, "The host call concurrency limit was reached.", true, nil))
		return
	}

	ctx, cancel, failure := peer.incomingContext(envelope.Meta)
	if failure != nil {
		<-peer.inbound
		peer.writeFailure(envelope.ID, failure)
		return
	}
	peer.mu.Lock()
	if _, duplicate := peer.incoming[key]; duplicate {
		peer.mu.Unlock()
		cancel()
		<-peer.inbound
		peer.writeFailure(envelope.ID, NewRPCError(JSONRPCInvalidRequest, KindConflict, "The worker reused an active request ID.", false, nil))
		return
	}
	peer.incoming[key] = cancel
	peer.stats.IncomingCalls++
	peer.mu.Unlock()

	request := Request{ID: envelope.ID, Method: envelope.Method, Params: envelope.Params, Meta: envelope.Meta}
	go peer.handleRequest(ctx, key, cancel, request)
}

func (peer *Peer) incomingContext(meta *Meta) (context.Context, context.CancelFunc, *RPCError) {
	if meta == nil {
		if peer.config.RequireIncomingMeta {
			return nil, nil, NewRPCError(JSONRPCInvalidRequest, KindInvalidRequest, "Worker host calls require request metadata.", false, nil)
		}
		ctx, cancel := context.WithCancel(context.Background())
		return ctx, cancel, nil
	}
	if meta.RequestID == "" || meta.CorrelationID == "" || meta.Generation == "" || meta.Deadline.IsZero() {
		return nil, nil, NewRPCError(JSONRPCInvalidRequest, KindInvalidRequest, "Worker host call metadata is incomplete.", false, nil)
	}
	if peer.config.Generation != "" && meta.Generation != peer.config.Generation {
		return nil, nil, NewRPCError(JSONRPCApplication, KindUnauthorized, "The worker generation does not match the active generation.", false, nil)
	}
	if !meta.Deadline.After(time.Now()) {
		return nil, nil, ErrorFromContext(context.DeadlineExceeded)
	}
	ctx, cancel := context.WithDeadline(context.Background(), meta.Deadline)
	return ctx, cancel, nil
}

func (peer *Peer) handleRequest(ctx context.Context, key string, cancel context.CancelFunc, request Request) {
	defer func() {
		cancel()
		peer.mu.Lock()
		delete(peer.incoming, key)
		peer.mu.Unlock()
		<-peer.inbound
	}()

	var result any
	var err error
	if peer.config.Handler == nil {
		err = NewRPCError(JSONRPCMethodNotFound, KindNotFound, "The host method is not available.", false, nil)
	} else {
		result, err = peer.config.Handler.HandleRPC(ctx, request)
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		err = ErrorFromContext(ctxErr)
	}
	if err != nil {
		var failure *RPCError
		if !errors.As(err, &failure) {
			failure = ErrorFromContext(err)
		}
		peer.writeFailure(request.ID, failure)
		return
	}
	if writeErr := peer.codec.Write(context.Background(), map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(request.ID),
		"result":  result,
	}); writeErr != nil {
		peer.stop(writeErr)
	}
}

func (peer *Peer) routeNotification(message Message) {
	method, _ := message.Value["method"].(string)
	if method != "$/cancelRequest" {
		peer.increment(func(stats *PeerSnapshot) { stats.IgnoredNotifications++ })
		return
	}
	var envelope struct {
		Params struct {
			ID json.RawMessage `json:"id"`
		} `json:"params"`
	}
	if err := json.Unmarshal(message.Raw, &envelope); err != nil {
		peer.increment(func(stats *PeerSnapshot) { stats.IgnoredNotifications++ })
		return
	}
	key, err := rpcIDKey(envelope.Params.ID)
	if err != nil {
		peer.increment(func(stats *PeerSnapshot) { stats.IgnoredNotifications++ })
		return
	}
	peer.mu.Lock()
	cancel := peer.incoming[key]
	if cancel != nil {
		peer.stats.CancelledIncoming++
	}
	peer.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (peer *Peer) sendCancellation(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := peer.codec.Write(ctx, map[string]any{
		"jsonrpc": "2.0",
		"method":  "$/cancelRequest",
		"params":  map[string]any{"id": id},
	}); err != nil && !isLocalWriteFailure(err) {
		peer.stop(err)
	}
}

func (peer *Peer) writeFailure(id json.RawMessage, failure *RPCError) {
	if failure == nil {
		failure = NewRPCError(JSONRPCInternalError, KindInternal, "The worker RPC operation failed.", false, nil)
	}
	if err := peer.codec.Write(context.Background(), map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(id),
		"error":   failure,
	}); err != nil {
		peer.stop(err)
	}
}

func (peer *Peer) stop(cause error) {
	if cause == nil {
		cause = ErrPeerClosed
	}
	peer.stopOnce.Do(func() {
		peer.mu.Lock()
		peer.closed = true
		peer.stats.Closed = true
		peer.lastErr = cause
		pending := make([]chan pendingResponse, 0, len(peer.pending))
		for _, response := range peer.pending {
			pending = append(pending, response)
		}
		peer.pending = make(map[string]chan pendingResponse)
		cancellations := make([]context.CancelFunc, 0, len(peer.incoming))
		for _, cancel := range peer.incoming {
			cancellations = append(cancellations, cancel)
		}
		close(peer.done)
		peer.mu.Unlock()
		for _, cancel := range cancellations {
			cancel()
		}
		for _, response := range pending {
			response <- pendingResponse{err: cause}
		}
		if peer.config.OnTerminal != nil {
			peer.config.OnTerminal(cause)
		}
	})
}

func (peer *Peer) closedErrorLocked() error {
	if peer.lastErr != nil {
		return peer.lastErr
	}
	return ErrPeerClosed
}

func (peer *Peer) increment(update func(*PeerSnapshot)) {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	update(&peer.stats)
}

func rpcIDKey(raw json.RawMessage) (string, error) {
	var stringID string
	if err := json.Unmarshal(raw, &stringID); err == nil && stringID != "" {
		return "s:" + stringID, nil
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err == nil && number.String() != "" {
		return "n:" + number.String(), nil
	}
	return "", errors.New("worker RPC response has an invalid or null ID")
}

func isLocalWriteFailure(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var protocol *ProtocolError
	return errors.As(err, &protocol)
}
