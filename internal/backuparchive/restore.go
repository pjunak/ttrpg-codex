package backuparchive

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maximumManifestBytes = 1 << 20

type RestoreConfig struct {
	ArchivePath   string
	DataDirectory string
	Migrations    fs.FS
	Limits        Limits
}

type VerifyConfig struct {
	ArchivePath string
	Migrations  fs.FS
	Limits      Limits
}

type restoreJournal struct {
	ContractVersion string `json:"contractVersion"`
	TargetName      string `json:"targetName"`
	StageName       string `json:"stageName"`
	PreviousName    string `json:"previousName"`
}

func Verify(ctx context.Context, config VerifyConfig) (RestoreResult, error) {
	limits, err := normalizeLimits(config.Limits)
	if err != nil {
		return RestoreResult{}, err
	}
	if config.ArchivePath == "" || config.Migrations == nil {
		return RestoreResult{}, fmt.Errorf("verify archive and migrations are required")
	}
	archivePath, err := filepath.Abs(config.ArchivePath)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("resolve verify archive: %w", err)
	}
	manifest, archive, err := inspectArchive(archivePath, limits)
	if err != nil {
		return RestoreResult{}, err
	}
	defer archive.Close()
	stage, err := os.MkdirTemp("", "codex-backup-verify-")
	if err != nil {
		return RestoreResult{}, fmt.Errorf("create backup verification stage: %w", err)
	}
	defer os.RemoveAll(stage)
	if err := extractArchive(ctx, archive, stage, manifest, limits); err != nil {
		return RestoreResult{}, err
	}
	applied, err := validateAndMigrateDatabase(ctx, filepath.Join(stage, "codex.db"), config.Migrations)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("validate backup database: %w", err)
	}
	return RestoreResult{Manifest: manifest, AppliedMigrations: applied}, nil
}

func Restore(ctx context.Context, config RestoreConfig) (RestoreResult, error) {
	limits, err := normalizeLimits(config.Limits)
	if err != nil {
		return RestoreResult{}, err
	}
	if config.ArchivePath == "" || config.DataDirectory == "" || config.Migrations == nil {
		return RestoreResult{}, fmt.Errorf("restore archive, data directory, and migrations are required")
	}
	dataDirectory, err := filepath.Abs(config.DataDirectory)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("resolve restore data directory: %w", err)
	}
	if filepath.Dir(dataDirectory) == dataDirectory {
		return RestoreResult{}, fmt.Errorf("restore data directory cannot be a filesystem root")
	}
	archivePath, err := filepath.Abs(config.ArchivePath)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("resolve restore archive: %w", err)
	}
	if insideDirectory(archivePath, dataDirectory) {
		return RestoreResult{}, fmt.Errorf("restore archive must be outside the data directory")
	}
	if err := Recover(ctx, dataDirectory, config.Migrations); err != nil {
		return RestoreResult{}, err
	}

	manifest, archive, err := inspectArchive(archivePath, limits)
	if err != nil {
		return RestoreResult{}, err
	}
	defer archive.Close()
	parent := filepath.Dir(dataDirectory)
	base := filepath.Base(dataDirectory)
	if err := os.MkdirAll(parent, 0o750); err != nil {
		return RestoreResult{}, fmt.Errorf("create restore data parent: %w", err)
	}
	stage, err := os.MkdirTemp(parent, "."+base+".restore-stage-")
	if err != nil {
		return RestoreResult{}, fmt.Errorf("create restore stage: %w", err)
	}
	keepStage := false
	defer func() {
		if !keepStage {
			_ = os.RemoveAll(stage)
		}
	}()
	if err := extractArchive(ctx, archive, stage, manifest, limits); err != nil {
		return RestoreResult{}, err
	}
	applied, err := validateAndMigrateDatabase(ctx, filepath.Join(stage, "codex.db"), config.Migrations)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("validate restored database: %w", err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(filepath.Join(stage, "codex.db"+suffix)); err != nil && !os.IsNotExist(err) {
			return RestoreResult{}, fmt.Errorf("remove restored database sidecar: %w", err)
		}
	}

	journal := restoreJournal{
		ContractVersion: restoreJournalVersion,
		TargetName:      base,
		StageName:       filepath.Base(stage),
		PreviousName:    "." + base + ".restore-previous-" + strings.TrimPrefix(filepath.Base(stage), "."+base+".restore-stage-"),
	}
	journalPath := restoreJournalPath(dataDirectory)
	if err := writeRestoreJournal(journalPath, journal); err != nil {
		return RestoreResult{}, err
	}
	keepStage = true
	previous := filepath.Join(parent, journal.PreviousName)
	targetExists, err := pathExists(dataDirectory)
	if err != nil {
		return RestoreResult{}, err
	}
	if targetExists {
		if err := os.Rename(dataDirectory, previous); err != nil {
			return RestoreResult{}, fmt.Errorf("move current data directory aside: %w", err)
		}
	}
	if err := os.Rename(stage, dataDirectory); err != nil {
		rollbackErr := error(nil)
		if targetExists {
			rollbackErr = os.Rename(previous, dataDirectory)
		}
		if rollbackErr == nil {
			_ = os.Remove(journalPath)
			keepStage = false
		}
		return RestoreResult{}, errors.Join(fmt.Errorf("publish restored data directory: %w", err), rollbackErr)
	}
	keepStage = false
	if targetExists {
		if err := os.RemoveAll(previous); err != nil {
			return RestoreResult{}, fmt.Errorf("restore installed but previous data cleanup is pending: %w", err)
		}
	}
	if err := os.Remove(journalPath); err != nil {
		return RestoreResult{}, fmt.Errorf("restore installed but journal cleanup is pending: %w", err)
	}
	return RestoreResult{Manifest: manifest, AppliedMigrations: applied}, nil
}

