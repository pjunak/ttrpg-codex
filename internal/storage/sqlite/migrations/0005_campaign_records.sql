CREATE TABLE campaign_collections (
    name TEXT PRIMARY KEY NOT NULL,
    shape TEXT NOT NULL CHECK(shape IN ('list', 'keyed')),
    materialized INTEGER NOT NULL DEFAULT 0 CHECK(materialized IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    updated_at TEXT
);

INSERT INTO campaign_collections(name, shape) VALUES
    ('characters', 'list'),
    ('relationships', 'list'),
    ('locations', 'list'),
    ('events', 'list'),
    ('mysteries', 'list'),
    ('factions', 'keyed'),
    ('deletedDefaults', 'keyed'),
    ('pantheon', 'list'),
    ('artifacts', 'list'),
    ('settings', 'keyed'),
    ('historicalEvents', 'list'),
    ('campaign', 'keyed'),
    ('pets', 'list');

CREATE TABLE campaign_records (
    collection_name TEXT NOT NULL REFERENCES campaign_collections(name) ON DELETE RESTRICT,
    record_key TEXT NOT NULL CHECK(length(record_key) BETWEEN 1 AND 1024),
    position INTEGER NOT NULL CHECK(position >= 0),
    body_json TEXT NOT NULL CHECK(json_valid(body_json)),
    visibility TEXT NOT NULL CHECK(visibility IN ('public', 'dm')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(collection_name, record_key),
    UNIQUE(collection_name, position)
);

CREATE INDEX campaign_records_visibility
    ON campaign_records(collection_name, visibility, position);

CREATE TABLE campaign_record_versions (
    collection_name TEXT NOT NULL REFERENCES campaign_collections(name) ON DELETE RESTRICT,
    record_key TEXT NOT NULL CHECK(length(record_key) BETWEEN 1 AND 1024),
    revision INTEGER NOT NULL CHECK(revision > 0),
    deleted INTEGER NOT NULL CHECK(deleted IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(collection_name, record_key)
);

CREATE TABLE campaign_commits (
    commit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 200),
    occurred_at TEXT NOT NULL,
    mutation_count INTEGER NOT NULL CHECK(mutation_count > 0)
);

CREATE TABLE campaign_commit_records (
    commit_id INTEGER NOT NULL REFERENCES campaign_commits(commit_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    collection_name TEXT NOT NULL,
    record_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('put', 'delete')),
    before_revision INTEGER NOT NULL CHECK(before_revision >= 0),
    after_revision INTEGER NOT NULL CHECK(after_revision >= 0),
    visibility TEXT NOT NULL CHECK(visibility IN ('public', 'dm')),
    PRIMARY KEY(commit_id, ordinal)
);

CREATE INDEX campaign_commit_records_target
    ON campaign_commit_records(collection_name, record_key, commit_id);
