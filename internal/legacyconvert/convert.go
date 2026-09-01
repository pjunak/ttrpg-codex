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
	Now             func() time.Time
}

type InventoryGroup struct {
	Files int    `json:"files"`
	Bytes uint64 `json:"bytes"`
}

type Report struct {
	ContractVersion string                    `json:"contractVersion"`
	SourceSHA256    string                    `json:"sourceSha256"`
	ConvertedAt     string                    `json:"convertedAt"`
	CommitID        int64                     `json:"commitId"`
	CoreCollections map[string]int            `json:"coreCollections"`
	CoreRecords     int                       `json:"coreRecords"`
	Deferred        map[string]InventoryGroup `json:"deferred"`
}

func Convert(ctx context.Context, config Config) (Report, error) {
	if config.ArchivePath == "" || config.OutputDirectory == "" {
		return Report{}, fmt.Errorf("legacy archive and fresh output directory are required")
	}
	if config.Now == nil {
		config.Now = time.Now
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
	dataset, report, err := readLegacyBackup(ctx, archivePath, convertedAt)
	if err != nil {
		return Report{}, err
	}
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
	checkErr := error(nil)
	if importErr == nil {
		checkErr = validateDatabase(ctx, database)
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
	if err := os.Rename(stage, outputDirectory); err != nil {
		return Report{}, fmt.Errorf("publish fresh conversion output: %w", err)
	}
	published = true
	report.CommitID = importResult.CommitID
	report.CoreRecords = importResult.Records
	return report, nil
}

func readLegacyBackup(ctx context.Context, filename string, now time.Time) (campaign.LegacyDataset, Report, error) {
	info, err := os.Stat(filename)
	if err != nil {
		return campaign.LegacyDataset{}, Report{}, fmt.Errorf("stat legacy archive: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maximumArchiveBytes {
		return campaign.LegacyDataset{}, Report{}, fmt.Errorf("%w: archive size is invalid", ErrInvalidLegacyBackup)
	}
	sourceHash, err := hashFile(ctx, filename)
	if err != nil {
		return campaign.LegacyDataset{}, Report{}, err
	}
	archive, err := zip.OpenReader(filename)
	if err != nil {
		return campaign.LegacyDataset{}, Report{}, fmt.Errorf("%w: open zip: %v", ErrInvalidLegacyBackup, err)
	}
	defer archive.Close()
	if len(archive.File) == 0 || len(archive.File) > maximumEntries {
		return campaign.LegacyDataset{}, Report{}, fmt.Errorf("%w: entry count is invalid", ErrInvalidLegacyBackup)
	}
	known := make(map[string]campaign.Collection)
	for _, descriptor := range campaign.Descriptors() {
		known["data/"+string(descriptor.Name)+".json"] = descriptor.Name
	}
	core := make(map[string]json.RawMessage)
	seen := make(map[string]struct{}, len(archive.File))
	deferred := map[string]InventoryGroup{
		"media": {}, "addonData": {}, "addonPackages": {}, "metadata": {}, "other": {},
	}
	var expanded uint64
	for _, file := range archive.File {
		if err := ctx.Err(); err != nil {
			return campaign.LegacyDataset{}, Report{}, err
		}
		if !safeZipPath(file.Name) || file.Mode()&os.ModeSymlink != 0 {
			return campaign.LegacyDataset{}, Report{}, fmt.Errorf("%w: unsafe entry %q", ErrInvalidLegacyBackup, file.Name)
		}
		if _, duplicate := seen[file.Name]; duplicate {
			return campaign.LegacyDataset{}, Report{}, fmt.Errorf("%w: duplicate entry %q", ErrInvalidLegacyBackup, file.Name)
		}
		seen[file.Name] = struct{}{}
		if file.FileInfo().IsDir() {
			continue
		}
		if !file.Mode().IsRegular() || file.UncompressedSize64 > maximumEntryBytes {
			return campaign.LegacyDataset{}, Report{}, fmt.Errorf("%w: invalid entry %q", ErrInvalidLegacyBackup, file.Name)
		}
		expanded += file.UncompressedSize64
		if expanded > maximumExpandedBytes {
			return campaign.LegacyDataset{}, Report{}, fmt.Errorf("%w: expanded size limit exceeded", ErrInvalidLegacyBackup)
		}
		if collection, ok := known[file.Name]; ok {
			body, err := readZipFile(file, campaign.MaximumLegacyDatasetBytes)
			if err != nil {
				return campaign.LegacyDataset{}, Report{}, err
			}
			core[string(collection)] = body
			continue
		}
		if file.Name == "data/secrets.json" {
			return campaign.LegacyDataset{}, Report{}, fmt.Errorf(
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
		return campaign.LegacyDataset{}, Report{}, fmt.Errorf("%w: no core campaign files found", ErrInvalidLegacyBackup)
	}
	body, err := json.Marshal(core)
	if err != nil {
		return campaign.LegacyDataset{}, Report{}, err
	}
	dataset, err := campaign.DecodeLegacyDataset(body)
	if err != nil {
		return campaign.LegacyDataset{}, Report{}, err
	}
	counts := make(map[string]int, len(dataset.Present))
	for _, collection := range dataset.Present {
		counts[string(collection)] = 0
	}
	for _, record := range dataset.Records {
		counts[string(record.Collection)]++
	}
	return dataset, Report{
		ContractVersion: "codex-v1-conversion-report.v1",
		SourceSHA256:    sourceHash, ConvertedAt: now.Format(time.RFC3339Nano),
		CoreCollections: counts, Deferred: deferred,
	}, nil
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

func hashFile(ctx context.Context, filename string) (string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	buffer := make([]byte, 128<<10)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		read, err := file.Read(buffer)
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