func Recover(ctx context.Context, dataDirectory string, migrations fs.FS) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	absolute, err := filepath.Abs(dataDirectory)
	if err != nil {
		return fmt.Errorf("resolve restore recovery directory: %w", err)
	}
	if filepath.Dir(absolute) == absolute {
		return fmt.Errorf("restore recovery directory cannot be a filesystem root")
	}
	journalPath := restoreJournalPath(absolute)
	body, err := os.ReadFile(journalPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read restore journal: %w", err)
	}
	var journal restoreJournal
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&journal); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return fmt.Errorf("%w: restore journal is invalid", ErrRestorePending)
	}
	parent := filepath.Dir(absolute)
	base := filepath.Base(absolute)
	if (journal.ContractVersion != restoreJournalVersion && journal.ContractVersion != LegacyContractVersion) ||
		journal.TargetName != base ||
		!safeSiblingName(journal.StageName, "."+base+".restore-stage-") ||
		!safeSiblingName(journal.PreviousName, "."+base+".restore-previous-") {
		return fmt.Errorf("%w: restore journal paths are invalid", ErrRestorePending)
	}
	stage := filepath.Join(parent, journal.StageName)
	previous := filepath.Join(parent, journal.PreviousName)
	targetExists, err := pathExists(absolute)
	if err != nil {
		return err
	}
	stageExists, err := pathExists(stage)
	if err != nil {
		return err
	}
	previousExists, err := pathExists(previous)
	if err != nil {
		return err
	}

	if targetExists && !stageExists {
		if _, err := validateAndMigrateDatabase(ctx, filepath.Join(absolute, "codex.db"), migrations); err != nil {
			return fmt.Errorf("%w: installed restore failed recovery validation: %v", ErrRestorePending, err)
		}
		if previousExists {
			if err := os.RemoveAll(previous); err != nil {
				return fmt.Errorf("remove recovered previous data: %w", err)
			}
		}
		return removeRestoreJournal(journalPath)
	}

	if targetExists && previousExists {
		return fmt.Errorf("%w: both target and previous data exist before restore publication", ErrRestorePending)
	}
	if !targetExists && previousExists {
		if err := os.Rename(previous, absolute); err != nil {
			return fmt.Errorf("roll back interrupted restore: %w", err)
		}
	}
	if stageExists {
		if err := os.RemoveAll(stage); err != nil {
			return fmt.Errorf("remove interrupted restore stage: %w", err)
		}
	}
	return removeRestoreJournal(journalPath)
}

