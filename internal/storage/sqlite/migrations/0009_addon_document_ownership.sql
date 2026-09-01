ALTER TABLE addon_data_sets ADD COLUMN schema_version TEXT;
ALTER TABLE addon_data_sets ADD COLUMN schema_sha256 TEXT CHECK(schema_sha256 IS NULL OR length(schema_sha256) = 64);
ALTER TABLE addon_data_sets ADD COLUMN target_collection TEXT;
ALTER TABLE addon_data_sets ADD COLUMN keyed INTEGER CHECK(keyed IS NULL OR keyed IN (0, 1));

ALTER TABLE addon_documents ADD COLUMN target_created_at TEXT;
