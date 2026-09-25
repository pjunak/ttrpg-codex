-- Plans and pre-upgrade snapshots survive package cleanup and process restarts.
-- Permanent namespace deletion explicitly removes these private recovery records.
CREATE TABLE addon_schema_reviews (
    review_id TEXT PRIMARY KEY NOT NULL,
    addon_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared', 'applied')),
    plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
    applied_at TEXT
);
CREATE INDEX addon_schema_reviews_addon ON addon_schema_reviews(addon_id);
