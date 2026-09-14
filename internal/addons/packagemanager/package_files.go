package packagemanager

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// PackageLocator is retained independently of local package-file residency.
// Download paths are provider-owned identifiers, never client-supplied URLs.
type PackageLocator struct {
	Source       json.RawMessage `json:"source"`
	RemoteID     string          `json:"remoteId"`
	DownloadPath string          `json:"downloadPath"`
	Digest       string          `json:"digest"`
}
type PackageReference struct {
	AddonID      string `json:"addonId"`
	GenerationID string `json:"generationId"`
	Version      string `json:"version"`
	// Available means verified file residency in an installed registration.
	Available    bool             `json:"available"`
	Active       bool             `json:"active"`
	Downloadable bool             `json:"downloadable"`
	Locators     []PackageLocator `json:"-"`
}
type PackageStorage struct {
	ContractVersion string             `json:"contractVersion"`
	Automatic       bool               `json:"automatic"`
	Pending         int                `json:"pending"`
	Packages        []PackageReference `json:"packages"`
}

// PackageFetcher writes a historical ZIP to destination. The manager independently
// inspects its manifest and verifies the exact archive hash before publication.
type PackageFetcher func(context.Context, PackageReference, string) error

var ErrPackageUnavailable = errors.New("exact historical package is unavailable; supply its matching ZIP")

