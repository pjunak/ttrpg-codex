-- Drop tables that nothing reads or writes. All are empty on every installation:
-- package residency and its retention flag (packages always stay on disk),
-- retained add-on record history with its recorded-operation receipts, and
-- app_metadata, which was never used.
DROP TABLE addon_package_files;
DROP TABLE addon_package_retention;
DROP TABLE addon_history_revisions;
DROP TABLE addon_history_payloads;
DROP TABLE addon_data_requests;
DROP TABLE app_metadata;
