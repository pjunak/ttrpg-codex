package backuparchive

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/pjunak/ttrpg-codex/internal/jsonexact"
)

// A staged restore is installed inside the data directory itself, so it also
// works when that directory is a mount point that cannot be renamed. The
// journal records the phase; every phase can be resumed after a crash.
const (
	stagedJournalName    = ".restore-pending.json"
	stagedJournalVersion = "codex-staged-restore.v1"
	stagedStagePrefix    = ".restore-stage-"
	stagedPreviousPrefix = ".restore-previous-"
	// Saved GitHub tokens belong to this server and are never in a backup.
	serverCredentials = "credentials"

	phaseStaged    = "staged"
	phaseMovingOut = "moving-out"
	phaseMovingIn  = "moving-in"
)

type StageConfig struct {
	ArchivePath   string
	DataDirectory string
	Migrations    fs.FS
	Limits        Limits
}

type stagedJournal struct {
	ContractVersion string `json:"contractVersion"`
	StageName       string `json:"stageName"`
	PreviousName    string `json:"previousName"`
	Phase           string `json:"phase"`
}

// Stage verifies an archive into the running installation's data directory.
// Nothing current changes until the next start calls Recover.
func Stage(ctx context.Context, config StageConfig) (RestoreResult, error) {
	limits, err := normalizeLimits(config.Limits)
	if err != nil {
		return RestoreResult{}, err
	}
	if config.ArchivePath == "" || config.DataDirectory == "" || config.Migrations == nil {
		return RestoreResult{}, fmt.Errorf("staged restore archive, data directory, and migrations are required")
	}
	dataDirectory, err := filepath.Abs(config.DataDirectory)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("resolve staged restore data directory: %w", err)
	}
	journalPath := filepath.Join(dataDirectory, stagedJournalName)
	if exists, err := fileExists(journalPath); err != nil {
		return RestoreResult{}, err
	} else if exists {
		return RestoreResult{}, ErrRestorePending
	}
	manifest, archive, err := inspectArchive(config.ArchivePath, limits)
	if err != nil {
		return RestoreResult{}, err
	}
	defer archive.Close()
	stage, err := os.MkdirTemp(dataDirectory, stagedStagePrefix)
	if err != nil {
		return RestoreResult{}, fmt.Errorf("create staged restore directory: %w", err)
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
		return RestoreResult{}, fmt.Errorf("validate staged database: %w", err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(filepath.Join(stage, "codex.db"+suffix)); err != nil && !os.IsNotExist(err) {
			return RestoreResult{}, fmt.Errorf("remove staged database sidecar: %w", err)
		}
	}
	stageName := filepath.Base(stage)
	journal := stagedJournal{
		ContractVersion: stagedJournalVersion,
		StageName:       stageName,
		PreviousName:    stagedPreviousPrefix + strings.TrimPrefix(stageName, stagedStagePrefix),
		Phase:           phaseStaged,
	}
	if err := writeRestoreJournal(journalPath, journal); err != nil {
		return RestoreResult{}, err
	}
	keepStage = true
	return RestoreResult{Manifest: manifest, AppliedMigrations: applied}, nil
}

// finishStagedRestore moves the current installation aside, publishes the
// staged one and removes the previous copy only after validating the result.
func finishStagedRestore(ctx context.Context, dataDirectory string, migrations fs.FS) error {
	journalPath := filepath.Join(dataDirectory, stagedJournalName)
	body, err := os.ReadFile(journalPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read staged restore journal: %w", err)
	}
	var journal stagedJournal
	if err := jsonexact.Decode(body, &journal); err != nil ||
		journal.ContractVersion != stagedJournalVersion ||
		!safeSiblingName(journal.StageName, stagedStagePrefix) ||
		!safeSiblingName(journal.PreviousName, stagedPreviousPrefix) {
		return fmt.Errorf("%w: staged restore journal is invalid", ErrRestorePending)
	}
	stage := filepath.Join(dataDirectory, journal.StageName)
	previous := filepath.Join(dataDirectory, journal.PreviousName)
	reserved := map[string]bool{
		stagedJournalName: true, stagedJournalName + ".next": true,
		journal.StageName: true, journal.PreviousName: true,
		serverCredentials: true,
	}
	switch journal.Phase {
	case phaseStaged:
		if exists, err := pathExists(stage); err != nil || !exists {
			return errors.Join(fmt.Errorf("%w: staged restore files are missing", ErrRestorePending), err)
		}
		if err := os.MkdirAll(previous, 0o750); err != nil {
			return fmt.Errorf("create previous data directory: %w", err)
		}
		if err := advanceStagedJournal(journalPath, &journal, phaseMovingOut); err != nil {
			return err
		}
		fallthrough
	case phaseMovingOut:
		if err := moveEntries(dataDirectory, previous, reserved); err != nil {
			return fmt.Errorf("move current data aside: %w", err)
		}
		if err := advanceStagedJournal(journalPath, &journal, phaseMovingIn); err != nil {
			return err
		}
		fallthrough
	case phaseMovingIn:
		if exists, err := pathExists(stage); err != nil {
			return err
		} else if exists {
			if err := moveEntries(stage, dataDirectory, nil); err != nil {
				return fmt.Errorf("publish restored data: %w", err)
			}
			if err := os.Remove(stage); err != nil {
				return fmt.Errorf("remove empty restore stage: %w", err)
			}
		}
	default:
		return fmt.Errorf("%w: staged restore phase is invalid", ErrRestorePending)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := validateAndMigrateDatabase(ctx, filepath.Join(dataDirectory, "codex.db"), migrations); err != nil {
		return fmt.Errorf("%w: installed restore failed validation; the previous data is in %s: %v",
			ErrRestorePending, journal.PreviousName, err)
	}
	if err := os.RemoveAll(previous); err != nil {
		return fmt.Errorf("remove previous data: %w", err)
	}
	return removeRestoreJournal(journalPath)
}

func advanceStagedJournal(journalPath string, journal *stagedJournal, phase string) error {
	journal.Phase = phase
	next := journalPath + ".next"
	_ = os.Remove(next)
	if err := writeRestoreJournal(next, *journal); err != nil {
		return err
	}
	if err := os.Rename(next, journalPath); err != nil {
		return fmt.Errorf("advance staged restore journal: %w", err)
	}
	return nil
}

// moveEntries renames every top-level entry of source into destination. An
// entry already present at the destination means an earlier attempt stopped
// halfway through an unexpected state, so it is refused rather than merged.
func moveEntries(source, destination string, skip map[string]bool) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if skip[entry.Name()] {
			continue
		}
		target := filepath.Join(destination, entry.Name())
		if _, err := os.Lstat(target); err == nil {
			return fmt.Errorf("%w: %s already exists", ErrRestorePending, target)
		} else if !os.IsNotExist(err) {
			return err
		}
		if err := os.Rename(filepath.Join(source, entry.Name()), target); err != nil {
			return err
		}
	}
	return nil
}

func fileExists(filename string) (bool, error) {
	_, err := os.Lstat(filename)
	if os.IsNotExist(err) {
		return false, nil
	}
	return err == nil, err
}