// pointID selects one recovery point; zero lists history and -1 selects missing
// files required by the active installation or any retained point for a backup.
func packageReferences(ctx context.Context, db *sql.DB, pointID int64) ([]PackageReference, error) {
	if pointID != 0 {
		var missing bool
		if err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM recovery_points p,json_each(p.image_json,'$.packages') j WHERE (?=-1 OR p.point_id=?) AND NOT EXISTS(SELECT 1 FROM addon_package_generations g WHERE g.addon_id=j.value->>'addon_id' AND g.generation_id=j.value->>'active_generation_id'))`, pointID, pointID).Scan(&missing); err != nil {
			return nil, err
		} else if missing {
			return nil, ErrPackageUnavailable
		}
	}
	query := `SELECT g.addon_id,g.generation_id,g.addon_version,
 COALESCE(f.status,'local')='local' AND NOT EXISTS(SELECT 1 FROM addon_package_uninstalls u WHERE u.addon_id=g.addon_id),COALESCE(s.active_generation_id,'')=g.generation_id,
 COALESCE(f.status,'local')='local' AND EXISTS(SELECT 1 FROM addon_package_uninstalls u WHERE u.addon_id=g.addon_id)
 FROM addon_package_generations g JOIN addon_package_states s USING(addon_id)
 LEFT JOIN addon_package_files f USING(addon_id,generation_id)
 WHERE (?=-1 AND f.status IN ('pending','remote') AND (s.active_generation_id=g.generation_id OR EXISTS(SELECT 1 FROM recovery_points p,json_each(p.image_json,'$.packages') j WHERE j.value->>'addon_id'=g.addon_id AND j.value->>'active_generation_id'=g.generation_id)))
 OR (?=0 AND (f.status IN ('pending','remote') OR (g.generation_id<>COALESCE(s.active_generation_id,'') AND NOT EXISTS(SELECT 1 FROM addon_github_generations gh WHERE gh.addon_id=g.addon_id AND gh.generation_id=g.generation_id AND gh.source_json->>'channel'='release') AND EXISTS(SELECT 1 FROM recovery_points p,json_each(p.image_json,'$.packages') j WHERE j.value->>'addon_id'=g.addon_id AND j.value->>'active_generation_id'=g.generation_id))) AND NOT EXISTS(SELECT 1 FROM addon_package_uninstalls u WHERE u.addon_id=g.addon_id))
 OR (? > 0 AND EXISTS(SELECT 1 FROM recovery_points p,json_each(p.image_json,'$.packages') j
 WHERE p.point_id=? AND j.value->>'addon_id'=g.addon_id AND j.value->>'active_generation_id'=g.generation_id))
 ORDER BY g.addon_id,g.installed_at DESC,g.generation_id LIMIT CASE WHEN ?=0 THEN 512 ELSE 513 END`
	rows, err := db.QueryContext(ctx, query, pointID, pointID, pointID, pointID, pointID)
	if err != nil {
		return nil, err
	}
	refs := []PackageReference{}
	for rows.Next() {
		var ref PackageReference
		if err = rows.Scan(&ref.AddonID, &ref.GenerationID, &ref.Version, &ref.Available, &ref.Active, &ref.Downloadable); err != nil {
			rows.Close()
			return nil, err
		}
		refs = append(refs, ref)
		if len(refs) > 512 {
			rows.Close()
			return nil, ErrInvalidPackage
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range refs {
		refs[i].Locators, err = packageLocators(ctx, db, refs[i].AddonID, refs[i].GenerationID)
		if err != nil {
			return nil, err
		}
		refs[i].Downloadable = refs[i].Downloadable || len(refs[i].Locators) > 0
	}
	return refs, nil
}

func packageLocators(ctx context.Context, db *sql.DB, addonID, generationID string) ([]PackageLocator, error) {
	rows, err := db.QueryContext(ctx, "SELECT source_json,remote_id,download_path,digest FROM addon_github_generations WHERE addon_id=? AND generation_id=? ORDER BY (source_json->>'channel'='release') DESC,(download_path<>'') DESC,rowid DESC LIMIT 32", addonID, generationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var locators []PackageLocator
	for rows.Next() {
		var locator PackageLocator
		var source string
		if err = rows.Scan(&source, &locator.RemoteID, &locator.DownloadPath, &locator.Digest); err != nil {
			return nil, err
		}
		locator.Source = json.RawMessage(source)
		locators = append(locators, locator)
	}
	return locators, rows.Err()
}

// ConfigurePackageRetention is called after healthy startup recovery and before
// serving requests. Existing superseded files get the same policy as later updates.
func (manager *Manager) ConfigurePackageRetention(ctx context.Context, enabled bool, fetch PackageFetcher) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.automaticCleanup = enabled
	manager.packageFetcher = fetch
	if err := manager.retryPackageEvictionsLocked(ctx); err != nil {
		return err
	}
	if !enabled {
		return nil
	}
	var initialized bool
	if err := manager.store.db.QueryRowContext(ctx, `SELECT initial_cleanup_complete FROM addon_package_retention WHERE singleton=1`).Scan(&initialized); err != nil {
		return err
	}
	if initialized {
		return nil
	}
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return err
	}
	for _, state := range states {
		if active, ok := manager.runtimes[state.AddonID]; !ok || active.generation.GenerationID != state.ActiveGenerationID {
			return ErrCleanupPending
		}
	}
	ids, err := manager.store.installedAddonIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := manager.evictSupersededLocked(ctx, id); err != nil {
			return err
		}
	}
	_, err = manager.store.db.ExecContext(ctx, `UPDATE addon_package_retention SET initial_cleanup_complete=1 WHERE singleton=1`)
	return err
}

func (manager *Manager) PackageStorage(ctx context.Context, pointID int64, expectedRevision int64) (PackageStorage, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if pointID < 0 {
		return PackageStorage{}, ErrInvalidPackage
	}
	if pointID > 0 {
		var revision int64
		var exists bool
		if err := manager.store.db.QueryRowContext(ctx, `SELECT revision,EXISTS(SELECT 1 FROM recovery_points WHERE point_id=?) FROM recovery_control WHERE singleton=1`, pointID).Scan(&revision, &exists); err != nil {
			return PackageStorage{}, err
		}
		if !exists || revision != expectedRevision {
			return PackageStorage{}, ErrReviewStale
		}
	}
	refs, err := packageReferences(ctx, manager.store.db, pointID)
	if err != nil {
		return PackageStorage{}, err
	}
	result := PackageStorage{ContractVersion: "addon-package-storage.v1", Automatic: manager.automaticCleanup, Packages: refs}
	err = manager.store.db.QueryRowContext(ctx, `SELECT count(*) FROM addon_package_files WHERE status='pending'`).Scan(&result.Pending)
	return result, err
}

func (manager *Manager) evictSupersededLocked(ctx context.Context, addonID string) error {
	if !manager.automaticCleanup {
		return nil
	}
	tx, err := manager.store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Reserve the writer before selecting candidates. Reviews and recovery capture
	// cannot interleave with journaling, and lifecycle operations share manager.mu.
	if _, err = tx.ExecContext(ctx, `UPDATE recovery_control SET revision=revision WHERE singleton=1`); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO addon_package_files(addon_id,generation_id,status,updated_at)
 SELECT g.addon_id,g.generation_id,'pending',? FROM addon_package_generations g JOIN addon_package_states s USING(addon_id)
 WHERE g.addon_id=? AND g.generation_id<>COALESCE(s.active_generation_id,(SELECT e.generation_id FROM addon_lifecycle_events e WHERE e.addon_id=g.addon_id AND e.kind='disabled' ORDER BY e.sequence DESC LIMIT 1))
 AND (EXISTS(SELECT 1 FROM addon_github_generations gh WHERE gh.addon_id=g.addon_id AND gh.generation_id=g.generation_id AND gh.source_json->>'channel'='release') OR NOT EXISTS(SELECT 1 FROM recovery_points p,json_each(p.image_json,'$.packages') j WHERE j.value->>'addon_id'=g.addon_id AND j.value->>'active_generation_id'=g.generation_id))
 AND NOT EXISTS(SELECT 1 FROM addon_package_files f WHERE f.addon_id=g.addon_id AND f.generation_id=g.generation_id AND f.status<>'local')
 AND NOT EXISTS(SELECT 1 FROM addon_activation_reviews r WHERE r.addon_id=g.addon_id AND r.generation_id=g.generation_id AND r.status IN ('prepared','approved') AND r.expected_state_revision=s.revision)
 ON CONFLICT(addon_id,generation_id) DO UPDATE SET status='pending',updated_at=excluded.updated_at`, manager.store.now().UTC().Format(time.RFC3339Nano), addonID)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	return manager.retryPackageEvictionsLocked(ctx)
}
func (manager *Manager) retryPackageEvictionsLocked(ctx context.Context) error {
	for {
		rows, err := manager.store.db.QueryContext(ctx, `SELECT addon_id,generation_id FROM addon_package_files WHERE status='pending' ORDER BY addon_id,generation_id LIMIT 128`)
		if err != nil {
			return err
		}
		var refs []PackageReference
		for rows.Next() {
			var r PackageReference
			if err = rows.Scan(&r.AddonID, &r.GenerationID); err != nil {
				rows.Close()
				return err
			}

			refs = append(refs, r)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(refs) == 0 {
			return nil
		}
		for _, ref := range refs {
			if err := ctx.Err(); err != nil {
				return err
			}
			var active bool
			if err = manager.store.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM addon_package_states WHERE addon_id=? AND active_generation_id=?)`, ref.AddonID, ref.GenerationID).Scan(&active); err != nil {
				return err
			}
			if active {
				return ErrCleanupPending
			}
			if _, _, _, err = manager.cleanupInventory(ctx, ref.AddonID, ref.GenerationID); err != nil {
				return err
			}
			if err = manager.removeCleanupGeneration(ref.AddonID, ref.GenerationID); err != nil {
				return err
			}
			if _, err = manager.store.db.ExecContext(ctx, `UPDATE addon_package_files SET status='remote',updated_at=? WHERE addon_id=? AND generation_id=? AND status='pending'`, manager.store.now().UTC().Format(time.RFC3339Nano), ref.AddonID, ref.GenerationID); err != nil {
				return err
			}
			delete(manager.contentCache, ref.AddonID+":"+ref.GenerationID)
		}
	}
}
func (manager *Manager) RetryPackageEvictions(ctx context.Context) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.retryPackageEvictionsLocked(ctx)
}

func (manager *Manager) fetchPackage(ctx context.Context, ref PackageReference, destination string) error {
	if manager.packageFetcher == nil || len(ref.Locators) == 0 {
		return ErrPackageUnavailable
	}
	if err := manager.packageFetcher(ctx, ref, destination); err != nil {
		return fmt.Errorf("%w: %v", ErrPackageUnavailable, err)
	}
	report, err := manager.inspector.InspectFile(ctx, destination)
	if err != nil || report.Manifest.ID != ref.AddonID || report.ArchiveSHA256 != ref.GenerationID {
		return ErrInvalidPackage
	}
	return nil
}

// RestorePackage only stages bytes. It never approves permissions or activates.
func (manager *Manager) RestorePackage(ctx context.Context, addonID, generationID string) (Generation, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if !validAddonPath(addonID) || !validGenerationID(generationID) {
		return Generation{}, ErrInvalidPackage
	}
	generation, err := scanGeneration(manager.store.db.QueryRowContext(ctx, "SELECT addon_id,generation_id,addon_version,archive_sha256,installed_at,last_attempt_at,last_activated_at,COALESCE(last_error,'') FROM addon_package_generations WHERE addon_id=? AND generation_id=?", addonID, generationID))
	if err != nil {
		return Generation{}, err
	}
	var status string
	err = manager.store.db.QueryRowContext(ctx, `SELECT status FROM addon_package_files WHERE addon_id=? AND generation_id=?`, addonID, generationID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) || status == "local" {
		report, loadErr := manager.loadPackage(ctx, addonID, generationID)
		if loadErr != nil {
			return Generation{}, loadErr
		}
		return manager.store.recordGeneration(ctx, packageRecord{Manifest: report.Manifest, GenerationID: generationID, ArchiveSHA256: generationID})
	}
	if err != nil {
		return Generation{}, err
	}
	if status == "pending" {
		return Generation{}, ErrCleanupPending
	}
	// A crash after publishing verified files but before marking them local is
	// completed without another network request. Partial directories still fail inspection.
	if report, loadErr := manager.loadPackage(ctx, addonID, generationID); loadErr == nil {
		return manager.store.recordGeneration(ctx, packageRecord{Manifest: report.Manifest, GenerationID: generationID, ArchiveSHA256: generationID})
	}
	locators, err := packageLocators(ctx, manager.store.db, addonID, generationID)
	if err != nil {
		return Generation{}, err
	}
	ref := PackageReference{AddonID: addonID, GenerationID: generationID, Version: generation.Version, Locators: locators}

	stage, err := os.MkdirTemp(manager.stagingDirectory, "restore-")
	if err != nil {
		return Generation{}, err
	}
	defer os.RemoveAll(stage)
	archive := filepath.Join(stage, "package.zip")
	if err = manager.fetchPackage(ctx, ref, archive); err != nil {
		return Generation{}, err
	}
	input, err := os.Open(archive)
	if err != nil {
		return Generation{}, err
	}
	defer input.Close()
	return manager.stageArchiveLocked(ctx, input, nil)
}

func (manager *Manager) cleanupAfterActivationLocked(ctx context.Context, result *ActivationResult) {
	if result.CleanupError != "" || result.RecoveryError != "" {
		return
	}
	for _, recovered := range result.RecoveryResults {
		if !recovered.Recovered {
			return
		}
	}
	if active, ok := manager.runtimes[result.State.AddonID]; !ok || active.generation.GenerationID != result.State.ActiveGenerationID {
		return
	}
	// Activation is already committed. Cleanup failure must not turn a successful
	// activation into a retryable activation error.
	if err := manager.evictSupersededLocked(ctx, result.State.AddonID); err != nil {
		result.CleanupError = "Package file cleanup is pending; it will retry at startup or the next update."
		manager.logger.Error("automatic package cleanup pending", "addonId", result.State.AddonID, "error", err)
	}
}

func (manager *Manager) PrepareRecoveryPackages(ctx context.Context, pointID, expectedRevision int64) (PackageStorage, error) {
	if pointID < 1 {
		return PackageStorage{}, ErrInvalidPackage
	}
	storage, err := manager.PackageStorage(ctx, pointID, expectedRevision)
	if err != nil {
		return PackageStorage{}, err
	}
	// Fetch the entire required set before presenting activation actions. Staging
	// is inert; failed or stale preparation cannot partially restore campaign data.
	for _, ref := range storage.Packages {
		if !ref.Available {
			if _, err = manager.RestorePackage(ctx, ref.AddonID, ref.GenerationID); err != nil {
				return PackageStorage{}, err
			}
		}
	}
	return manager.PackageStorage(ctx, pointID, expectedRevision)
}
