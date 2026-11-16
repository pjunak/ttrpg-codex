package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

type errorReport struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
}

const usage = `usage:
  codex-addon-inspect [-compact] <package.zip>
  codex-addon-inspect [-compact] -pack <pack.langpack.zip> [package.zip]
  codex-addon-inspect [-compact] -build-packs <dir> -out <dir> [-pack-versions <range>] <package.zip>`

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("codex-addon-inspect", flag.ContinueOnError)
	flags.SetOutput(stderr)
	compact := flags.Bool("compact", false, "emit compact JSON")
	pack := flags.String("pack", "", "inspect a language pack, against the package's English when one is given")
	buildPacks := flags.String("build-packs", "", "build one language pack per <locale> directory here for the package")
	output := flags.String("out", "", "directory for built language packs")
	packVersions := flags.String("pack-versions", "", "add-on versions built packs apply to (default: the package version up to the next major)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	switch {
	case *pack != "" && *buildPacks == "" && flags.NArg() <= 1:
	case *buildPacks != "" && *pack == "" && *output != "" && flags.NArg() == 1:
	case *pack == "" && *buildPacks == "" && flags.NArg() == 1:
	default:
		fmt.Fprintln(stderr, usage)
		return 2
	}

	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	var report *packageinspect.Report
	if flags.NArg() == 1 {
		inspected, err := inspector.InspectFile(ctx, flags.Arg(0))
		if err != nil {
			return fail(stderr, err, *compact)
		}
		report = &inspected
	}
	switch {
	case *pack != "":
		return inspectPack(ctx, inspector, *pack, report, stdout, stderr, compact)
	case *buildPacks != "":
		return buildLanguagePacks(ctx, inspector, *report, filepath.Base(flags.Arg(0)), *buildPacks, *output, *packVersions, stdout, stderr, compact)
	}

	// The host installs a package with catalog issues and drops the broken
	// messages; package builds fail here so authors fix them before release.
	catalogIssues := packageCatalogIssues(*report)
	value := struct {
		OK bool `json:"ok"`
		packageinspect.Report
	}{OK: len(catalogIssues) == 0, Report: *report}
	if err := encodeJSON(stdout, value, compact); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportIssues(stderr, catalogIssues)
}

func packageCatalogIssues(report packageinspect.Report) []string {
	var issues []string
	for _, catalog := range report.Locales {
		for _, issue := range catalog.Issues {
			issues = append(issues, catalog.Locale+": "+issue)
		}
	}
	return issues
}

type packResult struct {
	File   string                    `json:"file"`
	Report packageinspect.PackReport `json:"report"`
	// Source is how the host would combine the pack with the package's own
	// catalog for its language; empty without a package.
	Source string   `json:"source,omitempty"`
	Issues []string `json:"issues,omitempty"`
}

// checkPack inspects one pack and, with a package, checks its catalog against
// the package's English the way the host merges it.
func checkPack(ctx context.Context, inspector *packageinspect.Inspector, filename string, report *packageinspect.Report) (packResult, error) {
	pack, err := inspector.InspectPackFile(ctx, filename)
	if err != nil {
		return packResult{}, err
	}
	result := packResult{File: filepath.Base(filename), Report: pack}
	if pack.Catalog != nil {
		for _, issue := range pack.Catalog.Issues {
			result.Issues = append(result.Issues, pack.Manifest.Locale+": "+issue)
		}
	}
	if report == nil {
		return result, nil
	}
	if pack.Manifest.AddonID != report.Manifest.ID {
		return result, fmt.Errorf("the pack is for %s, not %s", pack.Manifest.AddonID, report.Manifest.ID)
	}
	if !pack.Applies(report.Manifest.Version) {
		return result, fmt.Errorf("the pack's addonVersions %q exclude %s", pack.Manifest.AddonVersions, report.Manifest.Version)
	}
	if pack.Catalog != nil {
		merged, source, err := inspector.MergePackCatalog(report.Locales, pack)
		if err != nil {
			return result, err
		}
		result.Source = source
		for _, issue := range merged.Issues {
			if strings.HasPrefix(issue, "language pack: ") {
				result.Issues = append(result.Issues, pack.Manifest.Locale+": "+issue)
			}
		}
	}
	return result, nil
}

func inspectPack(ctx context.Context, inspector *packageinspect.Inspector, filename string, report *packageinspect.Report, stdout, stderr io.Writer, compact *bool) int {
	result, err := checkPack(ctx, inspector, filename, report)
	if err != nil {
		return fail(stderr, err, *compact)
	}
	value := struct {
		OK bool `json:"ok"`
		packResult
	}{OK: len(result.Issues) == 0, packResult: result}
	if err := encodeJSON(stdout, value, compact); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportIssues(stderr, result.Issues)
}

