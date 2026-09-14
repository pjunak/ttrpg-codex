package packagemanager

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
)

// MaterializePackageBackup operates only on the isolated database snapshot and
// an empty temporary package root. The caller holds the lifecycle/maintenance
// lock protecting live package files for the duration of backup publication.
func MaterializePackageBackup(ctx context.Context, databasePath, liveRoot, stageRoot string, inspector *packageinspect.Inspector, fetch PackageFetcher) error {
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
	refs, err := packageReferences(ctx, db, -1)
	if err != nil {
		return err
	}
	// Bound temporary storage before extraction, independently of the final
	// archive writer's aggregate limits (which also include campaign files).
	var expanded uint64
	entries := 0
	for _, ref := range refs {
		if !validAddonPath(ref.AddonID) || !validGenerationID(ref.GenerationID) {
			return ErrInvalidPackage
		}
		dir := filepath.Join(stageRoot, ref.AddonID, "generations", ref.GenerationID)
		if err = os.MkdirAll(dir, 0o750); err != nil {
			return err
		}
		archive := filepath.Join(dir, "package.zip")
		live, rootErr := os.OpenRoot(liveRoot)
		var copied bool
		if rootErr == nil {
			input, openErr := live.Open(filepath.Join(ref.AddonID, "generations", ref.GenerationID, "package.zip"))
			if openErr == nil {
				err = copyBoundedArchive(ctx, input, archive, defaultMaxArchiveBytes)
				input.Close()
				copied = err == nil
			}
			live.Close()
		}
		if !copied {
			_ = os.Remove(archive)
			if fetch == nil {
				return fmt.Errorf("%w: %s %s", ErrPackageUnavailable, ref.AddonID, ref.GenerationID)
			}
			err = fetch(ctx, ref, archive)
		}
		if err != nil {
			return fmt.Errorf("%w: %s %s", ErrPackageUnavailable, ref.AddonID, ref.GenerationID)
		}
		report, err := inspector.InspectFile(ctx, archive)
		if err != nil || report.Manifest.ID != ref.AddonID || report.ArchiveSHA256 != ref.GenerationID {
			return ErrInvalidPackage
		}
		expanded += uint64(report.ArchiveBytes) + report.ExpandedBytes
		entries += len(report.Files) + 1
		if expanded > 4<<30 || entries > 100_000 {
			return fmt.Errorf("%w: recovery packages exceed backup staging limits", ErrInvalidPackage)
		}
		report, err = inspector.InspectAndExtractFile(ctx, archive, filepath.Join(dir, "root"))
		if err != nil || report.Manifest.ID != ref.AddonID || report.ArchiveSHA256 != ref.GenerationID {
			return ErrInvalidPackage
		}
		// Restoring this full backup must work offline. These copies are local in
		// the snapshot only; the running host's residency never changes.
		if _, err = db.ExecContext(ctx, `UPDATE addon_package_files SET status='local' WHERE addon_id=? AND generation_id=?`, ref.AddonID, ref.GenerationID); err != nil {
			return err
		}
	}
	if _, err = db.ExecContext(ctx, `UPDATE addon_package_retention SET initial_cleanup_complete=1 WHERE singleton=1`); err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return err
	}
	return nil
}
