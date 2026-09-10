CREATE TABLE addon_github_sources (
    addon_id TEXT PRIMARY KEY NOT NULL REFERENCES addon_package_states(addon_id),
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    revision INTEGER NOT NULL CHECK(revision > 0),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1))
);

CREATE TABLE addon_github_generations (
    addon_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    remote_id TEXT NOT NULL,
    PRIMARY KEY (addon_id, generation_id, source_json, remote_id),
    FOREIGN KEY (addon_id, generation_id)
        REFERENCES addon_package_generations(addon_id, generation_id)
);