// buildLanguagePacks writes <out>/<package stem>.<locale>.langpack.zip for
// every <source>/<locale>/ directory: messages.json and content/**.json.
func buildLanguagePacks(ctx context.Context, inspector *packageinspect.Inspector, report packageinspect.Report, packageName, source, output, versions string, stdout, stderr io.Writer, compact *bool) int {
	issues := packageCatalogIssues(report)
	if versions == "" {
		var err error
		if versions, err = packageinspect.DefaultPackVersions(report.Manifest.Version); err != nil {
			return fail(stderr, err, *compact)
		}
	}
	directories, err := os.ReadDir(source)
	if err != nil {
		return fail(stderr, err, *compact)
	}
	if err := os.MkdirAll(output, 0o755); err != nil {
		return fail(stderr, err, *compact)
	}
	stem := strings.TrimSuffix(packageName, filepath.Ext(packageName))
	results := []packResult{}
	for _, directory := range directories {
		locale := directory.Name()
		if !directory.IsDir() || !packageinspect.LocalePattern.MatchString(locale) || locale == "en" {
			return fail(stderr, fmt.Errorf("%s: expected only language directories other than en", filepath.Join(source, locale)), *compact)
		}
		manifest, files, err := readPackSource(filepath.Join(source, locale))
		if err != nil {
			return fail(stderr, err, *compact)
		}
		manifest.PackFormat, manifest.AddonID, manifest.Locale = 1, report.Manifest.ID, locale
		manifest.AddonVersions, manifest.BuiltFrom = versions, report.Manifest.Version
		var body bytes.Buffer
		if err := packageinspect.WritePack(&body, manifest, files); err != nil {
			return fail(stderr, err, *compact)
		}
		filename := filepath.Join(output, packageinspect.PackFileName(stem, locale))
		if err := os.WriteFile(filename, body.Bytes(), 0o644); err != nil {
			return fail(stderr, err, *compact)
		}
		result, err := checkPack(ctx, inspector, filename, &report)
		if err != nil {
			return fail(stderr, err, *compact)
		}
		issues = append(issues, result.Issues...)
		results = append(results, result)
	}
	value := struct {
		OK    bool         `json:"ok"`
		Packs []packResult `json:"packs"`
	}{OK: len(issues) == 0, Packs: results}
	if err := encodeJSON(stdout, value, compact); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportIssues(stderr, issues)
}

func readPackSource(directory string) (packageinspect.PackManifest, map[string][]byte, error) {
	manifest := packageinspect.PackManifest{}
	files := map[string][]byte{}
	err := filepath.WalkDir(directory, func(filename string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(directory, filename)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		switch {
		case relative == ".":
			return nil
		case entry.IsDir() && (relative == "content" || strings.HasPrefix(relative, "content/")):
			return nil
		case entry.Type().IsRegular() && (relative == "messages.json" ||
			strings.HasPrefix(relative, "content/") && strings.HasSuffix(relative, ".json")):
			body, err := os.ReadFile(filename)
			if err != nil {
				return err
			}
			files[relative] = body
			return nil
		default:
			return fmt.Errorf("%s: a language pack holds messages.json and content/**/*.json only", filename)
		}
	})
	if err != nil {
		return manifest, nil, err
	}
	for name := range files {
		if name == "messages.json" {
			manifest.Catalog = name
		} else {
			manifest.Content = append(manifest.Content, name)
		}
	}
	sort.Strings(manifest.Content)
	return manifest, files, nil
}

func fail(stderr io.Writer, err error, compact bool) int {
	failure := errorReport{OK: false, Code: "INSPECTION_FAILED", Message: err.Error()}
	var inspection *packageinspect.InspectionError
	if errors.As(err, &inspection) {
		failure.Code = inspection.Code
		failure.Path = inspection.Path
	}
	if encodeJSON(stderr, failure, &compact) != nil {
		fmt.Fprintln(stderr, err)
	}
	return 1
}

func reportIssues(stderr io.Writer, issues []string) int {
	if len(issues) == 0 {
		return 0
	}
	fmt.Fprintln(stderr, "message catalog issues:")
	for _, issue := range issues {
		fmt.Fprintln(stderr, "  "+issue)
	}
	return 1
}

func encodeJSON(writer io.Writer, value any, compact *bool) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	if !*compact {
		encoder.SetIndent("", "  ")
	}
	return encoder.Encode(value)
}
