package auth

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
)

const passwordIterations = 600_000

var ErrCredentialConflict = errors.New("credentials changed since review")
var ErrPasswordPolicy = errors.New("password must contain 4-4096 bytes and differ from the other role")

type PasswordHash struct {
	Algorithm string `json:"algorithm"`
	Salt      []byte `json:"salt"`
	Digest    []byte `json:"digest"`
}

type Credentials struct {
	Revision int64         `json:"revision"`
	DM       PasswordHash  `json:"dm"`
	Player   *PasswordHash `json:"player"`
}

type CredentialStore interface {
	Load(context.Context) (Credentials, bool, error)
	Save(context.Context, Credentials, int64) error
}

type CredentialStatus struct {
	ContractVersion string `json:"contractVersion"`
	Revision        int64  `json:"revision"`
	PlayerEnabled   bool   `json:"playerEnabled"`
}

// ResetCredentials is used only by the offline operator command, under the
// host's exclusive data-directory lock. It never changes campaign records.
func ResetCredentials(ctx context.Context, store CredentialStore, dm, player string) error {
	if len(dm) < 4 || len(dm) > maximumCredentialBytes || len(player) > maximumCredentialBytes || player != "" && (len(player) < 4 || player == dm) {
		return ErrPasswordPolicy
	}
	previous, _, err := store.Load(ctx)
	if err != nil {
		return err
	}
	next := Credentials{Revision: previous.Revision + 1, DM: hashPassword(dm)}
	if player != "" {
		hash := hashPassword(player)
		next.Player = &hash
	}
	return store.Save(ctx, next, previous.Revision)
}

func hashPassword(password string) PasswordHash {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	digest, _ := pbkdf2.Key(sha256.New, password, salt, passwordIterations, sha256.Size)
	return PasswordHash{Algorithm: "pbkdf2-sha256-600000.v1", Salt: salt, Digest: digest}
}

func validHash(hash PasswordHash) bool {
	return hash.Algorithm == "pbkdf2-sha256-600000.v1" && len(hash.Salt) == 16 && len(hash.Digest) == sha256.Size
}

func matchesPassword(hash PasswordHash, password string) bool {
	if !validHash(hash) || len(password) > maximumCredentialBytes {
		return false
	}
	digest, _ := pbkdf2.Key(sha256.New, password, hash.Salt, passwordIterations, sha256.Size)
	return subtle.ConstantTimeCompare(digest, hash.Digest) == 1
}

func (service *Service) initializeCredentials(ctx context.Context, config Config) error {
	if config.CredentialStore != nil {
		stored, found, err := config.CredentialStore.Load(ctx)
		if err != nil {
			return err
		}
		if found {
			if stored.Revision < 1 || !validHash(stored.DM) || stored.Player != nil && !validHash(*stored.Player) {
				return ErrInvalidConfig
			}
			service.credentials = stored
			return nil
		}
	}
	if len(config.DMPassword) < 4 || len(config.DMPassword) > maximumCredentialBytes || len(config.PlayerPassword) > maximumCredentialBytes {
		return ErrInvalidConfig
	}
	credentials := Credentials{Revision: 1, DM: hashPassword(config.DMPassword)}
	if config.PlayerPassword != "" {
		hash := hashPassword(config.PlayerPassword)
		credentials.Player = &hash
	}
	if config.CredentialStore != nil {
		if err := config.CredentialStore.Save(ctx, credentials, 0); err != nil {
			return err
		}
	}
	service.credentials = credentials
	return nil
}

func (service *Service) CredentialStatus() CredentialStatus {
	service.credentialMu.Lock()
	defer service.credentialMu.Unlock()
	return service.credentialStatusLocked()
}

func (service *Service) credentialStatusLocked() CredentialStatus {
	return CredentialStatus{"credential-status.v1", service.credentials.Revision, service.credentials.Player != nil}
}

// ChangePassword commits first, then revokes affected sessions. The reviewing DM
// keeps the same session so a lost response does not discard their access.
func (service *Service) ChangePassword(ctx context.Context, token, csrf, current string, role Role, password string, revision int64) (CredentialStatus, error) {
	service.credentialMu.Lock()
	defer service.credentialMu.Unlock()
	service.mu.Lock()
	defer service.mu.Unlock()
	digest, csrfDigest := sha256.Sum256([]byte(token)), sha256.Sum256([]byte(csrf))
	session, exists := service.sessions[digest]
	if !exists || !service.usableLocked(session, service.now()) || session.actor.RealRole != RoleDM || session.actor.Role != RoleDM || subtle.ConstantTimeCompare(csrfDigest[:], session.csrfDigest[:]) != 1 {
		return CredentialStatus{}, ErrRoleTransition
	}
	if revision != service.credentials.Revision {
		return CredentialStatus{}, ErrCredentialConflict
	}
	if !matchesPassword(service.credentials.DM, current) {
		return CredentialStatus{}, ErrInvalidCredentials
	}
	if role != RoleDM && role != RolePlayer || len(password) > maximumCredentialBytes || len(password) < 4 && !(role == RolePlayer && password == "") {
		return CredentialStatus{}, ErrPasswordPolicy
	}
	if password != "" && (role == RolePlayer && matchesPassword(service.credentials.DM, password) || role == RoleDM && service.credentials.Player != nil && matchesPassword(*service.credentials.Player, password)) {
		return CredentialStatus{}, ErrPasswordPolicy
	}
	next := service.credentials
	next.Revision++
	if role == RoleDM {
		next.DM = hashPassword(password)
	} else if password == "" {
		next.Player = nil
	} else {
		hash := hashPassword(password)
		next.Player = &hash
	}
	if service.credentialStore != nil {
		if err := service.credentialStore.Save(ctx, next, revision); err != nil {
			return CredentialStatus{}, err
		}
	}
	service.credentials = next
	for key, candidate := range service.sessions {
		if key != digest && (candidate.actor.RealRole == role || candidate.previewParent != nil) {
			delete(service.sessions, key)
		}
	}
	return service.credentialStatusLocked(), nil
}
