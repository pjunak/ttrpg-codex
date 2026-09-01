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

	"github.com/pjunak/ttrpg-codex/internal/legacyconvert"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/processlock"
)

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("codex-convert-v1", flag.ContinueOnError)
	flags.SetOutput(stderr)
	input := flags.String("in", "", "ZIP downloaded from the v1 website backup UI")
	output := flags.String("out", "", "new rewrite data directory")
	reportPath := flags.String("report", "", "optional new path for the JSON conversion report")
	var addonPackages stringList
	flags.Var(&addonPackages, "addon-package", "target v3 add-on ZIP; repeat for DM Tools and D&D sheets")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || *input == "" || *output == "" {
		return errors.New("conversion requires -in and -out and accepts no positional arguments")
	}
	if *reportPath != "" {
		if _, err := os.Lstat(*reportPath); err == nil {
			return fmt.Errorf("conversion report already exists: %s", *reportPath)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect conversion report destination: %w", err)
		}
	}
	lock, err := processlock.AcquireRestore(*output)
	if err != nil {
		return fmt.Errorf("conversion requires exclusive ownership of the output: %w", err)
	}
	defer lock.Close()
	report, err := legacyconvert.Convert(ctx, legacyconvert.Config{
		ArchivePath: *input, OutputDirectory: *output, AddonPackages: addonPackages,
	})
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(report); err != nil {
		return fmt.Errorf("write conversion report: %w", err)
	}
	if *reportPath != "" {
		if err := writeReport(*reportPath, report); err != nil {
			return err
		}
	}
	return nil
}

func writeReport(path string, report legacyconvert.Report) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("create conversion report directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create conversion report without overwriting: %w", err)
	}
	removePartial := true
	defer func() {
		if removePartial {
			_ = os.Remove(path)
		}
	}()
	encoder := json.NewEncoder(file)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(report); err != nil {
		_ = file.Close()
		return fmt.Errorf("encode conversion report: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync conversion report: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close conversion report: %w", err)
	}
	removePartial = false
	return nil
}

type stringList []string

func (values *stringList) String() string {
	return fmt.Sprint([]string(*values))
}

func (values *stringList) Set(value string) error {
	if value == "" {
		return errors.New("add-on package path cannot be empty")
	}
	*values = append(*values, value)
	return nil
}
