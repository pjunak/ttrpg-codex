package credentialstore

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/auth"
)

func (store Store) LoadSessions(ctx context.Context) ([]auth.StoredSession, error) {
	rows, err := store.DB.QueryContext(ctx, `
		SELECT token_digest, real_role, role, csrf_token, preview_parent, created_at, expires_at
		FROM host_sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := make([]auth.StoredSession, 0)
	for rows.Next() {
		var digest, parent []byte
		var realRole, role, csrf, createdAt, expiresAt string
		if err := rows.Scan(&digest, &realRole, &role, &csrf, &parent, &createdAt, &expiresAt); err != nil {
			return nil, err
		}
		session := auth.StoredSession{RealRole: auth.Role(realRole), Role: auth.Role(role), CSRFToken: csrf}
		if len(digest) != sha256.Size || parent != nil && len(parent) != sha256.Size {
			return nil, fmt.Errorf("saved session digest is malformed")
		}
		copy(session.TokenDigest[:], digest)
		if parent != nil {
			var value [sha256.Size]byte
			copy(value[:], parent)
			session.PreviewParent = &value
		}
		if session.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt); err != nil {
			return nil, fmt.Errorf("saved session creation time: %w", err)
		}
		if session.ExpiresAt, err = time.Parse(time.RFC3339Nano, expiresAt); err != nil {
			return nil, fmt.Errorf("saved session expiry: %w", err)
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

func (store Store) ApplySessions(ctx context.Context, save []auth.StoredSession, remove [][sha256.Size]byte) error {
	tx, err := store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, digest := range remove {
		if _, err := tx.ExecContext(ctx, `DELETE FROM host_sessions WHERE token_digest = ?`, digest[:]); err != nil {
			return err
		}
	}
	for _, session := range save {
		var parent any
		if session.PreviewParent != nil {
			parent = session.PreviewParent[:]
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO host_sessions(token_digest, real_role, role, csrf_token, preview_parent, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			session.TokenDigest[:], string(session.RealRole), string(session.Role), session.CSRFToken, parent,
			session.CreatedAt.UTC().Format(time.RFC3339Nano), session.ExpiresAt.UTC().Format(time.RFC3339Nano),
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ClearSessions signs out every saved session.
func (store Store) ClearSessions(ctx context.Context) error {
	_, err := store.DB.ExecContext(ctx, `DELETE FROM host_sessions`)
	return err
}
