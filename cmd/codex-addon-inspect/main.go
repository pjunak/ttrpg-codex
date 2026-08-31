package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

type errorReport struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
}

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("codex-addon-inspect", flag.ContinueOnError)
	flags.SetOutput(stderr)
	compact := flags.Bool("compact", false, "emit compact JSON")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 1 {
		fmt.Fprintln(stderr, "usage: codex-addon-inspect [-compact] <package.zip>")
		return 2
	}

	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	report, err := inspector.InspectFile(ctx, flags.Arg(0))
	if err != nil {
		failure := errorReport{OK: false, Code: "INSPECTION_FAILED", Message: err.Error()}
		var inspection *packageinspect.InspectionError
		if errors.As(err, &inspection) {
			failure.Code = inspection.Code
			failure.Path = inspection.Path
		}
		if encodeJSON(stderr, failure, *compact) != nil {
			fmt.Fprintln(stderr, err)
		}
		return 1
	}

	value := struct {
		OK bool `json:"ok"`
		packageinspect.Report
	}{OK: true, Report: report}
	if err := encodeJSON(stdout, value, *compact); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func encodeJSON(writer io.Writer, value any, compact bool) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	if !compact {
		encoder.SetIndent("", "  ")
	}
	return encoder.Encode(value)
}
