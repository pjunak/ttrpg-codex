package packagemanager

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

// Language packs (ADR-0007) add translations to an active add-on without a
// new package. The host stores each downloaded pack ZIP by its SHA-256 under
// <package directory>/.language-packs and one row per add-on and language in
// addon_language_packs. Fetch results stay in memory: the host checks again
// at every start.

var (
	// ErrLanguagePackMismatch marks a pack for another add-on, language or
	// add-on version.
	ErrLanguagePackMismatch = errors.New("language pack does not match the active add-on")
	// ErrLanguagePackStale marks a pack fetched for a generation that is no
	// longer active.
	ErrLanguagePackStale = errors.New("add-on generation changed while its language pack was fetched")
)

// Language pack statuses on the browser graph.
const (
	PackAvailable = "available" // published, language not enabled
	PackInstalled = "installed"
	PackOutdated  = "outdated" // stored, but its versions exclude the active add-on
	PackNone      = "none"     // no published pack fits the active add-on
	PackFailed    = "failed"
)

// LanguagePackTarget is one active add-on and the packs stored for it.
type LanguagePackTarget struct {
	AddonID      string
	GenerationID string
	Version      string
	// Packs maps each language whose stored pack is readable and applies to
	// Version to the pack's archive SHA-256.
	Packs map[string]string
}

// LanguagePackCheck is the outcome of one check of an add-on's packs.
type LanguagePackCheck struct {
	AddonID      string
	GenerationID string
	// Available lists the languages the add-on publishes packs for.
	Available []string
	// Results holds PackNone, or PackFailed with an error code, by checked
	// language; a language whose pack was installed or kept is absent.
	Results map[string]LanguagePackResult
}

type LanguagePackResult struct {
	Status string
	// Error is a short code: unavailable, rate-limited, tls, invalid or storage.
	Error string
}

type storedLanguagePack struct {
	sha256 string
	// report is nil when the stored file is missing or no longer valid.
	report *packageinspect.PackReport
}

type mergedPackCatalog struct {
	catalog packageinspect.LocaleCatalog
	source  string
	err     error
}

type effectiveCatalog struct {
	packageinspect.LocaleCatalog
	source string
}

func (manager *Manager) languagePackDirectory() string {
	return filepath.Join(manager.directory, ".language-packs")
}

func (manager *Manager) languagePackPath(digest string) string {
	return filepath.Join(manager.languagePackDirectory(), digest+".zip")
}

// loadLanguagePacksLocked reads every stored pack. A missing or invalid file
// leaves its pack unusable until the next check replaces it.
func (manager *Manager) loadLanguagePacksLocked(ctx context.Context) error {
	rows, err := manager.store.db.QueryContext(ctx, `SELECT addon_id, locale, pack_sha256 FROM addon_language_packs ORDER BY addon_id, locale`)
	if err != nil {
		return fmt.Errorf("list language packs: %w", err)
	}
	type row struct{ addonID, locale, digest string }
	var stored []row
	for rows.Next() {
		var item row
		if err := rows.Scan(&item.addonID, &item.locale, &item.digest); err != nil {
			rows.Close()
			return err
		}
		stored = append(stored, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	packs := map[string]map[string]storedLanguagePack{}
	for _, item := range stored {
		pack := storedLanguagePack{sha256: item.digest}
		report, err := manager.inspector.InspectPackFile(ctx, manager.languagePackPath(item.digest))
		if err == nil && report.ArchiveSHA256 == item.digest && report.Manifest.AddonID == item.addonID && report.Manifest.Locale == item.locale {
			pack.report = &report
		} else if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		} else {
			manager.logger.Warn("stored language pack is unusable", "addonId", item.addonID, "locale", item.locale, "error", err)
		}
		if packs[item.addonID] == nil {
			packs[item.addonID] = map[string]storedLanguagePack{}
		}
		packs[item.addonID][item.locale] = pack
	}
	manager.languagePacks = packs
	manager.packCatalogs = map[string]mergedPackCatalog{}
	return nil
}

// LanguagePackTargets lists every recovered active add-on with its stored packs.
func (manager *Manager) LanguagePackTargets(ctx context.Context) ([]LanguagePackTarget, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]LanguagePackTarget, 0, len(states))
	for _, state := range states {
		active, recovered := manager.runtimes[state.AddonID]
		if !recovered || active.generation.GenerationID != state.ActiveGenerationID {
			continue
		}
		target := LanguagePackTarget{AddonID: state.AddonID, GenerationID: state.ActiveGenerationID, Version: active.generation.Version, Packs: map[string]string{}}
		for locale, pack := range manager.languagePacks[state.AddonID] {
			if pack.report != nil && pack.report.Applies(target.Version) {
				target.Packs[locale] = pack.sha256
			}
		}
		result = append(result, target)
	}
	return result, nil
}

