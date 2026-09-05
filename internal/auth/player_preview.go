package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

const playerPreviewTTL = time.Hour
const maximumPlayerPreviews = 8

// CreatePlayerPreview issues independent player authority without rotating the DM.
// Its lifetime is bounded by both one hour and the issuing session's lifetime.
func (service *Service) CreatePlayerPreview(parentToken string) (Session, error) {
	if service == nil || !validToken(parentToken) {
		return Session{}, ErrRoleTransition
	}
	token, csrf, err := service.generateSessionTokens()
	if err != nil {
		return Session{}, err
	}
	now := service.now().UTC()
	parentDigest, digest := sha256.Sum256([]byte(parentToken)), sha256.Sum256([]byte(token))
	service.mu.Lock()
	defer service.mu.Unlock()
	service.pruneExpiredLocked(now)
	parent, ok := service.sessions[parentDigest]
	if !ok || parent.actor.RealRole != RoleDM || parent.actor.Role != RoleDM || parent.previewParent != nil {
		return Session{}, ErrRoleTransition
	}
	count := 0
	for _, session := range service.sessions {
		if session.previewParent != nil && *session.previewParent == parentDigest {
			count++
		}
	}
	if count >= maximumPlayerPreviews || len(service.sessions) >= service.maximum {
		return Session{}, ErrSessionCapacity
	}
	if _, collision := service.sessions[digest]; collision {
		return Session{}, fmt.Errorf("%w: generated duplicate token", ErrSessionUnavailable)
	}
	expires := now.Add(playerPreviewTTL)
	if parent.expiresAt.Before(expires) {
		expires = parent.expiresAt
	}
	actor := Actor{SessionID: hex.EncodeToString(digest[:12]), RealRole: RolePlayer, Role: RolePlayer}
	service.sessions[digest] = storedSession{actor: actor, csrfToken: csrf, csrfDigest: sha256.Sum256([]byte(csrf)),
		createdAt: now, expiresAt: expires, previewParent: &parentDigest}
	return Session{Token: token, CSRFToken: csrf, Actor: actor, ExpiresAt: expires}, nil
}

// InspectPlayerPreview never accepts ordinary session tokens as preview tokens.
func (service *Service) InspectPlayerPreview(token string) (Session, bool) {
	if service == nil || !validToken(token) {
		return Session{}, false
	}
	digest := sha256.Sum256([]byte(token))
	service.mu.Lock()
	defer service.mu.Unlock()
	record, ok := service.sessions[digest]
	if !ok || record.previewParent == nil {
		return Session{}, false
	}
	if !service.usableLocked(record, service.now().UTC()) {
		delete(service.sessions, digest)
		return Session{}, false
	}
	return Session{Token: token, CSRFToken: record.csrfToken, Actor: record.actor, ExpiresAt: record.expiresAt}, true
}

func (service *Service) usableLocked(record storedSession, now time.Time) bool {
	if !record.expiresAt.After(now) {
		return false
	}
	if record.previewParent == nil {
		return true
	}
	parent, ok := service.sessions[*record.previewParent]
	return ok && parent.previewParent == nil && parent.expiresAt.After(now) && parent.actor.RealRole == RoleDM && parent.actor.Role == RoleDM
}
