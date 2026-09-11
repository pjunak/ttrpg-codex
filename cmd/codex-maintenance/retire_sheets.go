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

	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/processlock"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/sheetretirement"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func runRetireSheets(ctx context.Context, arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("retire-sheets", flag.ContinueOnError)
	flags.SetOutput(stderr)
	directory := flags.String("data-dir", "", "stopped host data directory")
	review := flags.String("apply", "", "exact reviewSHA256 from the preview")
	backup := flags.String("backup", "", "new full backup ZIP required with -apply")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || *directory == "" || ((*review == "") != (*backup == "")) {
		return errors.New("retire-sheets requires -data-dir; removal also requires -apply <reviewSHA256> and -backup <new.zip>")
	}
	databasePath := filepath.Join(*directory, "codex.db")
	if info, err := os.Stat(databasePath); err != nil || !info.Mode().IsRegular() {
		return errors.New("retirement requires an existing host database")
	}
	lock, err := processlock.AcquireRestore(*directory)
	if err != nil {
		return fmt.Errorf("retirement requires the host to be stopped: %w", err)
	}
	defer lock.Close()
	db, err := sqlite.Open(ctx, databasePath)
	if err != nil {
		return err
	}
	defer db.Close()
	report, err := sheetretirement.Inspect(ctx, db)
	if err != nil {
		return err
	}
	if *review != "" {
		if *review != report.Review {
			return errors.New("retirement preview changed; inspect and review again")
		}
		if _, err := backuparchive.Create(ctx, backuparchive.CreateConfig{Database: db, DataDirectory: *directory, OutputPath: *backup, HostVersion: hostVersion}); err != nil {
			return err
		}
		if _, err := backuparchive.Verify(ctx, backuparchive.VerifyConfig{ArchivePath: *backup, Migrations: migrations.FS}); err != nil {
			return fmt.Errorf("backup verification failed; sheets were not removed: %w", err)
		}
		if _, err := sheetretirement.Apply(ctx, db, *review); err != nil {
			return err
		}
		fmt.Fprintln(stderr, "Removed the listed retired sheets and schema metadata. Core character records, other add-ons, retained history and the backup remain unchanged.")
	} else {
		fmt.Fprintln(stderr, "Preview only. Applying removes only the listed retired sheet values and their schema metadata.")
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(report)
}
