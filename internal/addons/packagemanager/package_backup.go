package packagemanager

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"

	"github.com/pjunak/ttrpg-codex/contracts/addons/v3"
)

// MaterializePackageBackup operates only on the isolated database snapshot and
// an empty temporary package root. The caller holds the lifecycle/maintenance
// lock protecting live package files for the duration of backup publication.
//
// Databases from the retired download-on-demand policy may still mark a needed
// build as not local until automatic cleanup retires it. Such a build is copied
// when its files are still on disk; otherwise the backup fails before anything
// is published.
func MaterializePackageBackup(ctx context.Context, databasePath, liveRoot, stageRoot string, inspector *packageinspect.Inspector) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	db, err := sqlite.Open(ctx, databasePath)
	if err != nil {
		return err
	}
	defer db.Close()
	var present bool
	if err = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='addon_package_files')`).Scan(&present); err != nil {
		return err
	}
	if !present {
		return nil
	}
	refs, err := nonLocalPackages(ctx, db)
	if err != nil {
		return err
	}
	// Bound temporary storage before extraction, independently of the final
	// archive writer's aggregate limits (which also include campaign files).
	var expanded uint64
	entries := 0
	for _, ref := range refs {
		if !addonv3.ValidAddonID(ref.addonID) || !validGenerationID(ref.generationID) {
			return ErrInvalidPackage
		}
		dir := filepath.Join(stageRoot, ref.addonID, "generations", ref.generationID)
		if err = os.MkdirAll(dir, 0o750); err != nil {
			return err
		}
		archive := filepath.Join(dir, "package.zip")
		live, rootErr := os.OpenRoot(liveRoot)
		var copied bool
		if rootErr == nil {
			input, openErr := live.Open(filepath.Join(ref.addonID, "generations", ref.generationID, "package.zip"))
			if openErr == nil {
				err = copyBoundedArchive(ctx, input, archive, defaultMaxArchiveBytes)
				input.Close()
				copied = err == nil
			}
			live.Close()
		}
		if !copied {
			_ = os.Remove(archive)
			return fmt.Errorf("%w: %s %s", ErrPackageUnavailable, ref.addonID, ref.generationID)
		}
		report, err := inspector.InspectFile(ctx, archive)
		if err != nil || report.Manifest.ID != ref.addonID || report.ArchiveSHA256 != ref.generationID {
			return ErrInvalidPackage
		}
		expanded += uint64(report.ArchiveBytes) + report.ExpandedBytes
		entries += len(report.Files) + 1
		if expanded > 4<<30 || entries > 100_000 {
			return fmt.Errorf("%w: recovery packages exceed backup staging limits", ErrInvalidPackage)
		}
		report, err = inspector.InspectAndExtractFile(ctx, archive, filepath.Join(dir, "root"))
		if err != nil || report.Manifest.ID != ref.addonID || report.ArchiveSHA256 != ref.generationID {
			return ErrInvalidPackage
		}
		// Restoring this full backup must work offline. These copies are local in
		// the snapshot only; the running host's residency never changes.
		if _, err = db.ExecContext(ctx, `UPDATE addon_package_files SET status='local' WHERE addon_id=? AND generation_id=?`, ref.addonID, ref.generationID); err != nil {
			return err
		}
	}
	if _, err = db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return err
	}
	return nil
}

type packageIdentity struct{ addonID, generationID string }

// nonLocalPackages lists builds that the active installation or a recovery
// point needs but whose residency row says the files may be missing.
func nonLocalPackages(ctx context.Context, db *sql.DB) ([]packageIdentity, error) {
	rows, err := db.QueryContext(ctx, `SELECT f.addon_id,f.generation_id FROM addon_package_files f
 JOIN addon_package_states s USING(addon_id)
 WHERE f.status<>'local' AND (s.active_generation_id=f.generation_id OR EXISTS(SELECT 1 FROM recovery_points p,json_each(p.image_json,'$.packages') j WHERE j.value->>'addon_id'=f.addon_id AND j.value->>'active_generation_id'=f.generation_id))
 ORDER BY f.addon_id,f.generation_id LIMIT 513`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var refs []packageIdentity
	for rows.Next() {
		var ref packageIdentity
		if err = rows.Scan(&ref.addonID, &ref.generationID); err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	if len(refs) > 512 {
		return nil, ErrInvalidPackage
	}
	return refs, rows.Err()
}
