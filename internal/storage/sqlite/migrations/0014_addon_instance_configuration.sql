CREATE TABLE addon_instance_configuration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    ruleset_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(ruleset_json)),
    sources_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sources_json))
);
INSERT INTO addon_instance_configuration(id) VALUES (1);
