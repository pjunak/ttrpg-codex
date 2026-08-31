CREATE TABLE app_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL CHECK(json_valid(value_json)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    updated_at TEXT NOT NULL
);

CREATE TABLE change_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    audience TEXT NOT NULL CHECK(audience IN ('public', 'dm', 'system')),
    topic TEXT NOT NULL,
    resource_id TEXT,
    revision TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))
);

CREATE INDEX change_log_topic_sequence
    ON change_log(topic, sequence);
