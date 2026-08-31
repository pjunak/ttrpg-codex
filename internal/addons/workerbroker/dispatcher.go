package workerbroker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"runtime/debug"
	"sync"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/requestcontext"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

var (
	hostMethodPattern = regexp.MustCompile(`^host/[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`)
	permissionPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$`)
)

type ValidateFunc func(json.RawMessage) error

type Invocation struct {
	AddonID    string
	Generation string
	Method     string
	Permission string
	Params     json.RawMessage
	WireMeta   workerrpc.Meta
	Authority  Authority
}

type Authority = requestcontext.Authority
type ContextRequest = requestcontext.ResolveRequest
type ContextResolver = requestcontext.Resolver
type ContextResolverFunc = requestcontext.ResolverFunc

type Authorizer interface {
	Authorize(context.Context, Invocation) error
}

type AuthorizerFunc func(context.Context, Invocation) error

func (authorize AuthorizerFunc) Authorize(ctx context.Context, invocation Invocation) error {
	return authorize(ctx, invocation)
}

type HandlerFunc func(context.Context, Invocation) (any, error)

type Method struct {
	Name             string
	Permission       string
	ValidateRequest  ValidateFunc
	ValidateResponse ValidateFunc
	Handle           HandlerFunc
}

type Config struct {
	AddonID         string
	Generation      string
	ContextResolver ContextResolver
	Authorizer      Authorizer
	Methods         []Method
	OnInternalError func(Invocation, error)
}

type Snapshot struct {
	Calls       uint64            `json:"calls"`
	InFlight    int               `json:"inFlight"`
	Succeeded   uint64            `json:"succeeded"`
	ByErrorKind map[string]uint64 `json:"byErrorKind"`
}

type Dispatcher struct {
	config  Config
	methods map[string]Method

	mu       sync.Mutex
	snapshot Snapshot
}

func New(config Config) (*Dispatcher, error) {
	if config.AddonID == "" || config.Generation == "" {
		return nil, errors.New("worker broker add-on ID and generation are required")
	}
	if config.Authorizer == nil {
		return nil, errors.New("worker broker authorizer is required")
	}
	if config.ContextResolver == nil {
		return nil, errors.New("worker broker context resolver is required")
	}
	methods := make(map[string]Method, len(config.Methods))
	for _, method := range config.Methods {
		if !hostMethodPattern.MatchString(method.Name) {
			return nil, fmt.Errorf("invalid worker host method %q", method.Name)
		}
		if !permissionPattern.MatchString(method.Permission) {
			return nil, fmt.Errorf("invalid permission %q for %s", method.Permission, method.Name)
		}
		if method.ValidateRequest == nil || method.ValidateResponse == nil || method.Handle == nil {
			return nil, fmt.Errorf("worker host method %s requires request validation, response validation, and a handler", method.Name)
		}
		if _, exists := methods[method.Name]; exists {
			return nil, fmt.Errorf("duplicate worker host method %q", method.Name)
		}
		methods[method.Name] = method
	}
	config.Methods = nil
	return &Dispatcher{
		config:  config,
		methods: methods,
		snapshot: Snapshot{
			ByErrorKind: make(map[string]uint64),
		},
	}, nil
}

func (dispatcher *Dispatcher) HandleRPC(ctx context.Context, request workerrpc.Request) (result any, responseErr error) {
	dispatcher.beginCall()
	var invocation Invocation
	defer func() {
		if recovered := recover(); recovered != nil {
			failure := fmt.Errorf("worker host method panic: %v\n%s", recovered, debug.Stack())
			dispatcher.reportInternal(invocation, failure)
			result = nil
			responseErr = workerrpc.NewRPCError(workerrpc.JSONRPCInternalError, workerrpc.KindInternal, "The host method failed internally.", false, nil)
		}
		dispatcher.finishCall(responseErr)
	}()

	method, exists := dispatcher.methods[request.Method]
	if !exists {
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCMethodNotFound, workerrpc.KindNotFound, "The requested host method is not available.", false, nil)
	}
	if request.Meta == nil || request.Meta.Generation != dispatcher.config.Generation {
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnauthorized, "The worker generation is not authorized.", false, nil)
	}
	invocation = Invocation{
		AddonID:    dispatcher.config.AddonID,
		Generation: dispatcher.config.Generation,
		Method:     method.Name,
		Permission: method.Permission,
		Params:     cloneRaw(request.Params),
		WireMeta:   cloneMeta(*request.Meta),
	}
	if err := ctx.Err(); err != nil {
		return nil, workerrpc.ErrorFromContext(err)
	}
	if err := method.ValidateRequest(cloneRaw(invocation.Params)); err != nil {
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCInvalidParams, workerrpc.KindValidationFailed, "The host method request did not match its schema.", false, nil)
	}
	authority, err := dispatcher.config.ContextResolver.ResolveContext(ctx, ContextRequest{
		AddonID:    invocation.AddonID,
		Generation: invocation.Generation,
		Method:     invocation.Method,
		WireMeta:   cloneMeta(invocation.WireMeta),
	})
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, workerrpc.ErrorFromContext(ctxErr)
		}
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnauthorized, "The worker request context is not authorized.", false, nil)
	}
	if authority.RequestID == "" || authority.CorrelationID == "" || authority.Deadline.IsZero() ||
		(authority.Actor.Role != "dm" && authority.Actor.Role != "player" && authority.Actor.Role != "system") {
		dispatcher.reportInternal(invocation, errors.New("context resolver returned incomplete or invalid authority"))
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCInternalError, workerrpc.KindInternal, "The host request context is invalid.", false, nil)
	}
	invocation.Authority = cloneAuthority(authority)
	if !authority.Deadline.After(time.Now()) {
		return nil, workerrpc.ErrorFromContext(context.DeadlineExceeded)
	}
	authorizedCtx, cancel := context.WithDeadline(ctx, authority.Deadline)
	defer cancel()
	ctx = authorizedCtx
	if err := dispatcher.config.Authorizer.Authorize(ctx, cloneInvocation(invocation)); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, workerrpc.ErrorFromContext(ctxErr)
		}
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnauthorized, "The worker is not authorized for this host operation.", false, nil)
	}
	value, err := method.Handle(ctx, cloneInvocation(invocation))
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, workerrpc.ErrorFromContext(ctxErr)
		}
		var failure *workerrpc.RPCError
		if errors.As(err, &failure) {
			return nil, failure
		}
		dispatcher.reportInternal(invocation, err)
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCInternalError, workerrpc.KindInternal, "The host method failed internally.", false, nil)
	}
	if err := ctx.Err(); err != nil {
		return nil, workerrpc.ErrorFromContext(err)
	}
	body, err := json.Marshal(value)
	if err != nil {
		dispatcher.reportInternal(invocation, fmt.Errorf("encode host method response: %w", err))
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCInternalError, workerrpc.KindInternal, "The host method returned an invalid response.", false, nil)
	}
	if err := method.ValidateResponse(body); err != nil {
		dispatcher.reportInternal(invocation, fmt.Errorf("validate host method response: %w", err))
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCInternalError, workerrpc.KindInternal, "The host method returned an invalid response.", false, nil)
	}
	return json.RawMessage(body), nil
}

func (dispatcher *Dispatcher) Snapshot() Snapshot {
	dispatcher.mu.Lock()
	defer dispatcher.mu.Unlock()
	snapshot := dispatcher.snapshot
	snapshot.ByErrorKind = make(map[string]uint64, len(dispatcher.snapshot.ByErrorKind))
	for kind, count := range dispatcher.snapshot.ByErrorKind {
		snapshot.ByErrorKind[kind] = count
	}
	return snapshot
}

func (dispatcher *Dispatcher) beginCall() {
	dispatcher.mu.Lock()
	defer dispatcher.mu.Unlock()
	dispatcher.snapshot.Calls++
	dispatcher.snapshot.InFlight++
}

func (dispatcher *Dispatcher) finishCall(err error) {
	dispatcher.mu.Lock()
	defer dispatcher.mu.Unlock()
	dispatcher.snapshot.InFlight--
	if err == nil {
		dispatcher.snapshot.Succeeded++
		return
	}
	kind := workerrpc.KindInternal
	var failure *workerrpc.RPCError
	if errors.As(err, &failure) && failure.Data != nil {
		kind = failure.Data.Kind
	}
	dispatcher.snapshot.ByErrorKind[kind]++
}

func (dispatcher *Dispatcher) reportInternal(invocation Invocation, err error) {
	if dispatcher.config.OnInternalError != nil {
		func() {
			defer func() { _ = recover() }()
			dispatcher.config.OnInternalError(cloneInvocation(invocation), err)
		}()
	}
}

func cloneInvocation(invocation Invocation) Invocation {
	invocation.Params = cloneRaw(invocation.Params)
	invocation.WireMeta = cloneMeta(invocation.WireMeta)
	invocation.Authority = cloneAuthority(invocation.Authority)
	return invocation
}

func cloneAuthority(authority Authority) Authority {
	authority.Actor = workerrpc.Actor{Role: authority.Actor.Role, ID: authority.Actor.ID}
	return authority
}

func cloneMeta(meta workerrpc.Meta) workerrpc.Meta {
	if meta.Actor != nil {
		actor := *meta.Actor
		meta.Actor = &actor
	}
	return meta
}

func cloneRaw(value json.RawMessage) json.RawMessage {
	return append(json.RawMessage(nil), value...)
}

var _ workerrpc.RequestHandler = (*Dispatcher)(nil)
