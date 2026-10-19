package backuparchive

import (
	"archive/zip"
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

	"github.com/pjunak/ttrpg-codex/internal/jsonexact"

	"github.com/pjunak/ttrpg-codex/internal/ctxio"
)

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

// Restore installs an archive while the host is stopped, the same way the next
// host start installs one staged from the web: it verifies and stages the
// archive inside the data directory, then moves its entries into place. This
// keeps the server's credentials and works when the data directory is a
// mount point.
func Restore(ctx context.Context, config RestoreConfig) (RestoreResult, error) {
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
	// First finish a restore that the web or an interrupted run left staged.
	if err := Recover(ctx, dataDirectory, config.Migrations); err != nil {
		return RestoreResult{}, err
	}
	existed, err := pathExists(dataDirectory)
	if err != nil {
		return RestoreResult{}, err
	}
	if err := os.MkdirAll(dataDirectory, 0o750); err != nil {
		return RestoreResult{}, fmt.Errorf("create restore data directory: %w", err)
	}
	result, err := Stage(ctx, StageConfig{
		ArchivePath: archivePath, DataDirectory: dataDirectory,
		Migrations: config.Migrations, Limits: config.Limits,
	})
	if err != nil {
		if !existed {
			_ = os.Remove(dataDirectory)
		}
		return RestoreResult{}, err
	}
	if err := finishStagedRestore(ctx, dataDirectory, config.Migrations); err != nil {
		return RestoreResult{}, fmt.Errorf("install restored data: %w", err)
	}
	return result, nil
}

// Recover runs before SQLite opens. It finishes a restore staged from the web
// or left behind by an interrupted restore command.
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
	if exists, err := pathExists(absolute); err != nil || !exists {
		return err
	}
	return finishStagedRestore(ctx, absolute, migrations)
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
	if file.UncompressedSize64 == 0 || file.UncompressedSize64 > limits.MaximumManifestBytes {
		return Manifest{}, fmt.Errorf("%w: manifest size is invalid", ErrInvalidArchive)
	}
	reader, err := file.Open()
	if err != nil {
		return Manifest{}, fmt.Errorf("%w: open manifest: %v", ErrInvalidArchive, err)
	}
	body, err := io.ReadAll(io.LimitReader(reader, int64(limits.MaximumManifestBytes)+1))
	closeErr := reader.Close()
	if err != nil || closeErr != nil || uint64(len(body)) > limits.MaximumManifestBytes {
		return Manifest{}, fmt.Errorf("%w: read manifest", ErrInvalidArchive)
	}
	var manifest Manifest
	if err := jsonexact.Decode(body, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("%w: manifest JSON is invalid", ErrInvalidArchive)
	}
	if manifest.ContractVersion != ContractVersion ||
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
		if !validArchivePath(entry.Path) || entry.Path <= previous ||
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
		written, copyErr := io.Copy(io.MultiWriter(output, hash), ctxio.Reader(ctx, io.LimitReader(reader, int64(limits.MaximumFileBytes)+1)))
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

func writeRestoreJournal(filename string, journal any) error {
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
