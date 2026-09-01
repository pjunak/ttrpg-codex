CREATE TABLE blob_objects (
    sha256 TEXT PRIMARY KEY NOT NULL
        CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    created_at TEXT NOT NULL
);

CREATE TABLE blobs (
    blob_id TEXT PRIMARY KEY NOT NULL
        CHECK(
            length(blob_id) = 34
            AND substr(blob_id, 1, 2) = 'b_'
            AND substr(blob_id, 3) NOT GLOB '*[^0-9a-f]*'
        ),
    object_sha256 TEXT NOT NULL REFERENCES blob_objects(sha256) ON DELETE RESTRICT,
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('core', 'addon', 'system')),
    owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 200),
    purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 200),
    media_type TEXT NOT NULL CHECK(length(media_type) BETWEEN 1 AND 200),
    original_name TEXT NOT NULL CHECK(length(original_name) <= 255),
    visibility TEXT NOT NULL CHECK(visibility IN ('public', 'dm')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX blobs_owner
    ON blobs(owner_kind, owner_id, purpose, deleted, created_at);

CREATE INDEX blobs_object
    ON blobs(object_sha256, deleted);
