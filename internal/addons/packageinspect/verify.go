package packageinspect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// VerifyExtracted confirms that a published generation still contains exactly
// the files inspected from its archive. It rejects links, special files,
// missing files, extra files, and content changes before a generation can be
// activated or recovered.
func (i *Inspector) VerifyExtracted(ctx context.Context, root string, report Report) error {
	if i == nil {
		return errors.New("inspector is required")
	}
	expected := make(map[string]File, len(report.Files)+1)
	for _, file := range report.Files {
		expected[file.Path] = file
	}
	expected[checksumsFilename] = File{
		Path: checksumsFilename, SHA256: report.ChecksumInventorySHA256,
	}
	seen := make(map[string]struct{}, len(expected))
	err := filepath.WalkDir(root, func(filename string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if filename == root {
			if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
				return errors.New("generation root is not a directory")
			}
			return nil
		}
		relative, err := filepath.Rel(root, filename)
		if err != nil {
			return err
		}
		packagePath := filepath.ToSlash(relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s is a symbolic link", packagePath)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("%s is not a regular file", packagePath)
		}
		want, exists := expected[packagePath]
		if !exists {
			return fmt.Errorf("unexpected file %s", packagePath)
		}
		if want.Bytes != 0 && uint64(info.Size()) != want.Bytes {
			return fmt.Errorf("%s has %d bytes, want %d", packagePath, info.Size(), want.Bytes)
		}
		actual, err := hashExtractedFile(ctx, filename, i.limits.MaxFileBytes)
		if err != nil {
			return fmt.Errorf("hash %s: %w", packagePath, err)
		}
		if actual != want.SHA256 {
			return fmt.Errorf("%s checksum is %s, want %s", packagePath, actual, want.SHA256)
		}
		seen[packagePath] = struct{}{}
		return nil
	})
	if err != nil {
		return inspectionError(CodeChecksumMismatch, root, err)
	}
	if len(seen) != len(expected) {
		for filename := range expected {
			if _, exists := seen[filename]; !exists {
				return inspectionError(CodeChecksumMismatch, filename, errors.New("extracted file is missing"))
			}
		}
	}
	return nil
}

func hashExtractedFile(ctx context.Context, filename string, maximum uint64) (string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(&contextReader{ctx: ctx, reader: file}, int64(maximum)+1))
	if err != nil {
		return "", err
	}
	if uint64(written) > maximum {
		return "", fmt.Errorf("file exceeds %d bytes", maximum)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
