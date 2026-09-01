CREATE TABLE addon_data_sets (
    addon_id TEXT NOT NULL,
    data_kind TEXT NOT NULL CHECK(data_kind IN ('collection', 'record-extension')),
    data_id TEXT NOT NULL,
    materialized INTEGER NOT NULL DEFAULT 0 CHECK(materialized IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    updated_at TEXT,
    PRIMARY KEY (addon_id, data_kind, data_id)
);

CREATE TABLE addon_documents (
    addon_id TEXT NOT NULL,
    data_kind TEXT NOT NULL CHECK(data_kind IN ('collection', 'record-extension')),
    data_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    body_json TEXT NOT NULL CHECK(json_valid(body_json)),
    schema_version TEXT NOT NULL,
    schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256) = 64),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (addon_id, data_kind, data_id, document_key),
    FOREIGN KEY (addon_id, data_kind, data_id)
        REFERENCES addon_data_sets(addon_id, data_kind, data_id)
        ON DELETE CASCADE
);

CREATE INDEX addon_documents_order
    ON addon_documents(addon_id, data_kind, data_id, position, document_key);

CREATE TABLE addon_document_versions (
    addon_id TEXT NOT NULL,
    data_kind TEXT NOT NULL CHECK(data_kind IN ('collection', 'record-extension')),
    data_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    deleted INTEGER NOT NULL CHECK(deleted IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (addon_id, data_kind, data_id, document_key),
    FOREIGN KEY (addon_id, data_kind, data_id)
        REFERENCES addon_data_sets(addon_id, data_kind, data_id)
        ON DELETE CASCADE
);

CREATE TABLE addon_data_commits (
    commit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    addon_id TEXT NOT NULL,
    generation_id TEXT NOT NULL CHECK(length(generation_id) = 64),
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    operation_count INTEGER NOT NULL CHECK(operation_count > 0)
);

CREATE TABLE addon_data_commit_records (
    commit_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    data_kind TEXT NOT NULL CHECK(data_kind IN ('collection', 'record-extension')),
    data_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('put', 'delete')),
    before_revision INTEGER NOT NULL CHECK(before_revision >= 0),
    after_revision INTEGER NOT NULL CHECK(after_revision >= 1),
    PRIMARY KEY (commit_id, ordinal),
    FOREIGN KEY (commit_id) REFERENCES addon_data_commits(commit_id) ON DELETE CASCADE
);

CREATE INDEX addon_data_commits_addon
    ON addon_data_commits(addon_id, commit_id DESC);
