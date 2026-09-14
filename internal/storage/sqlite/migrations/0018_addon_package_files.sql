-- Package identity survives eviction of reproducible local files.
CREATE TABLE addon_package_files (
    addon_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('local', 'pending', 'remote')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (addon_id, generation_id),
    FOREIGN KEY (addon_id, generation_id)
        REFERENCES addon_package_generations(addon_id, generation_id) ON DELETE CASCADE
);
ALTER TABLE addon_github_generations ADD COLUMN download_path TEXT NOT NULL DEFAULT '';
ALTER TABLE addon_github_generations ADD COLUMN digest TEXT NOT NULL DEFAULT '';

CREATE TABLE addon_package_retention (singleton INTEGER PRIMARY KEY CHECK(singleton=1), initial_cleanup_complete INTEGER NOT NULL DEFAULT 0 CHECK(initial_cleanup_complete IN (0,1)));
INSERT INTO addon_package_retention(singleton) VALUES (1);
