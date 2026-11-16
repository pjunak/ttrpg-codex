package packageinspect

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	semver "github.com/Masterminds/semver/v3"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Language packs follow contracts/addons/v3/language-pack.schema.json: a
// data-only ZIP with pack.json, one message-catalog.v1 file and reserved
// content overlays, for one add-on and a range of its versions.
const (
	PackManifestFilename    = "pack.json"
	PackFileSuffix          = ".langpack.zip"
	MaxPackArchiveBytes     = 32 << 20
	MaxPackExpandedBytes    = 64 << 20
	MaxPackContentFileBytes = 16 << 20
	maxPackManifestBytes    = 64 << 10
	maxPackContentFiles     = 256
	// CodeInvalidPack marks a language pack whose manifest, files or catalog
	// break the pack contract.
	CodeInvalidPack = "INVALID_LANGUAGE_PACK"
)

// LocalePattern is the canonical BCP 47 shape every catalog and pack uses.
var LocalePattern = regexp.MustCompile(`^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$`)

var packLimits = Limits{
	MaxArchiveBytes:  MaxPackArchiveBytes,
	MaxExpandedBytes: MaxPackExpandedBytes,
	MaxFileBytes:     MaxPackContentFileBytes,
	MaxFiles:         maxPackContentFiles + 2,
}

type PackManifest struct {
	PackFormat    int      `json:"packFormat"`
	AddonID       string   `json:"addonId"`
	Locale        string   `json:"locale"`
	AddonVersions string   `json:"addonVersions"`
	BuiltFrom     string   `json:"builtFrom"`
	Catalog       string   `json:"catalog,omitempty"`
	Content       []string `json:"content,omitempty"`
}

// PackCatalog is a pack's catalog checked on its own. Its keys and
// placeholders are checked against English when the host merges it.
type PackCatalog struct {
	Messages int      `json:"messages"`
	Sections []string `json:"sections"`
	Issues   []string `json:"issues,omitempty"`
	body     []byte
}

type PackReport struct {
	ArchiveBytes  int64        `json:"archiveBytes"`
	ArchiveSHA256 string       `json:"archiveSha256"`
	Manifest      PackManifest `json:"manifest"`
	Files         []File       `json:"files"`
	Catalog       *PackCatalog `json:"catalog,omitempty"`
	versions      *semver.Constraints
}

// Applies reports whether the pack's version range includes version.
func (report PackReport) Applies(version string) bool {
	parsed, err := semver.StrictNewVersion(version)
	return err == nil && report.versions != nil && report.versions.Check(parsed)
}

// CatalogBody returns the pack's catalog file; nil when the pack has none.
func (report PackReport) CatalogBody() []byte {
	if report.Catalog == nil {
		return nil
	}
	return bytes.Clone(report.Catalog.body)
}

// PackFileName is the release asset name of a pack built beside a package:
// the package file name without .zip, the language, then .langpack.zip.
func PackFileName(packageStem, locale string) string {
	return packageStem + "." + locale + PackFileSuffix
}

// ParsePackFileName reads the version and language from a pack asset name of
// addonID; ok is false for any other file, packages included.
func ParsePackFileName(name, addonID string) (version, locale string, ok bool) {
	stem, found := strings.CutSuffix(name, PackFileSuffix)
	prefix := addonID + "-"
	if !found || !strings.HasPrefix(stem, prefix) {
		return "", "", false
	}
	dot := strings.LastIndexByte(stem, '.')
	if dot < len(prefix) {
		return "", "", false
	}
	version, locale = stem[len(prefix):dot], stem[dot+1:]
	if version == "" || !LocalePattern.MatchString(locale) || locale == "en" {
		return "", "", false
	}
	return version, locale, true
}

// IsPackFileName reports whether name has the language pack suffix.
func IsPackFileName(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), PackFileSuffix)
}

