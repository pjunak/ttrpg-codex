-- Replay checkpoints preserve the latest visible cursor after explicitly
-- reviewed operational-log cleanup. Normal writes never expire history.
CREATE TABLE event_replay_checkpoints (
    audience TEXT PRIMARY KEY CHECK(audience IN ('public', 'dm', 'system')),
    sequence INTEGER NOT NULL CHECK(sequence >= 0)
) STRICT;
INSERT INTO event_replay_checkpoints VALUES ('public', 0), ('dm', 0), ('system', 0);
CREATE INDEX change_log_audience_sequence ON change_log(audience, sequence);

-- Committed collection intent survives a crash before/after filesystem unlink.
CREATE TABLE blob_collection_pending (
    sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    bytes INTEGER NOT NULL CHECK(bytes >= 0)
) STRICT;
