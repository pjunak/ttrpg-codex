CREATE TABLE addon_history_payloads (
    sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
    body_json TEXT NOT NULL CHECK(json_valid(body_json))
);

CREATE TABLE addon_history_revisions (
    addon_id TEXT NOT NULL,
    data_kind TEXT NOT NULL CHECK(data_kind = 'record-extension'),
    data_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    target_created_at TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    summary TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
    fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
    PRIMARY KEY(addon_id, data_kind, data_id, document_key, revision)
);

CREATE TABLE addon_data_requests (
    addon_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    PRIMARY KEY(addon_id, operation_id)
);

CREATE TRIGGER addon_history_no_update BEFORE UPDATE ON addon_history_revisions
BEGIN SELECT RAISE(ABORT, 'retained revisions are immutable'); END;
CREATE TRIGGER addon_history_payload_no_update BEFORE UPDATE ON addon_history_payloads
BEGIN SELECT RAISE(ABORT, 'retained payloads are immutable'); END;
