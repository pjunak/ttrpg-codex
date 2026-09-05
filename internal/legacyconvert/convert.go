package legacyconvert

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

const (
	maximumArchiveBytes  = int64(1 << 30)
	maximumExpandedBytes = uint64(4 << 30)
	maximumEntryBytes    = uint64(1 << 30)
	maximumEntries       = 100_000
)

var ErrInvalidLegacyBackup = errors.New("invalid v1 UI backup")

type Config struct {
	ArchivePath     string
	OutputDirectory string
	AddonPackages   []string
	Now             func() time.Time
}

type InventoryGroup struct {
	Files int    `json:"files"`
	Bytes uint64 `json:"bytes"`
}

type MediaReport struct {
	Imported         InventoryGroup `json:"imported"`
	Bindings         int            `json:"bindings"`
	RewrittenRecords int            `json:"rewrittenRecords"`
	DiscardedDerived InventoryGroup `json:"discardedDerived"`
}

type TargetPackageReport struct {
	Version       string `json:"version"`
	ArchiveSHA256 string `json:"archiveSha256"`
}

type AddonReport struct {
	TargetPackages      map[string]TargetPackageReport `json:"targetPackages"`
	Documents           map[string]int                 `json:"documents"`
	ImportedSourceFiles InventoryGroup                 `json:"importedSourceFiles"`
	NormalizedRecordIDs int                            `json:"normalizedRecordIds"`
	UpgradedSchemaV2    int                            `json:"upgradedSchemaV2"`
	DiscardedMarkers    int                            `json:"discardedMigrationMarkers"`
	ConvertedCrossFlows int                            `json:"convertedCrossScopeFlows"`
	ReanchoredEffects   int                            `json:"reanchoredConsequences"`
	StrippedCoreRecords int                            `json:"strippedCoreRecords"`
	DeferredEmbedded    map[string]int                 `json:"deferredEmbedded"`
	importedFiles       []*zip.File
}

type LegacyAdjustmentReport struct {
	SpeciesDefinitions  int `json:"speciesDefinitions"`
	CharacterSpecies    int `json:"characterSpeciesMapped"`
	DiscardedMapPinFile int `json:"discardedEmptyMapPinFiles"`
	SidebarLayouts      int `json:"sidebarLayoutsCreated"`
}

type Report struct {
	ContractVersion string                    `json:"contractVersion"`
	SourceSHA256    string                    `json:"sourceSha256"`
	ConvertedAt     string                    `json:"convertedAt"`
	CommitID        int64                     `json:"commitId"`
	CoreCollections map[string]int            `json:"coreCollections"`
	CoreRecords     int                       `json:"coreRecords"`
	Legacy          LegacyAdjustmentReport    `json:"legacyAdjustments"`
	Media           MediaReport               `json:"media"`
	Addons          AddonReport               `json:"addons"`
	Deferred        map[string]InventoryGroup `json:"deferred"`
}

