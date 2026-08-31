CREATE TABLE addon_service_catalogs (
    addon_id TEXT PRIMARY KEY NOT NULL,
    addon_version TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    installed INTEGER NOT NULL CHECK(installed IN (0, 1)),
    updated_at TEXT NOT NULL
);

CREATE TABLE addon_service_providers (
    addon_id TEXT NOT NULL,
    contract TEXT NOT NULL,
    addon_version TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    transport TEXT NOT NULL CHECK(transport IN ('ui', 'worker', 'content')),
    schema_path TEXT NOT NULL,
    exclusive INTEGER NOT NULL CHECK(exclusive IN (0, 1)),
    catalog_revision INTEGER NOT NULL CHECK(catalog_revision > 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (addon_id, contract),
    FOREIGN KEY (addon_id)
        REFERENCES addon_service_catalogs(addon_id)
        ON DELETE CASCADE
);

CREATE INDEX addon_service_providers_contract
    ON addon_service_providers(contract, addon_id);

CREATE TABLE addon_service_bindings (
    consumer_addon_id TEXT NOT NULL,
    contract TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (consumer_addon_id, contract, scope_kind, scope_id),
    CHECK(
        (scope_kind = 'global' AND scope_id = '') OR
        (scope_kind <> 'global' AND length(scope_id) > 0)
    )
);

CREATE TABLE addon_service_binding_targets (
    consumer_addon_id TEXT NOT NULL,
    contract TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL DEFAULT '',
    provider_addon_id TEXT NOT NULL,
    PRIMARY KEY (
        consumer_addon_id,
        contract,
        scope_kind,
        scope_id,
        provider_addon_id
    ),
    FOREIGN KEY (consumer_addon_id, contract, scope_kind, scope_id)
        REFERENCES addon_service_bindings(
            consumer_addon_id,
            contract,
            scope_kind,
            scope_id
        )
        ON DELETE CASCADE
);

CREATE INDEX addon_service_binding_targets_provider
    ON addon_service_binding_targets(provider_addon_id, contract);
