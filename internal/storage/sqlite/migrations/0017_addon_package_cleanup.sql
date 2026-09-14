-- Accepted cleanup receipts survive package metadata removal and interrupted file deletion.
CREATE TABLE addon_package_cleanups (
    review_sha256 TEXT PRIMARY KEY NOT NULL CHECK(length(review_sha256) = 64),
    review_json TEXT NOT NULL CHECK(json_valid(review_json)),
    status TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
    created_at TEXT NOT NULL,
    completed_at TEXT
) STRICT;