func Convert(ctx context.Context, config Config) (Report, error) {
	if config.ArchivePath == "" || config.OutputDirectory == "" {
		return Report{}, fmt.Errorf("legacy archive and fresh output directory are required")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	targetPackages, err := inspectTargetPackages(ctx, config.AddonPackages)
	if err != nil {
		return Report{}, err
	}
	archivePath, err := filepath.Abs(config.ArchivePath)
	if err != nil {
		return Report{}, fmt.Errorf("resolve legacy archive: %w", err)
	}
	outputDirectory, err := filepath.Abs(config.OutputDirectory)
	if err != nil {
		return Report{}, fmt.Errorf("resolve conversion output: %w", err)
	}
	if filepath.Dir(outputDirectory) == outputDirectory {
		return Report{}, fmt.Errorf("conversion output cannot be a filesystem root")
	}
	if insideDirectory(archivePath, outputDirectory) {
		return Report{}, fmt.Errorf("legacy archive must be outside the conversion output")
	}
	if _, err := os.Lstat(outputDirectory); err == nil {
		return Report{}, fmt.Errorf("conversion output already exists: %s", outputDirectory)
	} else if !os.IsNotExist(err) {
		return Report{}, fmt.Errorf("inspect conversion output: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(outputDirectory), 0o750); err != nil {
		return Report{}, fmt.Errorf("create conversion output parent: %w", err)
	}

	convertedAt := config.Now().UTC()
	backup, err := openLegacyBackup(ctx, archivePath, convertedAt)
	if err != nil {
		return Report{}, err
	}
	defer backup.Close()
	if err := normalizeRetiredCoreData(backup); err != nil {
		return Report{}, err
	}
	if err := normalizeSidebarSettings(backup); err != nil {
		return Report{}, err
	}
	dataset := backup.dataset
	report := backup.report
	stage, err := os.MkdirTemp(filepath.Dir(outputDirectory), ".codex-v1-conversion-")
	if err != nil {
		return Report{}, fmt.Errorf("create conversion stage: %w", err)
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(stage)
		}
	}()
	database, err := storage.Open(ctx, filepath.Join(stage, "codex.db"))
	if err != nil {
		return Report{}, fmt.Errorf("open conversion database: %w", err)
	}
	if _, err := storage.Migrate(ctx, database, migrations.FS); err != nil {
		database.Close()
		return Report{}, fmt.Errorf("migrate conversion database: %w", err)
	}
	importResult, importErr := campaignstore.ImportFreshLegacy(ctx, database, dataset, convertedAt)
	if importErr == nil {
		report.Media, report.Deferred["media"], importErr = importLegacyMedia(
			ctx,
			database,
			stage,
			backup.files,
			convertedAt,
		)
	}
	if importErr == nil {
		report.Addons, importErr = importLegacyAddons(
			ctx,
			database,
			backup,
			targetPackages,
			convertedAt,
		)
		for _, imported := range report.Addons.importedFiles {
			value := report.Deferred["addonData"]
			value.Files--
			value.Bytes -= imported.UncompressedSize64
			report.Deferred["addonData"] = value
		}
	}
	checkErr := error(nil)
	if importErr == nil {
		checkErr = errors.Join(
			validateDatabase(ctx, database),
			validateConvertedBlobs(ctx, database, stage),
		)
	}
	closeErr := database.Close()
	if err := errors.Join(importErr, checkErr, closeErr); err != nil {
		return Report{}, fmt.Errorf("populate conversion database: %w", err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(filepath.Join(stage, "codex.db"+suffix)); err != nil && !os.IsNotExist(err) {
			return Report{}, fmt.Errorf("remove conversion database sidecar: %w", err)
		}
	}
	if err := backup.VerifySource(ctx); err != nil {
		return Report{}, err
	}
	if err := verifyTargetPackages(ctx, targetPackages); err != nil {
		return Report{}, err
	}
	if err := os.Rename(stage, outputDirectory); err != nil {
		return Report{}, fmt.Errorf("publish fresh conversion output: %w", err)
	}
	published = true
	report.CommitID = importResult.CommitID
	report.CoreRecords = importResult.Records
	return report, nil
}

type legacyBackup struct {
	source      *os.File
	sourceBytes int64
	dataset     campaign.LegacyDataset
	report      Report
	files       map[string]*zip.File
}

func (backup *legacyBackup) VerifySource(ctx context.Context) error {
	info, err := backup.source.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != backup.sourceBytes {
		return fmt.Errorf("%w: source archive changed during conversion", ErrInvalidLegacyBackup)
	}
	digest, err := hashReader(ctx, io.NewSectionReader(backup.source, 0, backup.sourceBytes))
	if err != nil {
		return err
	}
	if digest != backup.report.SourceSHA256 {
		return fmt.Errorf("%w: source archive changed during conversion", ErrInvalidLegacyBackup)
	}
	return nil
}

func (backup *legacyBackup) Close() error {
	if backup == nil || backup.source == nil {
		return nil
	}
	return backup.source.Close()
}

func openLegacyBackup(ctx context.Context, filename string, now time.Time) (*legacyBackup, error) {
	source, err := os.Open(filename)
	if err != nil {
		return nil, fmt.Errorf("open legacy archive: %w", err)
	}
	closeOnError := true
	defer func() {
		if closeOnError {
			_ = source.Close()
		}
	}()
	info, err := source.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat legacy archive: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maximumArchiveBytes {
		return nil, fmt.Errorf("%w: archive size is invalid", ErrInvalidLegacyBackup)
	}
	sourceHash, err := hashReader(ctx, io.NewSectionReader(source, 0, info.Size()))
	if err != nil {
		return nil, err
	}
	archive, err := zip.NewReader(source, info.Size())
	if err != nil {
		return nil, fmt.Errorf("%w: open zip: %v", ErrInvalidLegacyBackup, err)
	}
	if len(archive.File) == 0 || len(archive.File) > maximumEntries {
		return nil, fmt.Errorf("%w: entry count is invalid", ErrInvalidLegacyBackup)
	}
	known := make(map[string]campaign.Collection)
	for _, descriptor := range campaign.Descriptors() {
		known["data/"+string(descriptor.Name)+".json"] = descriptor.Name
	}
	core := make(map[string]json.RawMessage)
	seen := make(map[string]struct{}, len(archive.File))
	files := make(map[string]*zip.File, len(archive.File))
	deferred := map[string]InventoryGroup{
		"media": {}, "addonData": {}, "addonPackages": {}, "metadata": {}, "other": {},
	}
	var expanded uint64
	for _, file := range archive.File {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !safeZipPath(file.Name) || file.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("%w: unsafe entry %q", ErrInvalidLegacyBackup, file.Name)
		}
		if _, duplicate := seen[file.Name]; duplicate {
			return nil, fmt.Errorf("%w: duplicate entry %q", ErrInvalidLegacyBackup, file.Name)
		}
		seen[file.Name] = struct{}{}
		if file.FileInfo().IsDir() {
			continue
		}
		if !file.Mode().IsRegular() || file.UncompressedSize64 > maximumEntryBytes {
			return nil, fmt.Errorf("%w: invalid entry %q", ErrInvalidLegacyBackup, file.Name)
		}
		files[file.Name] = file
		expanded += file.UncompressedSize64
		if expanded > maximumExpandedBytes {
			return nil, fmt.Errorf("%w: expanded size limit exceeded", ErrInvalidLegacyBackup)
		}
		if collection, ok := known[file.Name]; ok {
			body, err := readZipFile(file, campaign.MaximumLegacyDatasetBytes)
			if err != nil {
				return nil, err
			}
			core[string(collection)] = body
			continue
		}
		if file.Name == "data/secrets.json" {
			return nil, fmt.Errorf(
				"%w: archive unexpectedly contains live secrets",
				ErrInvalidLegacyBackup,
			)
		}
		group := deferredGroup(file.Name)
		value := deferred[group]
		value.Files++
		value.Bytes += file.UncompressedSize64
		deferred[group] = value
	}
	if len(core) == 0 {
		return nil, fmt.Errorf("%w: no core campaign files found", ErrInvalidLegacyBackup)
	}
	body, err := json.Marshal(core)
	if err != nil {
		return nil, err
	}
	dataset, err := campaign.DecodeLegacyDataset(body)
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int, len(dataset.Present))
	for _, collection := range dataset.Present {
		counts[string(collection)] = 0
	}
	for _, record := range dataset.Records {
		counts[string(record.Collection)]++
	}
	closeOnError = false
	return &legacyBackup{source: source, sourceBytes: info.Size(), dataset: dataset, files: files, report: Report{
		ContractVersion: "codex-v1-conversion-report.v3",
		SourceSHA256:    sourceHash, ConvertedAt: now.Format(time.RFC3339Nano),
		CoreCollections: counts, Deferred: deferred,
	}}, nil
}

