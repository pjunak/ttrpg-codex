package backuparchive

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type CreateConfig struct {
	Database      *sql.DB
	DataDirectory string
	OutputPath    string
	HostVersion   string
	Now           func() time.Time
	Limits        Limits
}

type Creator struct {
	Database      *sql.DB
	DataDirectory string
	HostVersion   string
	Limits        Limits
	Now           func() time.Time
}

func (creator *Creator) Create(ctx context.Context, outputPath string) (Manifest, error) {
	if creator == nil {
		return Manifest{}, fmt.Errorf("backup creator is required")
	}
	return Create(ctx, CreateConfig{
		Database: creator.Database, DataDirectory: creator.DataDirectory,
		OutputPath: outputPath, HostVersion: creator.HostVersion,
		Limits: creator.Limits, Now: creator.Now,
	})
}

type sourceFile struct {
	archivePath string
	path        string
	mode        os.FileMode
	expectedSHA string
}

func Create(ctx context.Context, config CreateConfig) (Manifest, error) {
	limits, err := normalizeLimits(config.Limits)
	if err != nil {
		return Manifest{}, err
	}
	if config.Database == nil || config.DataDirectory == "" || config.OutputPath == "" || config.HostVersion == "" {
		return Manifest{}, fmt.Errorf("backup database, data directory, output, and host version are required")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	dataDirectory, err := filepath.Abs(config.DataDirectory)
	if err != nil {
		return Manifest{}, fmt.Errorf("resolve backup data directory: %w", err)
	}
	if filepath.Dir(dataDirectory) == dataDirectory {
		return Manifest{}, fmt.Errorf("backup data directory cannot be a filesystem root")
	}
	outputPath, err := filepath.Abs(config.OutputPath)
	if err != nil {
		return Manifest{}, fmt.Errorf("resolve backup output: %w", err)
	}
	if insideDirectory(outputPath, dataDirectory) {
		return Manifest{}, fmt.Errorf("backup output must be outside the data directory")
	}
	if _, err := os.Lstat(outputPath); err == nil {
		return Manifest{}, fmt.Errorf("backup output already exists: %s", outputPath)
	} else if !os.IsNotExist(err) {
		return Manifest{}, fmt.Errorf("inspect backup output: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o750); err != nil {
		return Manifest{}, fmt.Errorf("create backup output directory: %w", err)
	}

	databaseFile, err := os.CreateTemp("", "codex-database-backup-*.db")
	if err != nil {
		return Manifest{}, fmt.Errorf("create database backup stage: %w", err)
	}
	databasePath := databaseFile.Name()
	if err := databaseFile.Close(); err != nil {
		_ = os.Remove(databasePath)
		return Manifest{}, err
	}
	defer os.Remove(databasePath)
	if err := createDatabaseImage(ctx, config.Database, databasePath); err != nil {
		return Manifest{}, err
	}

	sources := []sourceFile{{archivePath: "codex.db", path: databasePath, mode: 0o640}}
	addonSources, err := collectAddonFiles(ctx, filepath.Join(dataDirectory, "addons"), limits)
	if err != nil {
		return Manifest{}, err
	}
	sources = append(sources, addonSources...)
	blobSources, err := collectBlobFiles(ctx, filepath.Join(dataDirectory, "blobs"), limits)
	if err != nil {
		return Manifest{}, err
	}
	sources = append(sources, blobSources...)
	if len(sources) > limits.MaximumEntries {
		return Manifest{}, fmt.Errorf("%w: backup contains too many files", ErrInvalidArchive)
	}
	sort.Slice(sources, func(left, right int) bool { return sources[left].archivePath < sources[right].archivePath })

	output, err := os.CreateTemp(filepath.Dir(outputPath), ".codex-backup-*.tmp")
	if err != nil {
		return Manifest{}, fmt.Errorf("create backup archive stage: %w", err)
	}
	temporaryOutput := output.Name()
	keepOutput := false
	defer func() {
		_ = output.Close()
		if !keepOutput {
			_ = os.Remove(temporaryOutput)
		}
	}()

	archive := zip.NewWriter(output)
	entries := make([]Entry, 0, len(sources))
	var expanded uint64
	for _, source := range sources {
		entry, err := addFile(ctx, archive, source, limits)
		if err != nil {
			_ = archive.Close()
			return Manifest{}, err
		}
		expanded += entry.Bytes
		if expanded > limits.MaximumExpandedBytes {
			_ = archive.Close()
			return Manifest{}, fmt.Errorf("%w: backup exceeds expanded size limit", ErrInvalidArchive)
		}
		entries = append(entries, entry)
	}
	manifest := Manifest{
		ContractVersion: ContractVersion,
		CreatedAt:       config.Now().UTC().Format(time.RFC3339Nano),
		HostVersion:     config.HostVersion,
		Entries:         entries,
	}
	manifestHeader := &zip.FileHeader{Name: "manifest.json", Method: zip.Deflate}
	manifestHeader.SetMode(0o640)
	manifestWriter, err := archive.CreateHeader(manifestHeader)
	if err != nil {
		_ = archive.Close()
		return Manifest{}, fmt.Errorf("create backup manifest entry: %w", err)
	}
	encoder := json.NewEncoder(manifestWriter)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(manifest); err != nil {
		_ = archive.Close()
		return Manifest{}, fmt.Errorf("write backup manifest: %w", err)
	}
	if err := archive.Close(); err != nil {
		return Manifest{}, fmt.Errorf("finish backup archive: %w", err)
	}
	if info, err := output.Stat(); err != nil {
		return Manifest{}, fmt.Errorf("stat backup archive: %w", err)
	} else if info.Size() > limits.MaximumArchiveBytes {
		return Manifest{}, fmt.Errorf("%w: backup archive exceeds size limit", ErrInvalidArchive)
	}
	if err := output.Sync(); err != nil {
		return Manifest{}, fmt.Errorf("sync backup archive: %w", err)
	}
	if err := output.Close(); err != nil {
		return Manifest{}, fmt.Errorf("close backup archive: %w", err)
	}
	if err := os.Rename(temporaryOutput, outputPath); err != nil {
		return Manifest{}, fmt.Errorf("publish backup archive: %w", err)
	}
	keepOutput = true
	return manifest, nil
}

func collectAddonFiles(ctx context.Context, root string, limits Limits) ([]sourceFile, error) {
	rootInfo, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("inspect add-on backup root: %w", err)
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: add-on backup root is not a real directory", ErrInvalidArchive)
	}
	result := make([]sourceFile, 0)
	err = filepath.WalkDir(root, func(filename string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		relative, err := filepath.Rel(root, filename)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		parts := strings.Split(filepath.ToSlash(relative), "/")
		if parts[0] == ".staging" {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: add-on backup contains a symbolic link: %s", ErrInvalidArchive, relative)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || uint64(info.Size()) > limits.MaximumFileBytes {
			return fmt.Errorf("%w: invalid add-on backup file: %s", ErrInvalidArchive, relative)
		}
		archivePath := "addons/" + filepath.ToSlash(relative)
		if !validArchivePath(archivePath) {
			return fmt.Errorf("%w: invalid add-on backup path: %s", ErrInvalidArchive, relative)
		}
		result = append(result, sourceFile{
			archivePath: archivePath,
			path:        filename,
			mode:        info.Mode().Perm(),
		})
		if len(result)+1 > limits.MaximumEntries {
			return fmt.Errorf("%w: backup contains too many files", ErrInvalidArchive)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("collect add-on backup files: %w", err)
	}
	return result, nil
}

func collectBlobFiles(ctx context.Context, root string, limits Limits) ([]sourceFile, error) {
	rootInfo, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("inspect blob backup root: %w", err)
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: blob backup root is not a real directory", ErrInvalidArchive)
	}
	result := make([]sourceFile, 0)
	err = filepath.WalkDir(root, func(filename string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		relative, err := filepath.Rel(root, filename)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		parts := strings.Split(filepath.ToSlash(relative), "/")
		if parts[0] == ".staging" {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: blob backup contains a symbolic link: %s", ErrInvalidArchive, relative)
		}
		if entry.IsDir() {
			if parts[0] != "sha256" || len(parts) > 2 ||
				(len(parts) == 2 && (len(parts[1]) != 2 || !lowerHex(parts[1]))) {
				return fmt.Errorf("%w: invalid blob backup directory: %s", ErrInvalidArchive, relative)
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		archivePath := "blobs/" + filepath.ToSlash(relative)
		if !info.Mode().IsRegular() || uint64(info.Size()) > limits.MaximumFileBytes ||
			!validArchivePath(archivePath) {
			return fmt.Errorf("%w: invalid blob backup file: %s", ErrInvalidArchive, relative)
		}
		result = append(result, sourceFile{
			archivePath: archivePath, path: filename, mode: info.Mode().Perm(),
			expectedSHA: filepath.Base(filename),
		})
		if len(result)+1 > limits.MaximumEntries {
			return fmt.Errorf("%w: backup contains too many files", ErrInvalidArchive)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("collect blob backup files: %w", err)
	}
	return result, nil
}

func lowerHex(value string) bool {
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return value != ""
}

func addFile(ctx context.Context, archive *zip.Writer, source sourceFile, limits Limits) (Entry, error) {
	input, err := os.Open(source.path)
	if err != nil {
		return Entry{}, fmt.Errorf("open backup file %s: %w", source.archivePath, err)
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return Entry{}, fmt.Errorf("stat backup file %s: %w", source.archivePath, err)
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || uint64(info.Size()) > limits.MaximumFileBytes {
		return Entry{}, fmt.Errorf("%w: invalid backup file %s", ErrInvalidArchive, source.archivePath)
	}
	header := &zip.FileHeader{Name: source.archivePath, Method: zip.Deflate}
	header.SetMode(source.mode)
	writer, err := archive.CreateHeader(header)
	if err != nil {
		return Entry{}, fmt.Errorf("create backup file %s: %w", source.archivePath, err)
	}
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(writer, hash), &contextReader{
		ctx: ctx, reader: io.LimitReader(input, int64(limits.MaximumFileBytes)+1),
	})
	if err != nil {
		return Entry{}, fmt.Errorf("write backup file %s: %w", source.archivePath, err)
	}
	if written != info.Size() {
		return Entry{}, fmt.Errorf("%w: backup file changed while reading: %s", ErrInvalidArchive, source.archivePath)
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if source.expectedSHA != "" && source.expectedSHA != digest {
		return Entry{}, fmt.Errorf("%w: blob object differs from its address: %s", ErrInvalidArchive, source.archivePath)
	}
	return Entry{
		Path: source.archivePath, Bytes: uint64(written),
		SHA256: digest, Mode: uint32(source.mode.Perm()),
	}, nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}