// InstallLanguagePack inspects a downloaded pack, stores it by its SHA-256 and
// makes it the add-on's pack for its language. The pack must be for the
// target's add-on and version, and the target generation must still be active.
func (manager *Manager) InstallLanguagePack(ctx context.Context, target LanguagePackTarget, archivePath string) (packageinspect.PackReport, error) {
	report, err := manager.inspector.InspectPackFile(ctx, archivePath)
	if err != nil {
		return packageinspect.PackReport{}, err
	}
	if report.Manifest.AddonID != target.AddonID || !report.Applies(target.Version) {
		return packageinspect.PackReport{}, fmt.Errorf("%w: %s %s for %s", ErrLanguagePackMismatch, report.Manifest.AddonID, report.Manifest.AddonVersions, target.AddonID)
	}
	if err := manager.storeLanguagePackFile(ctx, archivePath, report.ArchiveSHA256); err != nil {
		return packageinspect.PackReport{}, err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if active, recovered := manager.runtimes[target.AddonID]; !recovered || active.generation.GenerationID != target.GenerationID {
		manager.removeUnusedLanguagePackFilesLocked()
		return packageinspect.PackReport{}, ErrLanguagePackStale
	}
	// An uninstall may have removed the unused file before the lock was taken.
	if _, err := os.Stat(manager.languagePackPath(report.ArchiveSHA256)); err != nil {
		return packageinspect.PackReport{}, fmt.Errorf("store language pack: %w", err)
	}
	if _, err := manager.store.db.ExecContext(ctx, `INSERT INTO addon_language_packs(addon_id, locale, pack_sha256, addon_versions, built_from, installed_at)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(addon_id, locale) DO UPDATE SET pack_sha256 = excluded.pack_sha256,
		addon_versions = excluded.addon_versions, built_from = excluded.built_from, installed_at = excluded.installed_at`,
		target.AddonID, report.Manifest.Locale, report.ArchiveSHA256, report.Manifest.AddonVersions, report.Manifest.BuiltFrom,
		manager.store.now().UTC().Format(time.RFC3339Nano)); err != nil {
		return packageinspect.PackReport{}, fmt.Errorf("record language pack: %w", err)
	}
	if manager.languagePacks[target.AddonID] == nil {
		manager.languagePacks[target.AddonID] = map[string]storedLanguagePack{}
	}
	manager.languagePacks[target.AddonID][report.Manifest.Locale] = storedLanguagePack{sha256: report.ArchiveSHA256, report: &report}
	if check, ok := manager.packChecks[target.AddonID]; ok {
		delete(check.Results, report.Manifest.Locale)
	}
	manager.removeUnusedLanguagePackFilesLocked()
	manager.publishBrowserGraphChangeLocked(ctx, target.AddonID, "language-packs")
	return report, nil
}

func (manager *Manager) storeLanguagePackFile(ctx context.Context, archivePath, digest string) error {
	destination := manager.languagePackPath(digest)
	if _, err := os.Stat(destination); err == nil {
		return nil
	}
	if err := os.MkdirAll(manager.languagePackDirectory(), 0o750); err != nil {
		return fmt.Errorf("create language pack directory: %w", err)
	}
	source, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer source.Close()
	stage, err := os.CreateTemp(manager.stagingDirectory, "language-pack-*.zip")
	if err != nil {
		return fmt.Errorf("stage language pack: %w", err)
	}
	defer os.Remove(stage.Name())
	_, copyErr := io.Copy(stage, io.LimitReader(source, packageinspect.MaxPackArchiveBytes+1))
	syncErr := stage.Sync()
	closeErr := stage.Close()
	if err := errors.Join(copyErr, syncErr, closeErr, ctx.Err()); err != nil {
		return fmt.Errorf("stage language pack: %w", err)
	}
	// The pack was inspected from archivePath; check the staged bytes are the
	// same before they become the stored pack.
	report, err := manager.inspector.InspectPackFile(ctx, stage.Name())
	if err != nil || report.ArchiveSHA256 != digest {
		return fmt.Errorf("%w: staged language pack changed", ErrInvalidPackage)
	}
	if err := os.Rename(stage.Name(), destination); err != nil {
		return fmt.Errorf("store language pack: %w", err)
	}
	return nil
}

// RecordLanguagePackCheck keeps the outcome of an add-on's latest check for
// the browser graph. Outcomes for a generation that is no longer active are
// dropped.
func (manager *Manager) RecordLanguagePackCheck(ctx context.Context, check LanguagePackCheck) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if active, recovered := manager.runtimes[check.AddonID]; !recovered || active.generation.GenerationID != check.GenerationID {
		return
	}
	available := slices.Clone(check.Available)
	sort.Strings(available)
	check.Available = slices.Compact(available)
	check.Results = maps.Clone(check.Results)
	if previous, ok := manager.packChecks[check.AddonID]; ok && previous.GenerationID == check.GenerationID &&
		slices.Equal(previous.Available, check.Available) && maps.Equal(previous.Results, check.Results) {
		return
	}
	manager.packChecks[check.AddonID] = check
	manager.publishBrowserGraphChangeLocked(ctx, check.AddonID, "language-packs")
}