func deferredGroup(filename string) string {
	switch {
	case strings.HasPrefix(filename, "data/addon-data/"):
		return "addonData"
	case strings.HasPrefix(filename, "data/addons/"):
		return "addonPackages"
	case strings.HasPrefix(filename, "data/portraits/"),
		strings.HasPrefix(filename, "data/maps/"),
		strings.HasPrefix(filename, "data/icons/"),
		strings.HasPrefix(filename, "data/branding/"):
		return "media"
	case filename == "data/addons.json", filename == "data/auth.json":
		return "metadata"
	default:
		return "other"
	}
}

func safeZipPath(value string) bool {
	if value == "" || len(value) > 2048 || strings.Contains(value, "\\") ||
		strings.HasPrefix(value, "/") || strings.Contains(value, "//") {
		return false
	}
	canonical := strings.TrimSuffix(value, "/")
	if canonical == "" || path.Clean(canonical) != canonical {
		return false
	}
	for _, part := range strings.Split(canonical, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func readZipFile(file *zip.File, maximum int) (json.RawMessage, error) {
	if file.UncompressedSize64 > uint64(maximum) {
		return nil, fmt.Errorf("%w: core file %q is too large", ErrInvalidLegacyBackup, file.Name)
	}
	reader, err := file.Open()
	if err != nil {
		return nil, fmt.Errorf("%w: open %q: %v", ErrInvalidLegacyBackup, file.Name, err)
	}
	body, readErr := io.ReadAll(io.LimitReader(reader, int64(maximum)+1))
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || len(body) > maximum {
		return nil, fmt.Errorf("%w: read %q: %v", ErrInvalidLegacyBackup, file.Name, errors.Join(readErr, closeErr))
	}
	if !json.Valid(bytes.TrimSpace(body)) {
		return nil, fmt.Errorf("%w: core file %q is not JSON", ErrInvalidLegacyBackup, file.Name)
	}
	return body, nil
}

func hashReader(ctx context.Context, reader io.Reader) (string, error) {
	hash := sha256.New()
	buffer := make([]byte, 128<<10)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		read, err := reader.Read(buffer)
		if read > 0 {
			_, _ = hash.Write(buffer[:read])
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("hash legacy archive: %w", err)
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func validateDatabase(ctx context.Context, database *sql.DB) error {
	rows, err := database.QueryContext(ctx, `PRAGMA quick_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		return fmt.Errorf("sqlite quick check returned no result")
	}
	var result string
	if err := rows.Scan(&result); err != nil {
		return fmt.Errorf("scan sqlite quick check: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("sqlite quick check failed: %s", result)
	}
	foreignKeys, err := database.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer foreignKeys.Close()
	if foreignKeys.Next() {
		return fmt.Errorf("sqlite foreign key check failed")
	}
	return foreignKeys.Err()
}

func insideDirectory(filename, directory string) bool {
	relative, err := filepath.Rel(directory, filename)
	return err == nil && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
