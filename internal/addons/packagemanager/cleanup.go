package packagemanager

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

var ErrCleanupPending = errors.New("approved package cleanup still has pending files")

// CleanupScope selects one exact package, or a bounded number of additional
// inactive packages to retain per add-on, besides active/recovery protections.
type CleanupScope struct {
	AddonID      string `json:"addonId,omitempty"`
	GenerationID string `json:"generationId,omitempty"`
	KeepInactive *int   `json:"keepInactive,omitempty"`
}

type CleanupGeneration struct {
	AddonID             string   `json:"addonId"`
	GenerationID        string   `json:"generationId"`
	Version             string   `json:"version"`
	InstalledAt         string   `json:"installedAt"`
	StateRevision       int64    `json:"stateRevision"`
	Bytes               int64    `json:"bytes"`
	Files               int      `json:"files"`
	FilesSHA256         string   `json:"filesSha256"`
	RecoveryPointIDs    []int64  `json:"recoveryPointIds"`
	ActivationReviewIDs []string `json:"activationReviewIds"`
	ReviewsSHA256       string   `json:"reviewsSha256"`
	HistoryRecords      int64    `json:"historyRecords"`
	SourceRecords       int64    `json:"sourceRecords"`
	Remove              bool     `json:"remove"`
	Protection          string   `json:"protection"`
}

type CleanupReview struct {
	ContractVersion  string              `json:"contractVersion"`
	Scope            CleanupScope        `json:"scope"`
	Generations      []CleanupGeneration `json:"generations"`
	RemoveCount      int                 `json:"removeCount"`
	ReclaimableBytes int64               `json:"reclaimableBytes"`
	PendingCleanups  int                 `json:"pendingCleanups"`
	ReviewSHA256     string              `json:"reviewSha256"`
}

type CleanupResult struct {
	ContractVersion string `json:"contractVersion"`
	ReviewSHA256    string `json:"reviewSha256,omitempty"`
	Applied         bool   `json:"applied"`
	Complete        bool   `json:"complete"`
	RemovedCount    int    `json:"removedCount"`
	ReclaimedBytes  int64  `json:"reclaimedBytes"`
	PendingCleanups int    `json:"pendingCleanups"`
}

func (scope CleanupScope) valid() bool {
	if scope.AddonID != "" && !validAddonPath(scope.AddonID) {
		return false
	}
	if scope.GenerationID != "" {
		return scope.AddonID != "" && validGenerationID(scope.GenerationID) && scope.KeepInactive == nil
	}
	return scope.KeepInactive != nil && *scope.KeepInactive >= 0 && *scope.KeepInactive <= 5
}

func (manager *Manager) PrepareCleanup(ctx context.Context, scope CleanupScope) (CleanupReview, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	tx, err := manager.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return CleanupReview{}, err
	}
	defer tx.Rollback()
	review, err := manager.cleanupReviewLocked(ctx, tx, scope)
	if err != nil {
		return CleanupReview{}, err
	}
	return review, tx.Commit()
}

