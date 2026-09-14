package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/pjunak/ttrpg-codex/internal/addons/githubsource"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/processlock"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

const hostVersion = "2.0.0-dev"

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, arguments []string, stdout, stderr io.Writer) error {
	if len(arguments) == 0 {
		return errors.New("usage: codex-maintenance <backup|verify|restore|retire-sheets> [options]")
	}
	switch arguments[0] {
	case "backup":
		return runBackup(ctx, arguments[1:], stdout, stderr)
	case "verify":
		return runVerify(ctx, arguments[1:], stdout, stderr)
	case "restore":
		return runRestore(ctx, arguments[1:], stdout, stderr)
	case "retire-sheets":
		return runRetireSheets(ctx, arguments[1:], stdout, stderr)
	default:
		return fmt.Errorf("unknown maintenance command %q", arguments[0])
	}
}

func runBackup(ctx context.Context, arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("backup", flag.ContinueOnError)
	flags.SetOutput(stderr)
	dataDirectory := flags.String("data-dir", filepath.Join("data", "rewrite"), "rewrite data directory")
	output := flags.String("out", "", "new backup ZIP path")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || *output == "" {
		return errors.New("backup requires -out and accepts no positional arguments")
	}
	if info, err := os.Stat(filepath.Join(*dataDirectory, "codex.db")); err != nil || !info.Mode().IsRegular() {
		if err == nil {
			err = errors.New("database path is not a regular file")
		}
		return fmt.Errorf("backup database is unavailable: %w", err)
	}
	lock, err := processlock.AcquireBackup(*dataDirectory)
	if err != nil {
		return fmt.Errorf("acquire backup data directory: %w", err)
	}
	defer lock.Close()
	database, err := sqlite.Open(ctx, filepath.Join(*dataDirectory, "codex.db"))
	if err != nil {
		return fmt.Errorf("open backup database: %w", err)
	}
	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		database.Close()
		return err
	}
	token := os.Getenv("CODEX_GITHUB_TOKEN")
	if token == "" {
		token = os.Getenv("GITHUB_TOKEN")
	}
	fetch, err := githubsource.NewPackageFetcher(githubsource.Config{DB: database, DataDirectory: *dataDirectory, Inspector: inspector, EnvironmentToken: token})
	if err != nil {
		database.Close()
		return err
	}
	manifest, createErr := backuparchive.Create(ctx, backuparchive.CreateConfig{
		MaterializePackages: func(ctx context.Context, databasePath, stageRoot string) error {
			return packagemanager.MaterializePackageBackup(ctx, databasePath, filepath.Join(*dataDirectory, "addons"), stageRoot, inspector, fetch)
		},
		Database: database, DataDirectory: *dataDirectory,
		OutputPath: *output, HostVersion: hostVersion,
	})
	closeErr := database.Close()
	if createErr != nil || closeErr != nil {
		return errors.Join(createErr, closeErr)
	}
	fmt.Fprintf(stdout, "Created %s with %d files.\n", *output, len(manifest.Entries))
	return nil
}

func runVerify(ctx context.Context, arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("verify", flag.ContinueOnError)
	flags.SetOutput(stderr)
	input := flags.String("in", "", "backup ZIP path")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || *input == "" {
		return errors.New("verify requires -in and accepts no positional arguments")
	}
	result, err := backuparchive.Verify(ctx, backuparchive.VerifyConfig{
		ArchivePath: *input, Migrations: migrations.FS,
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Verified %s (%d files, %d migrations needed).\n",
		result.Manifest.ContractVersion, len(result.Manifest.Entries), result.AppliedMigrations)
	return nil
}

func runRestore(ctx context.Context, arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("restore", flag.ContinueOnError)
	flags.SetOutput(stderr)
	dataDirectory := flags.String("data-dir", filepath.Join("data", "rewrite"), "rewrite data directory")
	input := flags.String("in", "", "backup ZIP path")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || *input == "" {
		return errors.New("restore requires -in and accepts no positional arguments")
	}
	lock, err := processlock.AcquireRestore(*dataDirectory)
	if err != nil {
		return fmt.Errorf("restore requires the host to be stopped: %w", err)
	}
	defer lock.Close()
	result, err := backuparchive.Restore(ctx, backuparchive.RestoreConfig{
		ArchivePath: *input, DataDirectory: *dataDirectory, Migrations: migrations.FS,
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Restored %s with %d files (%d migrations applied).\n",
		result.Manifest.ContractVersion, len(result.Manifest.Entries), result.AppliedMigrations)
	return nil
}
