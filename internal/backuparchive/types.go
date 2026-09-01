package backuparchive

import (
	"errors"
	"fmt"
	"math"
	"path"
	"strings"
	"unicode"
)

const ContractVersion = "codex-backup.v1"

var (
	ErrInvalidArchive = errors.New("invalid Codex backup archive")
	ErrRestorePending = errors.New("a Codex restore is already pending")
)

type Limits struct {
	MaximumArchiveBytes  int64
	MaximumExpandedBytes uint64
	MaximumFileBytes     uint64
	MaximumEntries       int
}

var DefaultLimits = Limits{
	MaximumArchiveBytes:  1 << 30,
	MaximumExpandedBytes: 4 << 30,
	MaximumFileBytes:     1 << 30,
	MaximumEntries:       100_000,
}

type Entry struct {
	Path   string `json:"path"`
	Bytes  uint64 `json:"bytes"`
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode"`
}

type Manifest struct {
	ContractVersion string  `json:"contractVersion"`
	CreatedAt       string  `json:"createdAt"`
	HostVersion     string  `json:"hostVersion"`
	Entries         []Entry `json:"entries"`
}

type RestoreResult struct {
	Manifest          Manifest
	AppliedMigrations int
}

func normalizeLimits(limits Limits) (Limits, error) {
	if limits == (Limits{}) {
		limits = DefaultLimits
	}
	if limits.MaximumArchiveBytes <= 0 || limits.MaximumExpandedBytes == 0 ||
		limits.MaximumFileBytes == 0 || limits.MaximumEntries < 1 ||
		limits.MaximumFileBytes > limits.MaximumExpandedBytes ||
		limits.MaximumFileBytes >= math.MaxInt64 {
		return Limits{}, fmt.Errorf("%w: invalid limits", ErrInvalidArchive)
	}
	return limits, nil
}

func validArchivePath(value string) bool {
	if value == "" || len(value) > 1024 || strings.Contains(value, "\\") ||
		strings.HasPrefix(value, "/") || path.Clean(value) != value {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
		for _, character := range part {
			if unicode.IsControl(character) {
				return false
			}
		}
	}
	return value == "codex.db" || strings.HasPrefix(value, "addons/")
}
