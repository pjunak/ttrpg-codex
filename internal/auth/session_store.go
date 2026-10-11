package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

const sessionStoreTimeout = 5 * time.Second

// StoredSession is the durable form of one session. The session token itself is
// never stored, only its digest.
type StoredSession struct {
	TokenDigest   [sha256.Size]byte
	RealRole      Role
	Role          Role
	CSRFToken     string
	PreviewParent *[sha256.Size]byte
	CreatedAt     time.Time
	ExpiresAt     time.Time
}

// SessionStore keeps sessions across host restarts. Apply saves and removes
// sessions in one transaction.
type SessionStore interface {
	LoadSessions(context.Context) ([]StoredSession, error)
	ApplySessions(ctx context.Context, save []StoredSession, remove [][sha256.Size]byte) error
}

func (service *Service) loadSessions(ctx context.Context) error {
	if service.sessionStore == nil {
		return nil
	}
	stored, err := service.sessionStore.LoadSessions(ctx)
	if err != nil {
		return fmt.Errorf("load sessions: %w", err)
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	for _, session := range stored {
		if !validRole(session.RealRole) || !validRole(session.Role) || !validToken(session.CSRFToken) {
			return fmt.Errorf("%w: saved session is malformed", ErrInvalidConfig)
		}
		record := storedSession{
			actor: Actor{
				SessionID: hex.EncodeToString(session.TokenDigest[:12]),
				RealRole:  session.RealRole, Role: session.Role,
			},
			csrfToken: session.CSRFToken, csrfDigest: sha256.Sum256([]byte(session.CSRFToken)),
			createdAt: session.CreatedAt.UTC(), expiresAt: session.ExpiresAt.UTC(),
		}
		if session.PreviewParent != nil {
			parent := *session.PreviewParent
			record.previewParent = &parent
		}
		service.sessions[session.TokenDigest] = record
	}
	return service.pruneExpiredLocked(service.now().UTC())
}

// applyLocked writes session changes through to the store. Callers change the
// in-memory map only after it succeeds, so a failed write keeps both in step.
func (service *Service) applyLocked(save []sessionWrite, remove [][sha256.Size]byte) error {
	if service.sessionStore == nil || len(save) == 0 && len(remove) == 0 {
		return nil
	}
	records := make([]StoredSession, 0, len(save))
	for _, write := range save {
		records = append(records, StoredSession{
			TokenDigest: write.digest, RealRole: write.record.actor.RealRole, Role: write.record.actor.Role,
			CSRFToken: write.record.csrfToken, PreviewParent: write.record.previewParent,
			CreatedAt: write.record.createdAt, ExpiresAt: write.record.expiresAt,
		})
	}
	ctx, cancel := context.WithTimeout(context.Background(), sessionStoreTimeout)
	defer cancel()
	if err := service.sessionStore.ApplySessions(ctx, records, remove); err != nil {
		return fmt.Errorf("%w: save sessions: %v", ErrSessionUnavailable, err)
	}
	return nil
}

type sessionWrite struct {
	digest [sha256.Size]byte
	record storedSession
}

func validRole(role Role) bool {
	return role == RoleDM || role == RolePlayer
}
