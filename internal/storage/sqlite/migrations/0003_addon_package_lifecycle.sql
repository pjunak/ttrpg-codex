CREATE TABLE addon_package_generations (
    addon_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    addon_version TEXT NOT NULL,
    archive_sha256 TEXT NOT NULL,
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
    installed_at TEXT NOT NULL,
    last_attempt_at TEXT,
    last_activated_at TEXT,
    last_error TEXT,
    PRIMARY KEY (addon_id, generation_id),
    CHECK(length(generation_id) = 64),
    CHECK(length(archive_sha256) = 64),
    CHECK(generation_id = archive_sha256)
);

CREATE TABLE addon_package_states (
    addon_id TEXT PRIMARY KEY NOT NULL,
    active_generation_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    granted_permissions_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(granted_permissions_json)),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (addon_id, active_generation_id)
        REFERENCES addon_package_generations(addon_id, generation_id)
);

CREATE INDEX addon_package_states_active_generation
    ON addon_package_states(active_generation_id);

CREATE TABLE addon_lifecycle_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    addon_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL,
    FOREIGN KEY (addon_id, generation_id)
        REFERENCES addon_package_generations(addon_id, generation_id)
        ON DELETE CASCADE
);

CREATE INDEX addon_lifecycle_events_addon_sequence
    ON addon_lifecycle_events(addon_id, sequence DESC);
