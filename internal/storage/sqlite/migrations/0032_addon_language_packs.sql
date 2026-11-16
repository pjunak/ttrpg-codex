-- Language packs the host downloaded for an add-on: at most one per add-on and
-- language. The pack ZIP is stored by its SHA-256 under the package directory
-- (addons/.language-packs/<sha256>.zip); fetch results are not stored.
CREATE TABLE addon_language_packs (
    addon_id TEXT NOT NULL,
    locale TEXT NOT NULL,
    pack_sha256 TEXT NOT NULL CHECK(length(pack_sha256) = 64),
    addon_versions TEXT NOT NULL,
    built_from TEXT NOT NULL,
    installed_at TEXT NOT NULL,
    PRIMARY KEY (addon_id, locale)
);