// RemoveLanguagePacks deletes the stored packs whose language keep rejects,
// with their check results, and the files no pack uses any more.
func (manager *Manager) RemoveLanguagePacks(ctx context.Context, keep func(addonID, locale string) bool) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	changed := map[string]struct{}{}
	for addonID, packs := range manager.languagePacks {
		for locale := range packs {
			if keep(addonID, locale) {
				continue
			}
			if _, err := manager.store.db.ExecContext(ctx, `DELETE FROM addon_language_packs WHERE addon_id = ? AND locale = ?`, addonID, locale); err != nil {
				return fmt.Errorf("remove language pack: %w", err)
			}
			delete(packs, locale)
			changed[addonID] = struct{}{}
		}
	}
	for addonID, check := range manager.packChecks {
		for locale := range check.Results {
			if !keep(addonID, locale) {
				delete(check.Results, locale)
				changed[addonID] = struct{}{}
			}
		}
	}
	if len(changed) == 0 {
		return nil
	}
	manager.removeUnusedLanguagePackFilesLocked()
	for _, addonID := range slices.Sorted(maps.Keys(changed)) {
		manager.publishBrowserGraphChangeLocked(ctx, addonID, "language-packs")
	}
	return nil
}

// forgetLanguagePacksLocked drops an uninstalled add-on's packs from memory;
// its rows go in the uninstall transaction.
func (manager *Manager) forgetLanguagePacksLocked(addonID string) {
	delete(manager.languagePacks, addonID)
	delete(manager.packChecks, addonID)
	manager.removeUnusedLanguagePackFilesLocked()
}

// removeUnusedLanguagePackFilesLocked deletes stored pack files no add-on
// uses and forgets their merged catalogs. A failure leaves a file for the
// next removal.
func (manager *Manager) removeUnusedLanguagePackFilesLocked() {
	used := map[string]struct{}{}
	for _, packs := range manager.languagePacks {
		for _, pack := range packs {
			used[pack.sha256] = struct{}{}
		}
	}
	generations := map[string]struct{}{}
	for _, active := range manager.runtimes {
		generations[active.generation.GenerationID] = struct{}{}
	}
	for key := range manager.packCatalogs {
		generationID, digest, _ := strings.Cut(key, ":")
		_, packUsed := used[digest]
		_, generationActive := generations[generationID]
		if !packUsed || !generationActive {
			delete(manager.packCatalogs, key)
		}
	}
	entries, err := os.ReadDir(manager.languagePackDirectory())
	if err != nil {
		return
	}
	for _, entry := range entries {
		digest, ok := cutZip(entry.Name())
		if _, inUse := used[digest]; !ok || inUse || !entry.Type().IsRegular() {
			continue
		}
		if err := os.Remove(filepath.Join(manager.languagePackDirectory(), entry.Name())); err != nil {
			manager.logger.Warn("remove unused language pack", "file", entry.Name(), "error", err)
		}
	}
}