func inspectArchive(filename string, limits Limits) (Manifest, *zip.ReadCloser, error) {
	info, err := os.Stat(filename)
	if err != nil {
		return Manifest{}, nil, fmt.Errorf("stat backup archive: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > limits.MaximumArchiveBytes {
		return Manifest{}, nil, fmt.Errorf("%w: archive file is invalid or too large", ErrInvalidArchive)
	}
	archive, err := zip.OpenReader(filename)
	if err != nil {
		return Manifest{}, nil, fmt.Errorf("%w: open zip: %v", ErrInvalidArchive, err)
	}
	if len(archive.File) < 2 || len(archive.File) > limits.MaximumEntries+1 {
		archive.Close()
		return Manifest{}, nil, fmt.Errorf("%w: archive entry count is invalid", ErrInvalidArchive)
	}
	manifestFiles := make([]*zip.File, 0, 1)
	for _, file := range archive.File {
		if file.Name == "manifest.json" {
			manifestFiles = append(manifestFiles, file)
		}
	}
	if len(manifestFiles) != 1 {
		archive.Close()
		return Manifest{}, nil, fmt.Errorf("%w: archive requires exactly one manifest", ErrInvalidArchive)
	}
	manifest, err := decodeManifest(manifestFiles[0], limits)
	if err != nil {
		archive.Close()
		return Manifest{}, nil, err
	}
	return manifest, archive, nil
}

func decodeManifest(file *zip.File, limits Limits) (Manifest, error) {
	if file.UncompressedSize64 == 0 || file.UncompressedSize64 > maximumManifestBytes {
		return Manifest{}, fmt.Errorf("%w: manifest size is invalid", ErrInvalidArchive)
	}
	reader, err := file.Open()
	if err != nil {
		return Manifest{}, fmt.Errorf("%w: open manifest: %v", ErrInvalidArchive, err)
	}
	body, err := io.ReadAll(io.LimitReader(reader, maximumManifestBytes+1))
	closeErr := reader.Close()
	if err != nil || closeErr != nil || len(body) > maximumManifestBytes {
		return Manifest{}, fmt.Errorf("%w: read manifest", ErrInvalidArchive)
	}
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return Manifest{}, fmt.Errorf("%w: manifest JSON is invalid", ErrInvalidArchive)
	}
	if (manifest.ContractVersion != LegacyContractVersion && manifest.ContractVersion != ContractVersion) ||
		manifest.HostVersion == "" || len(manifest.HostVersion) > 100 {
		return Manifest{}, fmt.Errorf("%w: manifest contract is invalid", ErrInvalidArchive)
	}
	if _, err := time.Parse(time.RFC3339Nano, manifest.CreatedAt); err != nil {
		return Manifest{}, fmt.Errorf("%w: manifest timestamp is invalid", ErrInvalidArchive)
	}
	if len(manifest.Entries) == 0 || len(manifest.Entries) > limits.MaximumEntries {
		return Manifest{}, fmt.Errorf("%w: manifest entry count is invalid", ErrInvalidArchive)
	}
	var expanded uint64
	previous := ""
	databaseFound := false
	for _, entry := range manifest.Entries {
		if !validArchivePath(manifest.ContractVersion, entry.Path) || entry.Path <= previous ||
			entry.Bytes > limits.MaximumFileBytes ||
			entry.Mode > 0o777 || entry.Mode == 0 {
			return Manifest{}, fmt.Errorf("%w: manifest entry is invalid: %s", ErrInvalidArchive, entry.Path)
		}
		hash, err := hex.DecodeString(entry.SHA256)
		if err != nil || len(hash) != sha256.Size {
			return Manifest{}, fmt.Errorf("%w: manifest hash is invalid: %s", ErrInvalidArchive, entry.Path)
		}
		if strings.HasPrefix(entry.Path, "blobs/") && path.Base(entry.Path) != entry.SHA256 {
			return Manifest{}, fmt.Errorf("%w: blob path does not match content hash: %s", ErrInvalidArchive, entry.Path)
		}
		expanded += entry.Bytes
		if expanded > limits.MaximumExpandedBytes {
			return Manifest{}, fmt.Errorf("%w: manifest exceeds expanded size limit", ErrInvalidArchive)
		}
		if entry.Path == "codex.db" {
			databaseFound = true
		}
		previous = entry.Path
	}
	if !databaseFound {
		return Manifest{}, fmt.Errorf("%w: manifest does not contain codex.db", ErrInvalidArchive)
	}
	return manifest, nil
}

