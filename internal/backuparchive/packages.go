package backuparchive

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"regexp"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
)

func validatePackageImage(ctx context.Context, databasePath, packageRoot string, replacements map[string]string) error {
	db, err := codexsqlite.Open(ctx, databasePath)
	if err != nil {
		return err
	}
	defer db.Close()
	return validatePackageReferences(ctx, db, packageRoot, replacements)
}
func validatePackageReferences(ctx context.Context, db *sql.DB, packageRoot string, replacements map[string]string) error {
	var present bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='addon_package_states')`).Scan(&present); err != nil {
		return err
	}
	if !present {
		return nil
	}
	rows, err := db.QueryContext(ctx, `SELECT addon_id,active_generation_id FROM addon_package_states WHERE active_generation_id IS NOT NULL
 UNION SELECT j.value->>'addon_id',j.value->>'active_generation_id' FROM recovery_points p,json_each(p.image_json,'$.packages') j LIMIT 513`)
	if err != nil {
		return err
	}
	type ref struct{ addon, hash string }
	var refs []ref
	for rows.Next() {
		var item ref
		if err = rows.Scan(&item.addon, &item.hash); err != nil {
			rows.Close()
			return err
		}
		refs = append(refs, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(refs) > 512 {
		return fmt.Errorf("%w: too many recovery packages", ErrInvalidArchive)
	}
	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		return err
	}
	validAddon := regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
	validHash := regexp.MustCompile(`^[a-f0-9]{64}$`)
	for _, ref := range refs {
		if len(ref.addon) > 80 || !validAddon.MatchString(ref.addon) || !validHash.MatchString(ref.hash) {
			return fmt.Errorf("%w: invalid recovery package identity", ErrInvalidArchive)
		}
		root := filepath.Join(packageRoot, ref.addon, "generations", ref.hash)
		if replacement, ok := replacements[ref.addon+"/"+ref.hash]; ok {
			root = replacement
		}
		report, err := inspector.InspectFile(ctx, filepath.Join(root, "package.zip"))
		if err != nil || report.Manifest.ID != ref.addon || report.ArchiveSHA256 != ref.hash {
			return fmt.Errorf("%w: required package %s %s is missing or invalid", ErrInvalidArchive, ref.addon, ref.hash)
		}
		if err = inspector.VerifyExtracted(ctx, filepath.Join(root, "root"), report); err != nil {
			return fmt.Errorf("%w: required package %s %s has invalid extracted files", ErrInvalidArchive, ref.addon, ref.hash)
		}
	}
	return nil
}

// normalizeRestoredPackageFiles runs only in the already verified restore stage.
// Old backups gain the same offline residency as newly materialized archives.
func normalizeRestoredPackageFiles(ctx context.Context, db *sql.DB) error {
	var present bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='addon_package_files')").Scan(&present); err != nil {
		return err
	}
	if !present {
		return nil
	}
	if _, err := db.ExecContext(ctx, `UPDATE addon_package_files SET status='local'
 WHERE (addon_id,generation_id) IN (
 SELECT addon_id,active_generation_id FROM addon_package_states WHERE active_generation_id IS NOT NULL
 UNION SELECT j.value->>'addon_id',j.value->>'active_generation_id' FROM recovery_points p,json_each(p.image_json,'$.packages') j)`); err != nil {
		return err
	}
	_, err := db.ExecContext(ctx, "UPDATE addon_package_retention SET initial_cleanup_complete=1 WHERE singleton=1")
	return err
}
