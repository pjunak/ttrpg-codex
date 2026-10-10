-- Package files always stay on disk; nothing reads or writes the residency
-- and retention-flag tables any more. Both are empty on every installation.
DROP TABLE addon_package_files;
DROP TABLE addon_package_retention;
