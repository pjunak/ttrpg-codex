-- Existing audit rows describe the original combined recovery operation.
ALTER TABLE recovery_restores ADD COLUMN scope TEXT NOT NULL DEFAULT '' CHECK(scope IN ('', 'campaign', 'addon'));
ALTER TABLE recovery_restores ADD COLUMN addon_id TEXT NOT NULL DEFAULT '';
