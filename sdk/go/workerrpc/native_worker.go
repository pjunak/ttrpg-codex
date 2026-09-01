package workerrpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
)

const NativeWorkerProtocolVersion = "1.0.0"

type NativeWorkerAddon struct {
	ID         string `json:"id"`
	Version    string `json:"version"`
	Generation string `json:"generation"`
}

type NativeWorkerHost struct {
	Version  string `json:"version"`
	Locale   string `json:"locale"`
	TimeZone string `json:"timeZone"`
}

type NativeWorkerLimits struct {
	MaxFrameBytes         int `json:"maxFrameBytes"`
	MaxConcurrentRequests int `json:"maxConcurrentRequests"`
	DefaultDeadlineMS     int `json:"defaultDeadlineMs"`
}

type NativeWorkerInitialization struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Addon           NativeWorkerAddon  `json:"addon"`
	Host            NativeWorkerHost   `json:"host"`
	Grants          []json.RawMessage  `json:"grants"`
	Services        []json.RawMessage  `json:"services"`
	Limits          NativeWorkerLimits `json:"limits"`
}

type NativeWorkerHealth struct {
	Status  string         `json:"status"`
	Details map[string]any `json:"details,omitempty"`
}

type NativeWorkerContext struct {
	Initialization NativeWorkerInitialization
	Peer           *Peer
}

type NativeWorkerHandlerFactory interface {
	NewNativeWorkerHandler(NativeWorkerContext) (RequestHandler, error)
}

type NativeWorkerHandlerFactoryFunc func(NativeWorkerContext) (RequestHandler, error)

func (factory NativeWorkerHandlerFactoryFunc) NewNativeWorkerHandler(
	worker NativeWorkerContext,
) (RequestHandler, error) {
	return factory(worker)
}

type NativeWorkerConfig struct {
	Reader          io.Reader
	Writer          io.Writer
	TransportLimits Limits
	ProtocolVersion string
	Capabilities    []string
	Methods         map[string]string
	HandlerFactory  NativeWorkerHandlerFactory
	Start           func(context.Context, NativeWorkerContext) error
	Health          func(context.Context) (NativeWorkerHealth, error)
	OnTerminal      func(error)
}

// RunNativeWorker owns the protocol lifecycle for one native add-on process.
// It performs the serialized startup handshake, then hands the same codec to a
// concurrent Peer for domain calls and worker-to-host callbacks.
func RunNativeWorker(ctx context.Context, config NativeWorkerConfig) error {
	config, err := normalizeNativeWorkerConfig(config)
	if err != nil {
		return err
	}
	codec, err := NewCodec(config.Reader, config.Writer, config.TransportLimits)
	if err != nil {
		return err
	}
	initializeRequest, err := readNativeStartupRequest(ctx, codec, "codex/initialize")
	if err != nil {
		return err
	}
	var initialization NativeWorkerInitialization
	if err := decodeNativeWorkerExact(initializeRequest.Params, &initialization); err != nil ||
		!validNativeWorkerInitialization(initialization, config.ProtocolVersion) {
		failure := NewRPCError(JSONRPCInvalidParams, KindValidationFailed,
			"The native worker initialization request is invalid.", false, nil)
		_ = writeNativeWorkerFailure(ctx, codec, initializeRequest.ID, failure)
		return errors.New("native worker initialization request is invalid")
	}
	if initialization.Limits.MaxFrameBytes > config.TransportLimits.MaxFrameBytes {
		failure := NewRPCError(JSONRPCApplication, KindUnavailable,
			"The worker transport limit is smaller than the host requirement.", false, nil)
		_ = writeNativeWorkerFailure(ctx, codec, initializeRequest.ID, failure)
		return errors.New("native worker transport limit is too small")
	}

	shutdownComplete := make(chan struct{})
	lifecycle := &nativeWorkerLifecycle{
		health: config.Health, shutdownComplete: shutdownComplete,
	}
	peer, err := NewPeer(codec, PeerConfig{
		IDPrefix:            "worker-runtime",
		Generation:          initialization.Addon.Generation,
		MaxOutgoingRequests: initialization.Limits.MaxConcurrentRequests,
		MaxIncomingRequests: initialization.Limits.MaxConcurrentRequests,
		RequireIncomingMeta: false,
		Handler:             lifecycle,
		OnTerminal:          config.OnTerminal,
		OnResponseWritten:   lifecycle.responseWritten,
	})
	if err != nil {
		return failNativeInitialization(ctx, codec, initializeRequest.ID, err)
	}
	workerContext := NativeWorkerContext{
		Initialization: cloneNativeWorkerInitialization(initialization),
		Peer:           peer,
	}
	handler, err := config.HandlerFactory.NewNativeWorkerHandler(workerContext)
	if err != nil || handler == nil {
		if err == nil {
			err = errors.New("native worker handler factory returned nil")
		}
		return failNativeInitialization(ctx, codec, initializeRequest.ID, err)
	}
	lifecycle.handler = handler
	if err := writeNativeWorkerSuccess(ctx, codec, initializeRequest.ID, map[string]any{
		"protocolVersion": config.ProtocolVersion,
		"capabilities":    config.Capabilities,
		"methods":         config.Methods,
		"healthCheck":     true,
	}); err != nil {
		return err
	}

	startRequest, err := readNativeStartupRequest(ctx, codec, "codex/start")
	if err != nil {
		return err
	}
	if err := validateNativeEmptyParams(startRequest.Params); err != nil {
		return failNativeStartup(ctx, codec, startRequest.ID, err)
	}
	if config.Start != nil {
		if err := config.Start(ctx, workerContext); err != nil {
			return failNativeStartup(ctx, codec, startRequest.ID, err)
		}
	}
	if err := writeNativeWorkerSuccess(ctx, codec, startRequest.ID, map[string]any{"ready": true}); err != nil {
		return err
	}

	healthRequest, err := readNativeStartupRequest(ctx, codec, "codex/health")
	if err != nil {
		return err
	}
	if err := validateNativeEmptyParams(healthRequest.Params); err != nil {
		return failNativeStartup(ctx, codec, healthRequest.ID, err)
	}
	health, err := config.Health(ctx)
	if err != nil || !validNativeWorkerHealth(health) {
		if err == nil {
			err = errors.New("native worker returned invalid health")
		}
		return failNativeStartup(ctx, codec, healthRequest.ID, err)
	}
	if err := writeNativeWorkerSuccess(ctx, codec, healthRequest.ID, health); err != nil {
		return err
	}
	if err := peer.Start(); err != nil {
		return err
	}

	select {
	case <-shutdownComplete:
		peer.Close()
		return nil
	case <-peer.Done():
		return peer.Err()
	case <-ctx.Done():
		peer.Close()
		return ctx.Err()
	}
}

