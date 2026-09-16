package requestcontext

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"
	"unicode"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

var (
	ErrCapacity       = errors.New("request context registry capacity reached")
	ErrInvalidContext = errors.New("invalid request context")
	ErrUnknownContext = errors.New("unknown request context")
	ErrExpiredContext = errors.New("request context expired")
)

var (
	addonIDPattern     = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
	traceparentPattern = regexp.MustCompile(`^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`)
)

type Authority struct {
	ReadOnly       bool
	RequestID      string
	CorrelationID  string
	Deadline       time.Time
	Actor          workerrpc.Actor
	IdempotencyKey string
	Traceparent    string
}

type ResolveRequest struct {
	AddonID    string
	Generation string
	Method     string
	WireMeta   workerrpc.Meta
}

type Resolver interface {
	ResolveContext(context.Context, ResolveRequest) (Authority, error)
}

type ResolverFunc func(context.Context, ResolveRequest) (Authority, error)

func (resolve ResolverFunc) ResolveContext(ctx context.Context, request ResolveRequest) (Authority, error) {
	return resolve(ctx, request)
}

type Config struct {
	MaxActive   int
	MaxLifetime time.Duration
	Now         func() time.Time
	GenerateID  func() (string, error)
}

type IssueRequest struct {
	ReadOnly       bool
	AddonID        string
	Generation     string
	CorrelationID  string
	Deadline       time.Time
	Actor          workerrpc.Actor
	IdempotencyKey string
	Traceparent    string
}

type Snapshot struct {
	Active      int    `json:"active"`
	Issued      uint64 `json:"issued"`
	Resolved    uint64 `json:"resolved"`
	Rejected    uint64 `json:"rejected"`
	Expired     uint64 `json:"expired"`
	Invalidated uint64 `json:"invalidated"`
}

type entry struct {
	addonID    string
	generation string
	authority  Authority
}

type entryKey struct {
	addonID    string
	generation string
	requestID  string
}

type Registry struct {
	maxActive   int
	maxLifetime time.Duration
	now         func() time.Time
	generateID  func() (string, error)

	mu      sync.Mutex
	entries map[entryKey]entry
	stats   Snapshot
}

type Lease struct {
	registry *Registry
	key      entryKey
	meta     workerrpc.Meta
	once     sync.Once
}

