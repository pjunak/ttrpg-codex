ALTER TABLE addon_data_sets
    ADD COLUMN next_position INTEGER NOT NULL DEFAULT 0 CHECK(next_position >= 0);

UPDATE addon_data_sets
SET next_position = coalesce((
    SELECT max(position) + 1
    FROM addon_documents
    WHERE addon_documents.addon_id = addon_data_sets.addon_id
      AND addon_documents.data_kind = addon_data_sets.data_kind
      AND addon_documents.data_id = addon_data_sets.data_id
), 0);
