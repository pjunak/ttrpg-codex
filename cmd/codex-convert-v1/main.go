package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

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
	var addonPackages stringList
	flags.Var(&addonPackages, "addon-package", "target v3 add-on ZIP; repeat for DM Tools and D&D sheets")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || *input == "" || *output == "" {
		return errors.New("conversion requires -in and -out and accepts no positional arguments")
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
