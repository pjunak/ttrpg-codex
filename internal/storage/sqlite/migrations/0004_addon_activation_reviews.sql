CREATE TABLE addon_activation_reviews (
    review_id TEXT PRIMARY KEY NOT NULL,
    addon_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    expected_state_revision INTEGER NOT NULL CHECK(expected_state_revision >= 0),
    status TEXT NOT NULL CHECK(status IN ('prepared', 'approved', 'consumed')),
    proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256) = 64),
    proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
    granted_permissions_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(granted_permissions_json)),
    approval_sha256 TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    consumed_at TEXT,
    FOREIGN KEY (addon_id, generation_id)
        REFERENCES addon_package_generations(addon_id, generation_id)
);

CREATE INDEX addon_activation_reviews_addon_created
    ON addon_activation_reviews(addon_id, created_at DESC);

CREATE INDEX addon_activation_reviews_status
    ON addon_activation_reviews(status, created_at);
