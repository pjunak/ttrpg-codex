package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	defaultSessionTTL      = 30 * 24 * time.Hour
	defaultMaxSessions     = 1_024
	maximumCredentialBytes = 4 << 10
)

var (
	ErrInvalidConfig      = errors.New("invalid authentication configuration")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrSessionCapacity    = errors.New("session capacity reached")
	ErrSessionUnavailable = errors.New("session unavailable")
	ErrRoleTransition     = errors.New("role transition is not allowed")
)

type Role string

const (
	RoleDM     Role = "dm"
	RolePlayer Role = "player"
)

type Actor struct {
	SessionID string
	Role      Role
}

type actorContextKey struct{}

func WithActor(ctx context.Context, actor Actor) context.Context {
	return context.WithValue(ctx, actorContextKey{}, actor)
}

func ActorFromContext(ctx context.Context) (Actor, bool) {
	actor, ok := ctx.Value(actorContextKey{}).(Actor)
	return actor, ok && actor.SessionID != "" &&
		(actor.Role == RoleDM || actor.Role == RolePlayer)
}

type Session struct {
	Token     string
	CSRFToken string
	Actor     Actor
	ExpiresAt time.Time
}

type Config struct {
	Context         context.Context
	CredentialStore CredentialStore
	SessionStore    SessionStore
	DMPassword      string
	PlayerPassword  string
	SessionTTL      time.Duration
	MaxSessions     int
	Now             func() time.Time
	GenerateToken   func() (string, error)
}

type storedSession struct {
	actor         Actor
	csrfToken     string
	csrfDigest    [sha256.Size]byte
	createdAt     time.Time
	expiresAt     time.Time
	previewParent *[sha256.Size]byte
}

type Service struct {
	credentialMu    sync.Mutex
	credentials     Credentials
	credentialStore CredentialStore
	sessionStore    SessionStore
	ttl             time.Duration
	maximum         int
	now             func() time.Time
	generateToken   func() (string, error)

	mu       sync.Mutex
	sessions map[[sha256.Size]byte]storedSession
}

