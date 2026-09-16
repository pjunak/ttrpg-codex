CREATE TABLE campaign_import_receipts (
    token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash) = 64),
    status TEXT NOT NULL CHECK(status IN ('committing', 'committed', 'failed')),
    created_at TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