// InspectPackFile validates a language pack: bounded, containment-checked
// entries, a schema-valid pack.json, only declared files, and a catalog in
// the pack's language. Messages that break a catalog rule become issues.
func (i *Inspector) InspectPackFile(ctx context.Context, filename string) (PackReport, error) {
	if i == nil {
		return PackReport{}, errors.New("inspector is required")
	}
	stat, err := os.Stat(filename)
	if err != nil {
		return PackReport{}, fmt.Errorf("stat language pack: %w", err)
	}
	if stat.IsDir() {
		return PackReport{}, errors.New("language pack path is a directory")
	}
	if stat.Size() > MaxPackArchiveBytes {
		return PackReport{}, inspectionError(CodeArchiveTooLarge, "", fmt.Errorf("%d bytes exceeds %d", stat.Size(), MaxPackArchiveBytes))
	}
	digest, err := hashFile(ctx, filename, MaxPackArchiveBytes)
	if err != nil {
		return PackReport{}, fmt.Errorf("hash language pack: %w", err)
	}
	archive, err := zip.OpenReader(filename)
	if err != nil {
		return PackReport{}, fmt.Errorf("open language pack zip: %w", err)
	}
	defer archive.Close()
	entries, _, _, err := indexEntriesWithin(archive.File, packLimits)
	if err != nil {
		return PackReport{}, err
	}
	manifestEntry, ok := entries[PackManifestFilename]
	if !ok {
		return PackReport{}, inspectionError(CodeMissingFile, PackManifestFilename, errors.New("required pack manifest is missing"))
	}
	body, err := readEntry(ctx, manifestEntry, maxPackManifestBytes)
	if err != nil {
		return PackReport{}, inspectionError(CodeInvalidPack, PackManifestFilename, err)
	}
	manifest, versions, err := i.parsePackManifest(body)
	if err != nil {
		return PackReport{}, err
	}
	declared := map[string]struct{}{PackManifestFilename: {}}
	if manifest.Catalog != "" {
		declared[manifest.Catalog] = struct{}{}
	}
	for _, content := range manifest.Content {
		if _, duplicate := declared[content]; duplicate {
			return PackReport{}, inspectionError(CodeInvalidPack, content, errors.New("a file is declared twice"))
		}
		declared[content] = struct{}{}
	}
	for name := range declared {
		if _, err := normalizedPackagePath(name, false); err != nil {
			return PackReport{}, inspectionError(CodeUnsafePath, name, err)
		}
		if _, present := entries[name]; !present {
			return PackReport{}, inspectionError(CodeMissingFile, name, errors.New("declared file is missing"))
		}
	}
	names := make([]string, 0, len(entries))
	for name := range entries {
		if _, ok := declared[name]; !ok {
			return PackReport{}, inspectionError(CodeInvalidPack, name, errors.New("a language pack holds only pack.json and its declared files"))
		}
		names = append(names, name)
	}
	sort.Strings(names)
	report := PackReport{ArchiveBytes: stat.Size(), ArchiveSHA256: digest, Manifest: manifest, Files: make([]File, 0, len(names)), versions: versions}
	for _, name := range names {
		maximum := uint64(MaxPackContentFileBytes)
		if name == PackManifestFilename {
			maximum = maxPackManifestBytes
		} else if name == manifest.Catalog {
			maximum = MaxCatalogBytes
		}
		content, err := readEntry(ctx, entries[name], maximum)
		if err != nil {
			return PackReport{}, inspectionError(CodeInvalidPack, name, err)
		}
		report.Files = append(report.Files, File{Path: name, Bytes: uint64(len(content)), SHA256: sha256Hex(content)})
		switch {
		case name == manifest.Catalog:
			catalog, issues, _ := i.checkCatalog(content, manifest.Locale, unknownEnglish)
			if catalog == nil {
				return PackReport{}, inspectionError(CodeInvalidPack, name, errors.New(strings.Join(issues, "; ")))
			}
			checked, err := localeCatalog(catalog, name, issues)
			if err != nil {
				return PackReport{}, err
			}
			report.Catalog = &PackCatalog{Messages: checked.Messages, Sections: checked.Sections, Issues: checked.Issues, body: content}
		case name != PackManifestFilename && !json.Valid(content):
			return PackReport{}, inspectionError(CodeInvalidPack, name, errors.New("content overlays must be JSON"))
		}
	}
	return report, nil
}

func (i *Inspector) parsePackManifest(body []byte) (PackManifest, *semver.Constraints, error) {
	fail := func(err error) (PackManifest, *semver.Constraints, error) {
		return PackManifest{}, nil, inspectionError(CodeInvalidPack, PackManifestFilename, err)
	}
	if err := rejectDuplicateMembers(body); err != nil {
		return fail(err)
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return fail(err)
	}
	if err := i.packSchema.Validate(instance); err != nil {
		return fail(errors.New(schemaReason(err)))
	}
	var manifest PackManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return fail(err)
	}
	versions, err := semver.NewConstraint(manifest.AddonVersions)
	if err != nil {
		return fail(fmt.Errorf("addonVersions is not a version range: %w", err))
	}
	built, err := semver.StrictNewVersion(manifest.BuiltFrom)
	if err != nil || !versions.Check(built) {
		return fail(fmt.Errorf("addonVersions %q must include builtFrom %s", manifest.AddonVersions, manifest.BuiltFrom))
	}
	return manifest, versions, nil
}

