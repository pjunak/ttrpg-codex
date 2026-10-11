-- Signed-in sessions survive host restarts. Only token digests are stored; the
-- CSRF value is kept so a reloaded page can recover it from its session cookie.
-- Backup images drop every row, so a restore still signs everyone out.
CREATE TABLE host_sessions (
    token_digest BLOB PRIMARY KEY CHECK (length(token_digest) = 32),
    real_role TEXT NOT NULL CHECK (real_role IN ('dm', 'player')),
    role TEXT NOT NULL CHECK (role IN ('dm', 'player')),
    csrf_token TEXT NOT NULL CHECK (length(csrf_token) BETWEEN 32 AND 512),
    preview_parent BLOB CHECK (preview_parent IS NULL OR length(preview_parent) = 32),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