func New(config Config) (*Registry, error) {
	if config.MaxActive <= 0 {
		config.MaxActive = 256
	}
	if config.MaxLifetime <= 0 {
		config.MaxLifetime = 5 * time.Minute
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.GenerateID == nil {
		config.GenerateID = randomID
	}
	return &Registry{
		maxActive:   config.MaxActive,
		maxLifetime: config.MaxLifetime,
		now:         config.Now,
		generateID:  config.GenerateID,
		entries:     make(map[entryKey]entry),
	}, nil
}

func (registry *Registry) Issue(request IssueRequest) (*Lease, error) {
	if registry == nil {
		return nil, fmt.Errorf("%w: registry is required", ErrInvalidContext)
	}
	now := registry.now().UTC()
	request.Deadline = request.Deadline.UTC()
	if !validAddonID(request.AddonID) || !validIdentifier(request.Generation, 200, true) || request.Deadline.IsZero() ||
		!request.Deadline.After(now) || request.Deadline.After(now.Add(registry.maxLifetime)) ||
		!validActor(request.Actor) || !validIdentifier(request.IdempotencyKey, 200, false) ||
		(request.Traceparent != "" && !traceparentPattern.MatchString(request.Traceparent)) {
		return nil, ErrInvalidContext
	}
	requestID, err := registry.generateID()
	if err != nil {
		return nil, fmt.Errorf("generate request context ID: %w", err)
	}
	if !validIdentifier(requestID, 200, true) {
		return nil, fmt.Errorf("%w: generated request ID is empty", ErrInvalidContext)
	}
	correlationID := request.CorrelationID
	if correlationID == "" {
		correlationID = requestID
	}
	if !validIdentifier(correlationID, 200, true) {
		return nil, ErrInvalidContext
	}
	authority := Authority{
		ReadOnly:       request.ReadOnly,
		RequestID:      requestID,
		CorrelationID:  correlationID,
		Deadline:       request.Deadline,
		Actor:          request.Actor,
		IdempotencyKey: request.IdempotencyKey,
		Traceparent:    request.Traceparent,
	}
	key := contextKey(request.AddonID, request.Generation, requestID)

	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.pruneExpiredLocked(now)
	if len(registry.entries) >= registry.maxActive {
		registry.stats.Rejected++
		return nil, ErrCapacity
	}
	if _, exists := registry.entries[key]; exists {
		registry.stats.Rejected++
		return nil, fmt.Errorf("%w: duplicate request ID", ErrInvalidContext)
	}
	registry.entries[key] = entry{
		addonID:    request.AddonID,
		generation: request.Generation,
		authority:  authority,
	}
	registry.stats.Issued++
	return &Lease{
		registry: registry,
		key:      key,
		meta:     metaFromAuthority(authority, request.Generation),
	}, nil
}

func (registry *Registry) ResolveContext(ctx context.Context, request ResolveRequest) (Authority, error) {
	if err := ctx.Err(); err != nil {
		return Authority{}, err
	}
	if registry == nil || request.AddonID == "" || request.Generation == "" || request.WireMeta.RequestID == "" {
		return Authority{}, ErrInvalidContext
	}
	now := registry.now().UTC()
	key := contextKey(request.AddonID, request.Generation, request.WireMeta.RequestID)

	registry.mu.Lock()
	defer registry.mu.Unlock()
	value, exists := registry.entries[key]
	if !exists {
		registry.stats.Rejected++
		return Authority{}, ErrUnknownContext
	}
	if !value.authority.Deadline.After(now) {
		delete(registry.entries, key)
		registry.stats.Expired++
		registry.stats.Rejected++
		return Authority{}, ErrExpiredContext
	}
	if request.WireMeta.CorrelationID != value.authority.CorrelationID ||
		!request.WireMeta.Deadline.Equal(value.authority.Deadline) ||
		request.WireMeta.Generation != value.generation ||
		request.WireMeta.IdempotencyKey != value.authority.IdempotencyKey ||
		request.WireMeta.Traceparent != value.authority.Traceparent {
		registry.stats.Rejected++
		return Authority{}, ErrInvalidContext
	}
	registry.stats.Resolved++
	return cloneAuthority(value.authority), nil
}

func (registry *Registry) InvalidateGeneration(addonID, generation string) int {
	if registry == nil || addonID == "" || generation == "" {
		return 0
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	removed := 0
	for key, value := range registry.entries {
		if value.addonID == addonID && value.generation == generation {
			delete(registry.entries, key)
			removed++
		}
	}
	registry.stats.Invalidated += uint64(removed)
	return removed
}

func (registry *Registry) Snapshot() Snapshot {
	if registry == nil {
		return Snapshot{}
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.pruneExpiredLocked(registry.now().UTC())
	value := registry.stats
	value.Active = len(registry.entries)
	return value
}

func (lease *Lease) Meta() workerrpc.Meta {
	if lease == nil {
		return workerrpc.Meta{}
	}
	value := lease.meta
	if value.Actor != nil {
		actor := *value.Actor
		value.Actor = &actor
	}
	return value
}

func (lease *Lease) Close() error {
	if lease == nil || lease.registry == nil {
		return nil
	}
	lease.once.Do(func() {
		lease.registry.mu.Lock()
		delete(lease.registry.entries, lease.key)
		lease.registry.mu.Unlock()
	})
	return nil
}

func (registry *Registry) pruneExpiredLocked(now time.Time) {
	for key, value := range registry.entries {
		if !value.authority.Deadline.After(now) {
			delete(registry.entries, key)
			registry.stats.Expired++
		}
	}
}

func validActor(actor workerrpc.Actor) bool {
	if actor.Role != "dm" && actor.Role != "player" && actor.Role != "system" {
		return false
	}
	return validIdentifier(actor.ID, 200, false)
}

func validAddonID(value string) bool {
	return len(value) <= 80 && addonIDPattern.MatchString(value)
}

func validIdentifier(value string, maximum int, required bool) bool {
	if value == "" {
		return !required
	}
	if len(value) > maximum {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func contextKey(addonID, generation, requestID string) entryKey {
	return entryKey{addonID: addonID, generation: generation, requestID: requestID}
}

func metaFromAuthority(authority Authority, generation string) workerrpc.Meta {
	actor := authority.Actor
	return workerrpc.Meta{
		RequestID:      authority.RequestID,
		CorrelationID:  authority.CorrelationID,
		Generation:     generation,
		Deadline:       authority.Deadline,
		Actor:          &actor,
		IdempotencyKey: authority.IdempotencyKey,
		Traceparent:    authority.Traceparent,
	}
}

func cloneAuthority(authority Authority) Authority {
	authority.Actor = workerrpc.Actor{Role: authority.Actor.Role, ID: authority.Actor.ID}
	return authority
}

func randomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

var _ Resolver = (*Registry)(nil)
