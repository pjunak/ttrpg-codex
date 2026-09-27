ALTER TABLE addon_schema_reviews ADD COLUMN resolution TEXT NOT NULL DEFAULT '';

-- An interrupted update restores its original namespace before workers start.
-- Receipts survive package retirement and never contain another add-on's data.
CREATE TABLE addon_update_attempts (
    review_id TEXT PRIMARY KEY NOT NULL,
    addon_id TEXT NOT NULL,
    schema_review_id TEXT NOT NULL REFERENCES addon_schema_reviews(review_id),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
    previous_state_json TEXT NOT NULL CHECK(json_valid(previous_state_json)),
    previous_ruleset_json TEXT NOT NULL CHECK(json_valid(previous_ruleset_json)),
    configuration_revision INTEGER NOT NULL,
    configuration_changed INTEGER NOT NULL CHECK(configuration_changed IN (0,1)),
    status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'failed')),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
);