func New(config Config) (*Service, error) {
	if config.SessionTTL == 0 {
		config.SessionTTL = defaultSessionTTL
	}
	if config.SessionTTL < time.Minute || config.SessionTTL > 365*24*time.Hour {
		return nil, fmt.Errorf("%w: session lifetime must be between one minute and one year", ErrInvalidConfig)
	}
	if config.MaxSessions == 0 {
		config.MaxSessions = defaultMaxSessions
	}
	if config.MaxSessions < 1 || config.MaxSessions > 100_000 {
		return nil, fmt.Errorf("%w: maximum sessions must be between 1 and 100000", ErrInvalidConfig)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.GenerateToken == nil {
		config.GenerateToken = randomToken
	}
	service := &Service{
		credentialStore: config.CredentialStore,
		sessionStore:    config.SessionStore,
		ttl:             config.SessionTTL,
		maximum:         config.MaxSessions,
		now:             config.Now,
		generateToken:   config.GenerateToken,
		sessions:        make(map[[sha256.Size]byte]storedSession),
	}
	if config.Context == nil {
		config.Context = context.Background()
	}
	if err := service.initializeCredentials(config.Context, config); err != nil {
		return nil, err
	}
	if err := service.loadSessions(config.Context); err != nil {
		return nil, err
	}
	return service, nil
}

func (service *Service) Login(password string) (Session, error) {
	if service == nil || len(password) > maximumCredentialBytes {
		return Session{}, ErrInvalidCredentials
	}
	service.credentialMu.Lock()
	defer service.credentialMu.Unlock()
	role := Role("")
	if matchesPassword(service.credentials.DM, password) {
		role = RoleDM
	} else if service.credentials.Player != nil && matchesPassword(*service.credentials.Player, password) {
		role = RolePlayer
	}
	if role == "" {
		return Session{}, ErrInvalidCredentials
	}
	return service.createSession(role)
}

func (service *Service) Resolve(token string) (Actor, bool) {
	session, ok := service.Inspect(token)
	return session.Actor, ok
}

func (service *Service) Inspect(token string) (Session, bool) {
	if service == nil || !validToken(token) {
		return Session{}, false
	}
	now := service.now().UTC()
	digest := sha256.Sum256([]byte(token))
	service.mu.Lock()
	defer service.mu.Unlock()
	record, exists := service.sessions[digest]
	if !exists {
		return Session{}, false
	}
	if !service.usableLocked(record, now) {
		delete(service.sessions, digest)
		return Session{}, false
	}
	return Session{
		Token: token, CSRFToken: record.csrfToken,
		Actor: record.actor, ExpiresAt: record.expiresAt,
	}, true
}

func (service *Service) ValidateCSRF(token, csrfToken string) bool {
	if service == nil || !validToken(token) || !validToken(csrfToken) {
		return false
	}
	now := service.now().UTC()
	digest := sha256.Sum256([]byte(token))
	candidate := sha256.Sum256([]byte(csrfToken))
	service.mu.Lock()
	defer service.mu.Unlock()
	record, exists := service.sessions[digest]
	if !exists || !service.usableLocked(record, now) {
		if exists {
			delete(service.sessions, digest)
		}
		return false
	}
	return subtle.ConstantTimeCompare(candidate[:], record.csrfDigest[:]) == 1
}

func (service *Service) Revoke(token string) error {
	if service == nil || !validToken(token) {
		return nil
	}
	digest := sha256.Sum256([]byte(token))
	service.mu.Lock()
	defer service.mu.Unlock()
	if _, exists := service.sessions[digest]; !exists {
		return nil
	}
	if err := service.applyLocked(nil, [][sha256.Size]byte{digest}); err != nil {
		return err
	}
	delete(service.sessions, digest)
	return nil
}

func (service *Service) createSession(role Role) (Session, error) {
	token, csrfToken, err := service.generateSessionTokens()
	if err != nil {
		return Session{}, err
	}
	now := service.now().UTC()
	expiresAt := now.Add(service.ttl)
	tokenDigest := sha256.Sum256([]byte(token))
	service.mu.Lock()
	defer service.mu.Unlock()
	if err := service.pruneExpiredLocked(now); err != nil {
		return Session{}, err
	}
	if len(service.sessions) >= service.maximum {
		return Session{}, ErrSessionCapacity
	}
	if _, collision := service.sessions[tokenDigest]; collision {
		return Session{}, fmt.Errorf("%w: generated duplicate token", ErrSessionUnavailable)
	}
	actor := Actor{SessionID: hex.EncodeToString(tokenDigest[:12]), Role: role}
	record := storedSession{
		actor: actor, csrfToken: csrfToken,
		csrfDigest: sha256.Sum256([]byte(csrfToken)),
		createdAt:  now, expiresAt: expiresAt,
	}
	if err := service.applyLocked([]sessionWrite{{tokenDigest, record}}, nil); err != nil {
		return Session{}, err
	}
	service.sessions[tokenDigest] = record
	return Session{Token: token, CSRFToken: csrfToken, Actor: actor, ExpiresAt: expiresAt}, nil
}

func (service *Service) generateSessionTokens() (string, string, error) {
	token, err := service.generateToken()
	if err != nil || !validToken(token) {
		return "", "", fmt.Errorf("%w: generate session token", ErrSessionUnavailable)
	}
	csrfToken, err := service.generateToken()
	if err != nil || !validToken(csrfToken) || csrfToken == token {
		return "", "", fmt.Errorf("%w: generate CSRF token", ErrSessionUnavailable)
	}
	return token, csrfToken, nil
}

func (service *Service) pruneExpiredLocked(now time.Time) error {
	expired := make([][sha256.Size]byte, 0)
	for digest, record := range service.sessions {
		if !service.usableLocked(record, now) {
			expired = append(expired, digest)
		}
	}
	if err := service.applyLocked(nil, expired); err != nil {
		return err
	}
	for _, digest := range expired {
		delete(service.sessions, digest)
	}
	return nil
}

func randomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func validToken(value string) bool {
	if len(value) < 32 || len(value) > 512 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}