type nativeWorkerLifecycle struct {
	handler          RequestHandler
	health           func(context.Context) (NativeWorkerHealth, error)
	shutdownComplete chan struct{}
	shutdown         atomic.Bool
	shutdownOnce     sync.Once
}

func (lifecycle *nativeWorkerLifecycle) HandleRPC(
	ctx context.Context,
	request Request,
) (any, error) {
	switch request.Method {
	case "codex/health":
		if err := validateNativeEmptyParams(request.Params); err != nil {
			return nil, NewRPCError(JSONRPCInvalidParams, KindValidationFailed,
				"The health request is invalid.", false, nil)
		}
		health, err := lifecycle.health(ctx)
		if err != nil {
			return nil, err
		}
		if !validNativeWorkerHealth(health) {
			return nil, errors.New("native worker returned invalid health")
		}
		return health, nil
	case "codex/shutdown":
		if err := validateNativeEmptyParams(request.Params); err != nil {
			return nil, NewRPCError(JSONRPCInvalidParams, KindValidationFailed,
				"The shutdown request is invalid.", false, nil)
		}
		lifecycle.shutdown.Store(true)
		return map[string]any{}, nil
	default:
		if lifecycle.shutdown.Load() {
			return nil, NewRPCError(JSONRPCApplication, KindUnavailable,
				"The native worker is shutting down.", true, nil)
		}
		if request.Meta == nil {
			return nil, NewRPCError(JSONRPCInvalidRequest, KindInvalidRequest,
				"Native worker domain calls require request metadata.", false, nil)
		}
		return lifecycle.handler.HandleRPC(ctx, request)
	}
}

func (lifecycle *nativeWorkerLifecycle) responseWritten(request Request, err error) {
	if request.Method != "codex/shutdown" || err != nil || !lifecycle.shutdown.Load() {
		return
	}
	lifecycle.shutdownOnce.Do(func() { close(lifecycle.shutdownComplete) })
}

type nativeStartupRequest struct {
	ID     json.RawMessage
	Params json.RawMessage
}

