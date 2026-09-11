# Retiring old character sheets

The replacement uses the permanent `dnd-sheets` namespace with schema 4.0.0.
The owner approved retirement of old sheet values. Their removal remains an
explicit offline operation, separate from deploying the code or installing ZIPs.

**Data loss boundary:** applying this procedure deletes schema-3 sheet documents,
their revision markers and that extension's schema metadata. Core character
profiles, portraits, core notes, relationships, other add-on data, installation
generations, recovery points and the backup are preserved. Any retained character
history or schema other than exactly 3.0.0 makes the command refuse removal.

1. Use the updated host database schema, disable Character Sheets in the Add-on
   Manager, and stop the host. Keep an independent installation backup.
2. Preview the retired namespace with the stopped site's explicit data path:

   ```text
   codex-maintenance retire-sheets -data-dir <stopped-site-data>
   ```

   The JSON report lists each affected character key, revision-marker count,
   schema identity and `reviewSHA256`. An absent namespace needs no reset.
   Review these actual keys before proceeding.
3. Apply that exact report with a **new** full backup path:

   ```text
   codex-maintenance retire-sheets -data-dir <stopped-site-data> -apply <reviewSHA256> -backup <new-backup.zip>
   ```

   The command holds the exclusive data-directory lock, creates and verifies a
   complete `codex-backup.v2` ZIP, then repeats the checks and atomically removes
   only the retired namespace. Changed data, an active host/add-on, reused backup
   path or backup failure prevent removal. Save the JSON report with the backup.
4. Start the host and install/review/activate Engine 4 and Sheets 4 packages.
   Verify creation, save, history, print and rule details on a test character.

The Go command can be run from this source checkout as
`go run ./cmd/codex-maintenance retire-sheets ...`. Production add-on installation
still uses prebuilt ZIPs. No startup migration or general legacy handler exists.

For original v1 backups, use the separate [offline converter](LEGACY_CONVERSION.md).
It counts and omits retired sheets while leaving the input ZIP unchanged. It
does not run this namespace reset against an existing site.

The original backup can be restored into a fresh disposable directory for
inspection. Reverting an entire production directory requires its own reviewed
operational decision. New retained character history is never eligible for this
one-time retirement, including after the current character head was deleted.
