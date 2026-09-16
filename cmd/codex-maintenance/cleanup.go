package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"database/sql"
	"github.com/pjunak/ttrpg-codex/internal/addons/githubsource"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/cleanup"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/processlock"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func runCleanup(ctx context.Context, kind string, arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet(kind, flag.ContinueOnError)
	flags.SetOutput(stderr)
	directory := flags.String("data-dir", "", "stopped host data directory")
	reviewed := flags.String("apply", "", "exact reviewSHA256 from the preview")
	backup := flags.String("backup", "", "new full backup ZIP required with -apply")
	options := cleanup.Options{Kind: kind}
	resume := false
	switch kind {
	case "delete-addon-data":
		flags.StringVar(&options.AddonID, "addon", "", "disabled or uninstalled add-on whose data is permanently removed")
	case "prune-logs":
		flags.IntVar(&options.Events, "keep-events", 10000, "newest SSE events to retain per audience")
		flags.IntVar(&options.Lifecycle, "keep-lifecycle", 10000, "newest lifecycle rows to retain")
		flags.IntVar(&options.Audit, "keep-audit", 10000, "newest commits to retain in each core/add-on audit")
	case "collect-blobs":
		flags.BoolVar(&resume, "resume", false, "finish only previously reviewed and committed object removals")
	default:
		return errors.New("unsupported cleanup command")
	}
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || *directory == "" || ((*reviewed == "") != (*backup == "")) || (resume && *reviewed != "") {
		return errors.New("cleanup requires -data-dir; apply requires -apply <reviewSHA256> and -backup <new.zip>; -resume stands alone")
	}
	path := filepath.Join(*directory, "codex.db")
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return errors.New("cleanup requires an existing host database")
	}
	lock, err := processlock.AcquireRestore(*directory)
	if err != nil {
		return fmt.Errorf("cleanup requires the host to be stopped: %w", err)
	}
	defer lock.Close()
	db, err := sqlite.Open(ctx, path)
	if err != nil {
		return err
	}
	defer db.Close()
	if resume {
		if err := cleanup.ResumeBlobs(ctx, db, *directory); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "Finished previously reviewed blob removals.")
		return nil
	}
	var report any
	var review string
	if kind == "collect-blobs" {
		value, err := cleanup.InspectBlobs(ctx, db, *directory)
		if err != nil {
			return err
		}
		report = value
		review = value.Review
	} else {
		value, err := cleanup.Inspect(ctx, db, options)
		if err != nil {
			return err
		}
		report = value
		review = value.Review
	}
	if *reviewed != "" {
		if *reviewed != review {
			return cleanup.ErrStale
		}
		if err := backupBeforeCleanup(ctx, db, *directory, *backup); err != nil {
			return err
		}
		if kind == "collect-blobs" {
			if _, err := cleanup.QueueBlobs(ctx, db, *directory, *reviewed); err != nil {
				return err
			}
			if err := cleanup.ResumeBlobs(ctx, db, *directory); err != nil {
				return fmt.Errorf("removal intent is committed; run collect-blobs -resume to finish: %w", err)
			}
		} else if _, err := cleanup.Apply(ctx, db, options, *reviewed); err != nil {
			return err
		}
		fmt.Fprintln(stderr, "Applied the exact reviewed cleanup after creating and verifying the full backup.")
	} else {
		fmt.Fprintln(stderr, "Preview only. Counts and encoded row sizes describe this operation; no records or files were removed.")
	}
	if kind == "delete-addon-data" {
		fmt.Fprintln(stderr, "Deletion includes this add-on's collections, extensions, retained field history and namespace values in every local recovery point. Core records and package archives remain. Existing external backups still contain the old data and can restore it.")
	}
	if kind == "prune-logs" {
		fmt.Fprintln(stderr, "Only SSE, lifecycle and commit audit rows are eligible. Authored data, retained field history, idempotency receipts, recovery points and package archives never expire through this command. SQLite may reuse freed pages without shrinking its file.")
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(report)
}

func backupBeforeCleanup(ctx context.Context, db *sql.DB, directory, output string) error {
	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		return err
	}
	token := os.Getenv("CODEX_GITHUB_TOKEN")
	if token == "" {
		token = os.Getenv("GITHUB_TOKEN")
	}
	fetch, err := githubsource.NewPackageFetcher(githubsource.Config{DB: db, DataDirectory: directory, Inspector: inspector, EnvironmentToken: token})
	if err != nil {
		return err
	}
	if _, err = backuparchive.Create(ctx, backuparchive.CreateConfig{
		Database: db, DataDirectory: directory, OutputPath: output, HostVersion: hostVersion,
		MaterializePackages: func(ctx context.Context, databasePath, stageRoot string) error {
			return packagemanager.MaterializePackageBackup(ctx, databasePath, filepath.Join(directory, "addons"), stageRoot, inspector, fetch)
		},
	}); err != nil {
		return err
	}
	if _, err = backuparchive.Verify(ctx, backuparchive.VerifyConfig{ArchivePath: output, Migrations: migrations.FS}); err != nil {
		return fmt.Errorf("backup verification failed; cleanup was not applied: %w", err)
	}
	return nil
}
