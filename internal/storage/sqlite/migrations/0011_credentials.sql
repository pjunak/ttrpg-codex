CREATE TABLE host_credentials (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    value_json TEXT NOT NULL CHECK (json_valid(value_json))
) STRICT;