func normalizeNativeWorkerConfig(config NativeWorkerConfig) (NativeWorkerConfig, error) {
	if config.Reader == nil || config.Writer == nil || config.HandlerFactory == nil {
		return NativeWorkerConfig{}, errors.New("native worker reader, writer, and handler factory are required")
	}
	if config.ProtocolVersion == "" {
		config.ProtocolVersion = NativeWorkerProtocolVersion
	}
	config.TransportLimits = normalizedLimits(config.TransportLimits)
	if config.Health == nil {
		config.Health = func(context.Context) (NativeWorkerHealth, error) {
			return NativeWorkerHealth{Status: "ok"}, nil
		}
	}
	capabilities := append([]string(nil), config.Capabilities...)
	if !slices.Contains(capabilities, "worker.health") {
		capabilities = append(capabilities, "worker.health")
	}
	slices.Sort(capabilities)
	for index, capability := range capabilities {
		if capability == "" || index > 0 && capability == capabilities[index-1] {
			return NativeWorkerConfig{}, errors.New("native worker capabilities must be non-empty and unique")
		}
	}
	methods := maps.Clone(config.Methods)
	if methods == nil {
		methods = make(map[string]string)
	}
	methods["codex/health"] = NativeWorkerProtocolVersion
	for method, version := range methods {
		if method == "" || len(method) > 200 || version == "" || len(version) > 50 ||
			strings.TrimSpace(method) != method || strings.TrimSpace(version) != version ||
			strings.IndexFunc(method+version, func(character rune) bool {
				return character < 0x20 || character == 0x7f
			}) >= 0 {
			return NativeWorkerConfig{}, errors.New("native worker methods require bounded names and versions")
		}
	}
	config.Capabilities = capabilities
	config.Methods = methods
	return config, nil
}

func readNativeStartupRequest(
	ctx context.Context,
	codec *Codec,
	expectedMethod string,
) (nativeStartupRequest, error) {
	message, err := codec.Read(ctx)
	if err != nil {
		return nativeStartupRequest{}, err
	}
	var request struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
		Meta    *Meta           `json:"meta,omitempty"`
	}
	if message.Kind != KindRequest || decodeNativeWorkerExact(message.Raw, &request) != nil ||
		request.JSONRPC != "2.0" || request.Method != expectedMethod || request.Meta != nil {
		return nativeStartupRequest{}, fmt.Errorf("native worker expected %s", expectedMethod)
	}
	return nativeStartupRequest{ID: append(json.RawMessage(nil), request.ID...), Params: append(json.RawMessage(nil), request.Params...)}, nil
}

func validNativeWorkerInitialization(
	initialization NativeWorkerInitialization,
	expectedProtocol string,
) bool {
	return initialization.ProtocolVersion == expectedProtocol &&
		initialization.Addon.ID != "" && initialization.Addon.Version != "" &&
		initialization.Addon.Generation != "" && initialization.Host.Version != "" &&
		initialization.Host.Locale != "" && initialization.Host.TimeZone != "" &&
		initialization.Grants != nil && initialization.Services != nil &&
		initialization.Limits.MaxFrameBytes > 0 &&
		initialization.Limits.MaxConcurrentRequests > 0 &&
		initialization.Limits.DefaultDeadlineMS > 0
}

func validNativeWorkerHealth(health NativeWorkerHealth) bool {
	if health.Status != "ok" && health.Status != "degraded" {
		return false
	}
	_, err := json.Marshal(health)
	return err == nil
}

func validateNativeEmptyParams(body json.RawMessage) error {
	var params map[string]json.RawMessage
	if err := decodeNativeWorkerExact(body, &params); err != nil {
		return err
	}
	if params == nil || len(params) != 0 {
		return errors.New("native worker lifecycle params must be an empty object")
	}
	return nil
}

func failNativeInitialization(
	ctx context.Context,
	codec *Codec,
	id json.RawMessage,
	cause error,
) error {
	failure := NewRPCError(JSONRPCInternalError, KindInternal,
		"The native worker could not initialize.", false, nil)
	_ = writeNativeWorkerFailure(ctx, codec, id, failure)
	return fmt.Errorf("initialize native worker: %w", cause)
}

func failNativeStartup(
	ctx context.Context,
	codec *Codec,
	id json.RawMessage,
	cause error,
) error {
	failure := NewRPCError(JSONRPCApplication, KindUnavailable,
		"The native worker could not start.", false, nil)
	_ = writeNativeWorkerFailure(ctx, codec, id, failure)
	return fmt.Errorf("start native worker: %w", cause)
}

func writeNativeWorkerSuccess(
	ctx context.Context,
	codec *Codec,
	id json.RawMessage,
	result any,
) error {
	return codec.Write(ctx, map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(id), "result": result,
	})
}

func writeNativeWorkerFailure(
	ctx context.Context,
	codec *Codec,
	id json.RawMessage,
	failure *RPCError,
) error {
	return codec.Write(ctx, map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(id), "error": failure,
	})
}

func cloneNativeWorkerInitialization(value NativeWorkerInitialization) NativeWorkerInitialization {
	value.Grants = cloneNativeRawList(value.Grants)
	value.Services = cloneNativeRawList(value.Services)
	return value
}

func cloneNativeRawList(values []json.RawMessage) []json.RawMessage {
	result := make([]json.RawMessage, len(values))
	for index, value := range values {
		result[index] = append(json.RawMessage(nil), value...)
	}
	return result
}

func decodeNativeWorkerExact(body json.RawMessage, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains more than one value")
	}
	return nil
}

var _ RequestHandler = (*nativeWorkerLifecycle)(nil)
