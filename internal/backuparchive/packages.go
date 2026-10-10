package backuparchive

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"regexp"

	"github.com/pjunak/ttrpg-codex/contracts/addons/v3"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
)

func validatePackageImage(ctx context.Context, databasePath, packageRoot string) error {
	db, err := codexsqlite.Open(ctx, databasePath)
	if err != nil {
		return err
	}
	defer db.Close()
	return validatePackageReferences(ctx, db, packageRoot)
}
func validatePackageReferences(ctx context.Context, db *sql.DB, packageRoot string) error {
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
	validHash := regexp.MustCompile(`^[a-f0-9]{64}$`)
	for _, ref := range refs {
		if !addonv3.ValidAddonID(ref.addon) || !validHash.MatchString(ref.hash) {
			return fmt.Errorf("%w: invalid recovery package identity", ErrInvalidArchive)
		}
		root := filepath.Join(packageRoot, ref.addon, "generations", ref.hash)
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