func extractArchive(
	ctx context.Context,
	archive *zip.ReadCloser,
	destination string,
	manifest Manifest,
	limits Limits,
) error {
	expected := make(map[string]Entry, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		expected[entry.Path] = entry
	}
	files := make(map[string]*zip.File, len(manifest.Entries))
	for _, file := range archive.File {
		if file.Name == "manifest.json" {
			continue
		}
		entry, ok := expected[file.Name]
		mode := file.Mode()
		if !ok || !mode.IsRegular() || mode.Perm() != os.FileMode(entry.Mode) ||
			file.UncompressedSize64 != entry.Bytes {
			return fmt.Errorf("%w: archive inventory differs at %s", ErrInvalidArchive, file.Name)
		}
		if _, duplicate := files[file.Name]; duplicate {
			return fmt.Errorf("%w: duplicate archive path %s", ErrInvalidArchive, file.Name)
		}
		files[file.Name] = file
	}
	if len(files) != len(expected) {
		return fmt.Errorf("%w: archive inventory is incomplete", ErrInvalidArchive)
	}
	paths := make([]string, 0, len(files))
	for filename := range files {
		paths = append(paths, filename)
	}
	sort.Strings(paths)
	for _, archivePath := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		entry := expected[archivePath]
		file := files[archivePath]
		target := filepath.Join(destination, filepath.FromSlash(archivePath))
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return fmt.Errorf("create restore directory: %w", err)
		}
		reader, err := file.Open()
		if err != nil {
			return fmt.Errorf("open restore entry %s: %w", archivePath, err)
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, os.FileMode(entry.Mode))
		if err != nil {
			reader.Close()
			return fmt.Errorf("create restore entry %s: %w", archivePath, err)
		}
		hash := sha256.New()
		written, copyErr := io.Copy(io.MultiWriter(output, hash), &contextReader{
			ctx: ctx, reader: io.LimitReader(reader, int64(limits.MaximumFileBytes)+1),
		})
		if copyErr == nil && uint64(written) != entry.Bytes {
			copyErr = fmt.Errorf("entry size differs from manifest")
		}
		if copyErr == nil && hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
			copyErr = fmt.Errorf("entry hash differs from manifest")
		}
		if copyErr == nil {
			copyErr = output.Sync()
		}
		closeOutputErr := output.Close()
		closeReaderErr := reader.Close()
		if copyErr != nil || closeOutputErr != nil || closeReaderErr != nil {
			return fmt.Errorf("%w: extract %s: %v", ErrInvalidArchive, archivePath,
				errors.Join(copyErr, closeOutputErr, closeReaderErr))
		}
	}
	return nil
}

func restoreJournalPath(dataDirectory string) string {
	return filepath.Join(filepath.Dir(dataDirectory), "."+filepath.Base(dataDirectory)+".restore.json")
}

func writeRestoreJournal(filename string, journal restoreJournal) error {
	body, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if os.IsExist(err) {
		return ErrRestorePending
	}
	if err != nil {
		return fmt.Errorf("create restore journal: %w", err)
	}
	if _, err := file.Write(body); err != nil {
		file.Close()
		_ = os.Remove(filename)
		return fmt.Errorf("write restore journal: %w", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		_ = os.Remove(filename)
		return fmt.Errorf("sync restore journal: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(filename)
		return fmt.Errorf("close restore journal: %w", err)
	}
	return nil
}

func removeRestoreJournal(filename string) error {
	if err := os.Remove(filename); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove restore journal: %w", err)
	}
	return nil
}

func pathExists(filename string) (bool, error) {
	info, err := os.Lstat(filename)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect restore path %s: %w", filename, err)
	}
	if !info.IsDir() {
		return false, fmt.Errorf("restore path is not a directory: %s", filename)
	}
	return true, nil
}

func safeSiblingName(value, prefix string) bool {
	return strings.HasPrefix(value, prefix) && len(value) > len(prefix) &&
		filepath.Base(value) == value && value != "." && value != ".."
}

func insideDirectory(filename, directory string) bool {
	relative, err := filepath.Rel(directory, filename)
	return err == nil && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