func cutZip(name string) (string, bool) {
	digest, found := strings.CutSuffix(name, ".zip")
	return digest, found && validGenerationID(digest)
}

// packCatalogKey names a merged catalog: a generation's catalogs and a pack
// are immutable, so the pair decides the result.
func packCatalogKey(generationID, packSHA256 string) string {
	return generationID + ":" + packSHA256
}

// effectiveCatalogsLocked lists one active generation's languages: the
// package's own catalogs, with each applicable stored pack merged in.
func (manager *Manager) effectiveCatalogsLocked(addonID string, active activeRuntime) []effectiveCatalog {
	result := make([]effectiveCatalog, 0, len(active.report.Locales))
	index := map[string]int{}
	for _, catalog := range active.report.Locales {
		index[catalog.Locale] = len(result)
		result = append(result, effectiveCatalog{LocaleCatalog: catalog, source: "package"})
	}
	locales := slices.Sorted(maps.Keys(manager.languagePacks[addonID]))
	for _, locale := range locales {
		pack := manager.languagePacks[addonID][locale]
		if pack.report == nil || pack.report.Catalog == nil || !pack.report.Applies(active.generation.Version) {
			continue
		}
		merged, ok := manager.mergedPackCatalogLocked(active, pack)
		if !ok {
			continue
		}
		entry := effectiveCatalog{LocaleCatalog: merged.catalog, source: merged.source}
		if position, exists := index[locale]; exists {
			result[position] = entry
		} else {
			index[locale] = len(result)
			result = append(result, entry)
		}
	}
	return result
}

func (manager *Manager) mergedPackCatalogLocked(active activeRuntime, pack storedLanguagePack) (mergedPackCatalog, bool) {
	key := packCatalogKey(active.generation.GenerationID, pack.sha256)
	merged, cached := manager.packCatalogs[key]
	if !cached {
		catalog, source, err := manager.inspector.MergePackCatalog(active.report.Locales, *pack.report)
		merged = mergedPackCatalog{catalog: catalog, source: source, err: err}
		if err != nil {
			manager.logger.Warn("language pack catalog cannot be merged", "addonId", active.generation.AddonID, "locale", pack.report.Manifest.Locale, "error", err)
		}
		manager.packCatalogs[key] = merged
	}
	return merged, merged.err == nil
}

// languagePackStatusesLocked describes an add-on's packs for the browser graph.
func (manager *Manager) languagePackStatusesLocked(addonID string, active activeRuntime) []BrowserLanguagePack {
	check := manager.packChecks[addonID]
	if check.GenerationID != active.generation.GenerationID {
		check = LanguagePackCheck{}
	}
	statuses := map[string]BrowserLanguagePack{}
	for _, locale := range check.Available {
		statuses[locale] = BrowserLanguagePack{Locale: locale, Status: PackAvailable}
	}
	for locale, result := range check.Results {
		statuses[locale] = BrowserLanguagePack{Locale: locale, Status: result.Status, Error: result.Error}
	}
	for locale, pack := range manager.languagePacks[addonID] {
		status := BrowserLanguagePack{Locale: locale, Status: PackInstalled}
		switch {
		case pack.report == nil:
			status.Status, status.Error = PackFailed, "storage"
		case !pack.report.Applies(active.generation.Version):
			status.Status, status.Version = PackOutdated, pack.report.Manifest.BuiltFrom
		default:
			status.Version = pack.report.Manifest.BuiltFrom
			if pack.report.Catalog != nil {
				if _, ok := manager.mergedPackCatalogLocked(active, pack); !ok {
					status.Status, status.Error = PackFailed, "invalid"
				}
			}
			// A failed later check keeps the installed pack.
			if result, failed := check.Results[locale]; failed && result.Status == PackFailed && status.Error == "" {
				status.Error = result.Error
			}
		}
		statuses[locale] = status
	}
	result := make([]BrowserLanguagePack, 0, len(statuses))
	for _, locale := range slices.Sorted(maps.Keys(statuses)) {
		result = append(result, statuses[locale])
	}
	return result
}