func (manager *Manager) cleanupReviewLocked(ctx context.Context, tx *sql.Tx, scope CleanupScope) (CleanupReview, error) {
	if !scope.valid() {
		return CleanupReview{}, ErrInvalidPackage
	}
	review := CleanupReview{ContractVersion: "addon-package-cleanup-review.v1", Scope: scope, Generations: []CleanupGeneration{}}
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM addon_package_cleanups WHERE status='pending'`).Scan(&review.PendingCleanups); err != nil {
		return CleanupReview{}, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT g.addon_id, g.generation_id, g.addon_version, g.installed_at, s.revision,
  COALESCE(s.active_generation_id, ''), EXISTS(SELECT 1 FROM addon_package_uninstalls u WHERE u.addon_id=g.addon_id),
  g.generation_id=(SELECT newest.generation_id FROM addon_package_generations newest WHERE newest.addon_id=g.addon_id ORDER BY newest.installed_at DESC,newest.generation_id LIMIT 1)
  FROM addon_package_generations g JOIN addon_package_states s USING(addon_id)
  WHERE (? = '' OR g.addon_id = ?) AND (? = '' OR g.generation_id = ?) ORDER BY g.addon_id, g.installed_at DESC, g.generation_id`, scope.AddonID, scope.AddonID, scope.GenerationID, scope.GenerationID)
	if err != nil {
		return CleanupReview{}, err
	}
	type item struct {
		generation  CleanupGeneration
		active      string
		uninstalled bool
		newest      bool
	}
	var items []item
	for rows.Next() {
		var next item
		if err := rows.Scan(&next.generation.AddonID, &next.generation.GenerationID, &next.generation.Version, &next.generation.InstalledAt, &next.generation.StateRevision, &next.active, &next.uninstalled, &next.newest); err != nil {
			rows.Close()
			return CleanupReview{}, err
		}
		items = append(items, next)
		if len(items) > 512 {
			rows.Close()
			return CleanupReview{}, fmt.Errorf("%w: narrow cleanup to one add-on", ErrInvalidPackage)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return CleanupReview{}, err
	}
	rows.Close()
	retained := map[string]int{}
	for _, item := range items {
		generation := item.generation
		lastInstalled := item.newest && item.active == "" && !item.uninstalled
		generation.RecoveryPointIDs, generation.ActivationReviewIDs = []int64{}, []string{}
		if err := cleanupReferences(ctx, tx, &generation); err != nil {
			return CleanupReview{}, err
		}
		switch {
		case generation.GenerationID == item.active:
			generation.Protection = "active"
		case len(generation.RecoveryPointIDs) > 0:
			generation.Protection = "recovery"
		case lastInstalled:
			generation.Protection = "last-installed"
		case scope.KeepInactive != nil && retained[generation.AddonID] < *scope.KeepInactive:
			generation.Protection = "retention"
			retained[generation.AddonID]++
		default:
			generation.Remove = true
		}
		// Protected generations are never touched; only prospective deletion needs a
		// confined inventory. Missing/corrupt inactive files can still be retired.
		if generation.Remove {
			generation.Bytes, generation.Files, generation.FilesSHA256, err = manager.cleanupInventory(ctx, generation.AddonID, generation.GenerationID)
			if err != nil {
				return CleanupReview{}, err
			}
			review.RemoveCount++
			review.ReclaimableBytes += generation.Bytes
		}
		review.Generations = append(review.Generations, generation)
	}
	if scope.GenerationID != "" && len(review.Generations) == 0 {
		return CleanupReview{}, ErrGenerationNotFound
	}
	body, err := json.Marshal(review)
	if err != nil {
		return CleanupReview{}, err
	}
	digest := sha256.Sum256(body)
	review.ReviewSHA256 = hex.EncodeToString(digest[:])
	return review, nil
}

func cleanupReferences(ctx context.Context, tx *sql.Tx, generation *CleanupGeneration) error {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT p.point_id FROM recovery_points p, json_each(p.image_json, '$.packages') package
  WHERE package.value ->> 'addon_id' = ? AND package.value ->> 'active_generation_id' = ? ORDER BY p.point_id`, generation.AddonID, generation.GenerationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		generation.RecoveryPointIDs = append(generation.RecoveryPointIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	rows, err = tx.QueryContext(ctx, `SELECT review_id, status, COALESCE(approval_sha256, '') FROM addon_activation_reviews WHERE addon_id=? AND generation_id=? ORDER BY review_id`, generation.AddonID, generation.GenerationID)
	if err != nil {
		return err
	}
	reviewDigest := sha256.New()
	for rows.Next() {
		var id, status, approval string
		if err := rows.Scan(&id, &status, &approval); err != nil {
			rows.Close()
			return err
		}
		generation.ActivationReviewIDs = append(generation.ActivationReviewIDs, id)
		fmt.Fprintf(reviewDigest, "%s:%s:%s\n", id, status, approval)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	generation.ReviewsSHA256 = hex.EncodeToString(reviewDigest.Sum(nil))
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM addon_history_revisions WHERE addon_id=? AND generation_id=?`, generation.AddonID, generation.GenerationID).Scan(&generation.HistoryRecords); err != nil {
		return err
	}
	return tx.QueryRowContext(ctx, `SELECT count(*) FROM addon_github_generations WHERE addon_id=? AND generation_id=?`, generation.AddonID, generation.GenerationID).Scan(&generation.SourceRecords)
}

