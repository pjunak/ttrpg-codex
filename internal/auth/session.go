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
	RealRole  Role
	Role      Role
}

type actorContextKey struct{}

func WithActor(ctx context.Context, actor Actor) context.Context {
	return context.WithValue(ctx, actorContextKey{}, actor)
}

func ActorFromContext(ctx context.Context) (Actor, bool) {
	actor, ok := ctx.Value(actorContextKey{}).(Actor)
	return actor, ok && actor.SessionID != "" &&
		(actor.RealRole == RoleDM || actor.RealRole == RolePlayer) &&
		(actor.Role == RoleDM || actor.Role == RolePlayer)
}

type Session struct {
	Token     string
	CSRFToken string
	Actor     Actor
	ExpiresAt time.Time
}

type Config struct {
	DMPassword     string
	PlayerPassword string
	SessionTTL     time.Duration
	MaxSessions    int
	Now            func() time.Time
	GenerateToken  func() (string, error)
}

type storedSession struct {
	actor      Actor
	csrfToken  string
	csrfDigest [sha256.Size]byte
	createdAt  time.Time
	expiresAt  time.Time
}

type Service struct {
	dmCredential     [sha256.Size]byte
	playerCredential [sha256.Size]byte
	hasPlayer        bool
	ttl              time.Duration
	maximum          int
	now              func() time.Time
	generateToken    func() (string, error)

	mu       sync.Mutex
	sessions map[[sha256.Size]byte]storedSession
}

func New(config Config) (*Service, error) {
	if len(config.DMPassword) < 4 || len(config.DMPassword) > maximumCredentialBytes ||
		len(config.PlayerPassword) > maximumCredentialBytes {
		return nil, fmt.Errorf("%w: DM password must contain 4-%d bytes and player password at most %d bytes", ErrInvalidConfig, maximumCredentialBytes, maximumCredentialBytes)
	}
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
		dmCredential:  credentialDigest(RoleDM, config.DMPassword),
		ttl:           config.SessionTTL,
		maximum:       config.MaxSessions,
		now:           config.Now,
		generateToken: config.GenerateToken,
		sessions:      make(map[[sha256.Size]byte]storedSession),
	}
	if config.PlayerPassword != "" {
		service.playerCredential = credentialDigest(RolePlayer, config.PlayerPassword)
		service.hasPlayer = true
	} else {
		service.playerCredential = credentialDigest(RolePlayer, "unconfigured-player-credential")
	}
	return service, nil
}

func (service *Service) Login(password string) (Session, error) {
	if service == nil || len(password) > maximumCredentialBytes {
		return Session{}, ErrInvalidCredentials
	}
	dmCandidate := credentialDigest(RoleDM, password)
	playerCandidate := credentialDigest(RolePlayer, password)
	dmMatch := subtle.ConstantTimeCompare(dmCandidate[:], service.dmCredential[:])
	playerMatch := subtle.ConstantTimeCompare(playerCandidate[:], service.playerCredential[:])
	role := Role("")
	if dmMatch == 1 {
		role = RoleDM
	} else if service.hasPlayer && playerMatch == 1 {
		role = RolePlayer
	}
	if role == "" {
		return Session{}, ErrInvalidCredentials
	}
	return service.createSession(role, role)
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
	if !record.expiresAt.After(now) {
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
	if !exists || !record.expiresAt.After(now) {
		if exists {
			delete(service.sessions, digest)
		}
		return false
	}
	return subtle.ConstantTimeCompare(candidate[:], record.csrfDigest[:]) == 1
}

func (service *Service) SwitchRole(token string, target Role) (Session, error) {
	if service == nil || !validToken(token) || target != RoleDM && target != RolePlayer {
		return Session{}, ErrRoleTransition
	}
	digest := sha256.Sum256([]byte(token))
	now := service.now().UTC()
	nextToken, nextCSRFToken, err := service.generateSessionTokens()
	if err != nil {
		return Session{}, err
	}
	nextDigest := sha256.Sum256([]byte(nextToken))
	service.mu.Lock()
	defer service.mu.Unlock()
	record, exists := service.sessions[digest]
	if !exists || !record.expiresAt.After(now) || record.actor.RealRole != RoleDM {
		if exists && !record.expiresAt.After(now) {
			delete(service.sessions, digest)
		}
		return Session{}, ErrRoleTransition
	}
	if _, collision := service.sessions[nextDigest]; collision {
		return Session{}, fmt.Errorf("%w: generated duplicate token", ErrSessionUnavailable)
	}
	delete(service.sessions, digest)
	actor := Actor{
		SessionID: hex.EncodeToString(nextDigest[:12]),
		RealRole:  RoleDM, Role: target,
	}
	expiresAt := now.Add(service.ttl)
	service.sessions[nextDigest] = storedSession{
		actor: actor, csrfToken: nextCSRFToken,
		csrfDigest: sha256.Sum256([]byte(nextCSRFToken)),
		createdAt:  now, expiresAt: expiresAt,
	}
	return Session{
		Token: nextToken, CSRFToken: nextCSRFToken,
		Actor: actor, ExpiresAt: expiresAt,
	}, nil
}

func (service *Service) Revoke(token string) {
	if service == nil || !validToken(token) {
		return
	}
	digest := sha256.Sum256([]byte(token))
	service.mu.Lock()
	delete(service.sessions, digest)
	service.mu.Unlock()
}

func (service *Service) createSession(realRole, role Role) (Session, error) {
	token, csrfToken, err := service.generateSessionTokens()
	if err != nil {
		return Session{}, err
	}
	now := service.now().UTC()
	expiresAt := now.Add(service.ttl)
	tokenDigest := sha256.Sum256([]byte(token))
	service.mu.Lock()
	defer service.mu.Unlock()
	service.pruneExpiredLocked(now)
	if len(service.sessions) >= service.maximum {
		return Session{}, ErrSessionCapacity
	}
	if _, collision := service.sessions[tokenDigest]; collision {
		return Session{}, fmt.Errorf("%w: generated duplicate token", ErrSessionUnavailable)
	}
	actor := Actor{
		SessionID: hex.EncodeToString(tokenDigest[:12]),
		RealRole:  realRole,
		Role:      role,
	}
	service.sessions[tokenDigest] = storedSession{
		actor: actor, csrfToken: csrfToken,
		csrfDigest: sha256.Sum256([]byte(csrfToken)),
		createdAt:  now, expiresAt: expiresAt,
	}
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

func (service *Service) pruneExpiredLocked(now time.Time) {
	for digest, record := range service.sessions {
		if !record.expiresAt.After(now) {
			delete(service.sessions, digest)
		}
	}
}

func credentialDigest(role Role, password string) [sha256.Size]byte {
	return sha256.Sum256([]byte(string(role) + "\x00" + password))
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