// MergePackCatalog builds the effective catalog of the pack's language for a
// package whose inspected catalogs are locales. The pack is checked against
// the package's English; the package's own messages win key by key and the
// pack fills the keys they lack. source is "pack" when the package has no
// catalog for the language, "package+pack" when the pack adds messages to
// it and "package" when it adds none.
func (i *Inspector) MergePackCatalog(locales []LocaleCatalog, pack PackReport) (LocaleCatalog, string, error) {
	var english, shipped *LocaleCatalog
	for index := range locales {
		switch locales[index].Locale {
		case "en":
			english = &locales[index]
		case pack.Manifest.Locale:
			shipped = &locales[index]
		}
	}
	if english == nil {
		return LocaleCatalog{}, "", errors.New("the package has no English catalog")
	}
	if pack.Catalog == nil {
		if shipped == nil {
			return LocaleCatalog{}, "", errors.New("the language pack has no catalog")
		}
		return *shipped, "package", nil
	}
	englishCatalog, err := orderedCatalog(english.body)
	if err != nil {
		return LocaleCatalog{}, "", fmt.Errorf("read English catalog: %w", err)
	}
	packCatalog, packIssues, _ := i.checkCatalog(pack.Catalog.body, pack.Manifest.Locale, englishCatalog)
	if packCatalog == nil {
		return LocaleCatalog{}, "", errors.New(strings.Join(packIssues, "; "))
	}
	issues := make([]string, 0, len(packIssues))
	for _, issue := range packIssues {
		issues = append(issues, "language pack: "+issue)
	}
	if shipped == nil {
		merged, err := localeCatalog(packCatalog, "", issues)
		return merged, "pack", err
	}
	result, err := orderedCatalog(shipped.body)
	if err != nil {
		return LocaleCatalog{}, "", fmt.Errorf("read %s catalog: %w", shipped.Locale, err)
	}
	added := 0
	for _, section := range packCatalog.sections {
		for _, entry := range section.entries {
			if _, _, exists := result.find(entry.key); exists {
				continue
			}
			result.add(section.id, entry)
			added++
		}
	}
	if added == 0 {
		issues = nil
	}
	merged, err := localeCatalog(result, shipped.Path, append(append([]string{}, shipped.Issues...), issues...))
	if err != nil || added == 0 {
		return merged, "package", err
	}
	return merged, "package+pack", nil
}

func (catalog *messageCatalog) add(sectionID string, entry catalogEntry) {
	for index := range catalog.sections {
		if catalog.sections[index].id == sectionID {
			catalog.sections[index].entries = append(catalog.sections[index].entries, entry)
			return
		}
	}
	catalog.sections = append(catalog.sections, catalogSection{id: sectionID, entries: []catalogEntry{entry}})
}

// WritePack writes a deterministic pack ZIP: pack.json first, then files in
// path order, all with one fixed timestamp.
func WritePack(writer io.Writer, manifest PackManifest, files map[string][]byte) error {
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(files))
	for name := range files {
		if name == PackManifestFilename {
			return errors.New("pack.json is written from the manifest")
		}
		names = append(names, name)
	}
	sort.Strings(names)
	archive := zip.NewWriter(writer)
	write := func(name string, content []byte) error {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)}
		header.SetMode(0o644)
		entry, err := archive.CreateHeader(header)
		if err == nil {
			_, err = entry.Write(content)
		}
		return err
	}
	if err := write(PackManifestFilename, append(body, '\n')); err != nil {
		return err
	}
	for _, name := range names {
		if err := write(name, files[name]); err != nil {
			return err
		}
	}
	return archive.Close()
}

// DefaultPackVersions is the range a pack built from version covers when its
// author names none: that version up to the next major (next minor for 0.x).
func DefaultPackVersions(version string) (string, error) {
	parsed, err := semver.StrictNewVersion(version)
	if err != nil {
		return "", err
	}
	upper := fmt.Sprintf("%d.0.0", parsed.Major()+1)
	if parsed.Major() == 0 {
		upper = fmt.Sprintf("0.%d.0", parsed.Minor()+1)
	}
	return ">=" + parsed.String() + " <" + upper, nil
}