func (manager *Manager) Cleanup(ctx context.Context, scope CleanupScope, reviewSHA256 string) (CleanupResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if !scope.valid() || !validGenerationID(reviewSHA256) {
		return CleanupResult{}, ErrInvalidPackage
	}
	previous, complete, err := manager.store.cleanupReceipt(ctx, reviewSHA256)
	if err == nil {
		before, _ := json.Marshal(previous.Scope)
		supplied, _ := json.Marshal(scope)
		if string(before) != string(supplied) {
			return CleanupResult{}, ErrReviewStale
		}
		if complete {
			return cleanupResult(previous, true), nil
		}
		return manager.finishCleanupLocked(ctx, previous)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return CleanupResult{}, err
	}
	tx, err := manager.store.db.BeginTx(ctx, nil)
	if err != nil {
		return CleanupResult{}, err
	}
	defer tx.Rollback()
	// Reserve the SQLite writer before checking recovery references, so capture
	// cannot race the eligibility decision and metadata retirement.
	if _, err := tx.ExecContext(ctx, `UPDATE recovery_control SET revision=revision WHERE singleton=1`); err != nil {
		return CleanupResult{}, err
	}
	review, err := manager.cleanupReviewLocked(ctx, tx, scope)
	if err != nil {
		return CleanupResult{}, err
	}
	if review.ReviewSHA256 != reviewSHA256 {
		return CleanupResult{}, ErrReviewStale
	}
	if review.PendingCleanups != 0 {
		return CleanupResult{}, ErrCleanupPending
	}
	if review.RemoveCount == 0 {
		return CleanupResult{}, ErrReviewBlocked
	}
	body, err := json.Marshal(review)
	if err != nil {
		return CleanupResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO addon_package_cleanups(review_sha256, review_json, status, created_at) VALUES (?, ?, 'pending', ?)`, reviewSHA256, string(body), manager.store.now().UTC().Format(time.RFC3339Nano)); err != nil {
		return CleanupResult{}, err
	}
	affected := map[string]bool{}
	for _, generation := range review.Generations {
		if !generation.Remove {
			continue
		}
		for _, table := range []string{"addon_activation_reviews", "addon_github_generations", "addon_package_generations"} {
			if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE addon_id=? AND generation_id=?", generation.AddonID, generation.GenerationID); err != nil {
				return CleanupResult{}, err
			}
		}
		affected[generation.AddonID] = true
	}
	for addonID := range affected {
		if _, err := tx.ExecContext(ctx, `UPDATE addon_package_states SET revision=revision+1, updated_at=? WHERE addon_id=?`, manager.store.now().UTC().Format(time.RFC3339Nano), addonID); err != nil {
			return CleanupResult{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return CleanupResult{}, err
	}
	return manager.finishCleanupLocked(ctx, review)
}

func cleanupResult(review CleanupReview, complete bool) CleanupResult {
	result := CleanupResult{ContractVersion: "addon-package-cleanup-result.v1", ReviewSHA256: review.ReviewSHA256, Applied: true, Complete: complete, RemovedCount: review.RemoveCount}
	if complete {
		result.ReclaimedBytes = review.ReclaimableBytes
	} else {
		result.PendingCleanups = 1
	}
	return result
}

func (manager *Manager) finishCleanupLocked(ctx context.Context, review CleanupReview) (CleanupResult, error) {
	result := cleanupResult(review, false)
	if err := validateCleanupReceipt(review, review.ReviewSHA256); err != nil {
		return result, err
	}
	for _, generation := range review.Generations {
		if !generation.Remove {
			continue
		}
		if err := ctx.Err(); err != nil {
			return result, nil
		}
		// Never resume against a generation that has reappeared in metadata.
		var present int
		if err := manager.store.db.QueryRowContext(ctx, "SELECT count(*) FROM addon_package_generations WHERE addon_id=? AND generation_id=?", generation.AddonID, generation.GenerationID).Scan(&present); err != nil {
			return result, nil
		}
		if present != 0 {
			return result, ErrCleanupPending
		}
		if err := manager.removeCleanupGeneration(generation.AddonID, generation.GenerationID); err != nil {
			manager.logger.Error("approved package cleanup has pending files", "addonId", generation.AddonID, "generationId", generation.GenerationID, "error", err)
			return result, nil
		}
		delete(manager.contentCache, generation.AddonID+":"+generation.GenerationID)
	}
	if _, err := manager.store.db.ExecContext(ctx, `UPDATE addon_package_cleanups SET status='complete', completed_at=? WHERE review_sha256=? AND status='pending'`, manager.store.now().UTC().Format(time.RFC3339Nano), review.ReviewSHA256); err != nil {
		return result, nil
	}
	return cleanupResult(review, true), nil
}

func (store *store) cleanupReceipt(ctx context.Context, hash string) (CleanupReview, bool, error) {
	var body, status string
	if err := store.db.QueryRowContext(ctx, `SELECT review_json, status FROM addon_package_cleanups WHERE review_sha256=?`, hash).Scan(&body, &status); err != nil {
		return CleanupReview{}, false, err
	}
	var review CleanupReview
	if err := json.Unmarshal([]byte(body), &review); err != nil {
		return CleanupReview{}, false, err
	}
	if err := validateCleanupReceipt(review, hash); err != nil {
		return CleanupReview{}, false, err
	}
	return review, status == "complete", nil
}

func validateCleanupReceipt(review CleanupReview, hash string) error {
	if review.ContractVersion != "addon-package-cleanup-review.v1" || !review.Scope.valid() || !validGenerationID(hash) || review.ReviewSHA256 != hash || review.RemoveCount < 1 || len(review.Generations) > 512 {
		return ErrInvalidPackage
	}
	count, bytes := 0, int64(0)
	seen := map[string]bool{}
	for _, g := range review.Generations {
		key := g.AddonID + ":" + g.GenerationID
		if !validAddonPath(g.AddonID) || !validGenerationID(g.GenerationID) || seen[key] || g.Bytes < 0 {
			return ErrInvalidPackage
		}
		seen[key] = true
		if !g.Remove {
			continue
		}
		if g.Protection != "" || len(g.RecoveryPointIDs) != 0 || review.Scope.AddonID != "" && review.Scope.AddonID != g.AddonID || review.Scope.GenerationID != "" && review.Scope.GenerationID != g.GenerationID {
			return ErrInvalidPackage
		}
		count++
		bytes += g.Bytes
	}
	if count != review.RemoveCount || bytes != review.ReclaimableBytes {
		return ErrInvalidPackage
	}
	review.ReviewSHA256 = ""
	body, err := json.Marshal(review)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != hash {
		return ErrInvalidPackage
	}
	return nil
}

func (manager *Manager) RetryCleanups(ctx context.Context) (CleanupResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.retryCleanupsLocked(ctx)
}

func (manager *Manager) retryCleanupsLocked(ctx context.Context) (CleanupResult, error) {
	result := CleanupResult{ContractVersion: "addon-package-cleanup-result.v1", Applied: true, Complete: true}
	rows, err := manager.store.db.QueryContext(ctx, `SELECT review_sha256, review_json FROM addon_package_cleanups WHERE status='pending' ORDER BY created_at, review_sha256`)
	if err != nil {
		return result, err
	}
	var reviews []CleanupReview
	for rows.Next() {
		var hash, body string
		var review CleanupReview
		if err := rows.Scan(&hash, &body); err != nil {
			rows.Close()
			return result, err
		}
		if err := json.Unmarshal([]byte(body), &review); err != nil {
			rows.Close()
			return result, err
		}
		if err := validateCleanupReceipt(review, hash); err != nil {
			rows.Close()
			return result, err
		}
		reviews = append(reviews, review)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return result, err
	}
	rows.Close()
	for _, review := range reviews {
		completed, err := manager.finishCleanupLocked(ctx, review)
		if err != nil {
			return result, err
		}
		result.RemovedCount += completed.RemovedCount
		result.ReclaimedBytes += completed.ReclaimedBytes
		result.PendingCleanups += completed.PendingCleanups
	}
	result.Complete = result.PendingCleanups == 0
	return result, nil
}

// WithPackageSnapshot keeps a live backup's database image and immutable files
// coherent with staging, cleanup and other lifecycle transitions. Offline tools
// instead hold the exclusive host process lock for their entire operation.
func (manager *Manager) WithPackageSnapshot(ctx context.Context, snapshot func() error) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	return snapshot()
}

func (manager *Manager) cleanupRoot(addonID, generationID string) (*os.Root, string, error) {
	if !validAddonPath(addonID) || !validGenerationID(generationID) {
		return nil, "", ErrInvalidPackage
	}
	root, err := os.OpenRoot(manager.directory)
	if err != nil {
		return nil, "", err
	}
	relative := filepath.Join(addonID, "generations", generationID)
	for _, name := range []string{addonID, filepath.Join(addonID, "generations"), relative} {
		info, err := root.Lstat(name)
		if errors.Is(err, fs.ErrNotExist) {
			return root, relative, nil
		}
		if err != nil {
			root.Close()
			return nil, "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, "", fmt.Errorf("%w: package directory is not a real directory", ErrInvalidPackage)
		}
	}
	return root, relative, nil
}

func (manager *Manager) cleanupInventory(ctx context.Context, addonID, generationID string) (int64, int, string, error) {
	root, relative, err := manager.cleanupRoot(addonID, generationID)
	if err != nil {
		return 0, 0, "", err
	}
	defer root.Close()
	digest := sha256.New()
	var bytes int64
	files := 0
	var inventory []string
	err = fs.WalkDir(root.FS(), filepath.ToSlash(relative), func(name string, entry fs.DirEntry, walkErr error) error {
		if errors.Is(walkErr, fs.ErrNotExist) && name == filepath.ToSlash(relative) {
			return nil
		}
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("%w: package files must be regular", ErrInvalidPackage)
		}
		if info.IsDir() {
			return nil
		}
		files++
		bytes += info.Size()
		if files > 100000 || bytes > 4*1024*1024*1024 {
			return fmt.Errorf("%w: package file inventory is too large", ErrInvalidPackage)
		}
		inventory = append(inventory, fmt.Sprintf("%s:%d:%d:%d", name, info.Size(), info.Mode(), info.ModTime().UnixNano()))
		return nil
	})
	if err != nil {
		return 0, 0, "", err
	}
	sort.Strings(inventory)
	for _, line := range inventory {
		fmt.Fprintln(digest, line)
	}
	return bytes, files, hex.EncodeToString(digest.Sum(nil)), nil
}

func (manager *Manager) removeCleanupGeneration(addonID, generationID string) error {
	root, relative, err := manager.cleanupRoot(addonID, generationID)
	if err != nil {
		return err
	}
	defer root.Close()
	return root.RemoveAll(relative)
}
