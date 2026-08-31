package packageinspect

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// InspectAndExtractFile validates a package before publishing its regular
// files into a new destination directory. The caller should pass a private
// copied archive so another process cannot replace it between inspection and
// extraction.
func (i *Inspector) InspectAndExtractFile(
	ctx context.Context,
	filename string,
	destination string,
) (report Report, err error) {
	report, err = i.InspectFile(ctx, filename)
	if err != nil {
		return Report{}, err
	}
	absoluteDestination, err := filepath.Abs(destination)
	if err != nil {
		return Report{}, inspectionError(CodeExtractionFailed, destination, fmt.Errorf("resolve destination: %w", err))
	}
	if filepath.Dir(absoluteDestination) == absoluteDestination {
		return Report{}, inspectionError(CodeExtractionFailed, destination, errors.New("filesystem root cannot be an extraction destination"))
	}
	if _, err := os.Lstat(absoluteDestination); err == nil {
		return Report{}, inspectionError(CodeExtractionFailed, destination, errors.New("destination already exists"))
	} else if !errors.Is(err, os.ErrNotExist) {
		return Report{}, inspectionError(CodeExtractionFailed, destination, err)
	}
	if err := os.MkdirAll(filepath.Dir(absoluteDestination), 0o750); err != nil {
		return Report{}, inspectionError(CodeExtractionFailed, destination, fmt.Errorf("create destination parent: %w", err))
	}
	if err := os.Mkdir(absoluteDestination, 0o750); err != nil {
		return Report{}, inspectionError(CodeExtractionFailed, destination, fmt.Errorf("create destination: %w", err))
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(absoluteDestination)
		}
	}()

	archiveDigest, err := hashFile(ctx, filename, i.limits.MaxArchiveBytes)
	if err != nil {
		return Report{}, inspectionError(CodeExtractionFailed, filename, fmt.Errorf("rehash package: %w", err))
	}
	if archiveDigest != report.ArchiveSHA256 {
		return Report{}, inspectionError(CodeChecksumMismatch, filename, errors.New("package changed after inspection"))
	}
	archive, err := zip.OpenReader(filename)
	if err != nil {
		return Report{}, inspectionError(CodeExtractionFailed, filename, fmt.Errorf("reopen package: %w", err))
	}
	defer archive.Close()
	entries, _, _, err := i.indexEntries(archive.File)
	if err != nil {
		return Report{}, err
	}
	checksumEntry, exists := entries[checksumsFilename]
	if !exists {
		return Report{}, inspectionError(CodeMissingFile, checksumsFilename, errors.New("required checksum inventory is missing"))
	}
	checksumBody, err := readEntry(ctx, checksumEntry, i.limits.MaxFileBytes)
	if err != nil {
		return Report{}, inspectionError(CodeInvalidChecksums, checksumsFilename, err)
	}
	inventory, err := i.parseChecksums(checksumBody)
	if err != nil {
		return Report{}, err
	}
	if _, err := i.verifyChecksums(ctx, entries, inventory); err != nil {
		return Report{}, err
	}

	filenames := make([]string, 0, len(entries))
	for name := range entries {
		filenames = append(filenames, name)
	}
	sort.Strings(filenames)
	for _, name := range filenames {
		if err := ctx.Err(); err != nil {
			return Report{}, err
		}
		body, err := readEntry(ctx, entries[name], i.limits.MaxFileBytes)
		if err != nil {
			return Report{}, inspectionError(CodeExtractionFailed, name, err)
		}
		target, err := extractionTarget(absoluteDestination, name)
		if err != nil {
			return Report{}, inspectionError(CodeExtractionFailed, name, err)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return Report{}, inspectionError(CodeExtractionFailed, name, fmt.Errorf("create parent: %w", err))
		}
		mode := os.FileMode(0o640)
		if entries[name].Mode().Perm()&0o111 != 0 {
			mode = 0o750
		}
		file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			return Report{}, inspectionError(CodeExtractionFailed, name, fmt.Errorf("create file: %w", err))
		}
		if _, err := file.Write(body); err != nil {
			_ = file.Close()
			return Report{}, inspectionError(CodeExtractionFailed, name, fmt.Errorf("write file: %w", err))
		}
		if err := file.Sync(); err != nil {
			_ = file.Close()
			return Report{}, inspectionError(CodeExtractionFailed, name, fmt.Errorf("sync file: %w", err))
		}
		if err := file.Close(); err != nil {
			return Report{}, inspectionError(CodeExtractionFailed, name, fmt.Errorf("close file: %w", err))
		}
	}
	complete = true
	return report, nil
}

func extractionTarget(root, packagePath string) (string, error) {
	target := filepath.Join(root, filepath.FromSlash(packagePath))
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return "", err
	}
	if relative == "." || relative == ".." || filepath.IsAbs(relative) ||
		len(relative) >= 3 && relative[:3] == ".."+string(filepath.Separator) {
		return "", errors.New("package path escapes extraction root")
	}
	return target, nil
}
