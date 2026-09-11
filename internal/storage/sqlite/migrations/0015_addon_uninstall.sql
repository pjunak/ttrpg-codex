-- Retire installation authority while retaining generations referenced by data,
-- lifecycle history and recovery points. Reinstallation clears the tombstone.
CREATE TABLE addon_package_uninstalls (
    addon_id TEXT PRIMARY KEY NOT NULL REFERENCES addon_package_states(addon_id),
    review_sha256 TEXT NOT NULL CHECK(length(review_sha256) = 64),
    removed_at TEXT NOT NULL
) STRICT;
