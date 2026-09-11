package packageinspect

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"unicode"

	"github.com/pjunak/ttrpg-codex/contracts/addons/v3"
	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicecontract"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	manifestFilename  = "addon.json"
	checksumsFilename = "checksums.json"
)

type Limits struct {
	MaxArchiveBytes  int64
	MaxExpandedBytes uint64
	MaxFileBytes     uint64
	MaxManifestBytes uint64
	MaxSchemaBytes   uint64
	MaxFiles         int
}

var DefaultLimits = Limits{
	MaxArchiveBytes:  128 << 20,
	MaxExpandedBytes: 512 << 20,
	MaxFileBytes:     128 << 20,
	MaxManifestBytes: 1 << 20,
	MaxSchemaBytes:   2 << 20,
	MaxFiles:         10_000,
}

type File struct {
	Path   string `json:"path"`
	Bytes  uint64 `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type Report struct {
	ArchiveBytes            int64                         `json:"archiveBytes"`
	ExpandedBytes           uint64                        `json:"expandedBytes"`
	ArchiveSHA256           string                        `json:"archiveSha256"`
	ChecksumInventorySHA256 string                        `json:"checksumInventorySha256"`
	Manifest                Manifest                      `json:"manifest"`
	Files                   []File                        `json:"files"`
	DataContracts           []datacontract.Description    `json:"dataContracts"`
	ServiceContracts        []servicecontract.Description `json:"serviceContracts"`
	ContentContracts        []contentcontract.Description `json:"contentContracts"`
	dataRegistry            *datacontract.Registry
	serviceRegistry         *servicecontract.Registry
	contentRegistry         *contentcontract.Registry
}

func (report Report) DataRegistry() *datacontract.Registry {
	return report.dataRegistry
}

func (report Report) ServiceRegistry() *servicecontract.Registry {
	return report.serviceRegistry
}

func (report Report) ContentRegistry() *contentcontract.Registry {
	return report.contentRegistry
}

type Inspector struct {
	limits          Limits
	manifestSchema  *jsonschema.Schema
	checksumsSchema *jsonschema.Schema
	serviceCompiler *servicecontract.Compiler
}

func New(limits Limits) (*Inspector, error) {
	limits = normalizedLimits(limits)
	manifestSchema, err := compileSchema("manifest.schema.json", addonv3.ManifestSchema())
	if err != nil {
		return nil, fmt.Errorf("compile manifest schema: %w", err)
	}
	checksumsSchema, err := compileSchema("checksums.schema.json", addonv3.ChecksumsSchema())
	if err != nil {
		return nil, fmt.Errorf("compile checksums schema: %w", err)
	}
	serviceCompiler, err := servicecontract.NewCompiler()
	if err != nil {
		return nil, err
	}
	return &Inspector{
		limits:          limits,
		manifestSchema:  manifestSchema,
		checksumsSchema: checksumsSchema,
		serviceCompiler: serviceCompiler,
	}, nil
}

func normalizedLimits(limits Limits) Limits {
	defaults := DefaultLimits
	if limits.MaxArchiveBytes <= 0 {
		limits.MaxArchiveBytes = defaults.MaxArchiveBytes
	}
	if limits.MaxExpandedBytes == 0 {
		limits.MaxExpandedBytes = defaults.MaxExpandedBytes
	}
	if limits.MaxFileBytes == 0 {
		limits.MaxFileBytes = defaults.MaxFileBytes
	}
	if limits.MaxManifestBytes == 0 {
		limits.MaxManifestBytes = defaults.MaxManifestBytes
	}
	if limits.MaxSchemaBytes == 0 {
		limits.MaxSchemaBytes = defaults.MaxSchemaBytes
	}
	if limits.MaxFiles <= 0 {
		limits.MaxFiles = defaults.MaxFiles
	}
	return limits
}

func compileSchema(name string, body []byte) (*jsonschema.Schema, error) {
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	compiler.UseLoader(packageOfflineLoader{})
	if err := compiler.AddResource(name, document); err != nil {
		return nil, err
	}
	return compiler.Compile(name)
}

func (i *Inspector) InspectFile(ctx context.Context, filename string) (Report, error) {
	if i == nil {
		return Report{}, fmt.Errorf("inspector is required")
	}
	stat, err := os.Stat(filename)
	if err != nil {
		return Report{}, fmt.Errorf("stat package: %w", err)
	}
	if stat.IsDir() {
		return Report{}, fmt.Errorf("package path is a directory")
	}
	if stat.Size() > i.limits.MaxArchiveBytes {
		return Report{}, inspectionError(CodeArchiveTooLarge, "", fmt.Errorf("%d bytes exceeds %d", stat.Size(), i.limits.MaxArchiveBytes))
	}

	archiveDigest, err := hashFile(ctx, filename, i.limits.MaxArchiveBytes)
	if err != nil {
		return Report{}, fmt.Errorf("hash package: %w", err)
	}
	archive, err := zip.OpenReader(filename)
	if err != nil {
		return Report{}, fmt.Errorf("open package zip: %w", err)
	}
	defer archive.Close()

	entries, directories, expandedBytes, err := i.indexEntries(archive.File)
	if err != nil {
		return Report{}, err
	}
	manifestEntry, ok := entries[manifestFilename]
	if !ok {
		return Report{}, inspectionError(CodeMissingFile, manifestFilename, errors.New("required package manifest is missing"))
	}
	checksumsEntry, ok := entries[checksumsFilename]
	if !ok {
		return Report{}, inspectionError(CodeMissingFile, checksumsFilename, errors.New("required checksum inventory is missing"))
	}
	if manifestEntry.UncompressedSize64 > i.limits.MaxManifestBytes {
		return Report{}, inspectionError(CodeInvalidManifest, manifestFilename, fmt.Errorf("manifest exceeds %d bytes", i.limits.MaxManifestBytes))
	}

	checksumBody, err := readEntry(ctx, checksumsEntry, i.limits.MaxFileBytes)
	if err != nil {
		return Report{}, inspectionError(CodeInvalidChecksums, checksumsFilename, err)
	}
	checksumInventory, err := i.parseChecksums(checksumBody)
	if err != nil {
		return Report{}, err
	}
	files, err := i.verifyChecksums(ctx, entries, checksumInventory)
	if err != nil {
		return Report{}, err
	}

	manifestBody, err := readEntry(ctx, manifestEntry, i.limits.MaxManifestBytes)
	if err != nil {
		return Report{}, inspectionError(CodeInvalidManifest, manifestFilename, err)
	}
	manifest, err := i.parseManifest(manifestBody)
	if err != nil {
		return Report{}, err
	}
	if err := validateDeclarations(manifest, entries, directories); err != nil {
		return Report{}, err
	}
	dataRegistry, contentSchemas, serviceRegistry, err := i.validateDeclaredSchemas(ctx, manifest, entries)
	if err != nil {
		return Report{}, err
	}
	contentFiles, err := i.readContentFiles(ctx, manifest, entries)
	if err != nil {
		return Report{}, err
	}
	contentRegistry, err := contentcontract.Compile(
		contentDeclarations(manifest), contentFiles, contentSchemas,
	)
	if err != nil {
		return Report{}, inspectionError(CodeInvalidContent, "", err)
	}
	if err := validateRules(manifest, contentRegistry); err != nil {
		return Report{}, inspectionError(CodeInvalidDeclaration, "rules", err)
	}

	checksumDigest := sha256.Sum256(checksumBody)
	return Report{
		ArchiveBytes:            stat.Size(),
		ExpandedBytes:           expandedBytes,
		ArchiveSHA256:           archiveDigest,
		ChecksumInventorySHA256: hex.EncodeToString(checksumDigest[:]),
		Manifest:                manifest,
		Files:                   files,
		DataContracts:           dataRegistry.Descriptions(),
		ServiceContracts:        serviceRegistry.Descriptions(),
		ContentContracts:        contentRegistry.Descriptions(),
		dataRegistry:            dataRegistry,
		serviceRegistry:         serviceRegistry,
		contentRegistry:         contentRegistry,
	}, nil
}

func (i *Inspector) validateDeclaredSchemas(
	ctx context.Context,
	manifest Manifest,
	entries map[string]*zip.File,
) (*datacontract.Registry, *datacontract.Registry, *servicecontract.Registry, error) {
	declared := declaredDataSchemaPaths(manifest)
	serviceDeclarations := make([]servicecontract.Declaration, 0, len(manifest.Services.Provides))
	serviceDocuments := make(map[string]struct{}, len(manifest.Services.Provides))
	resources := make(map[string]struct{}, len(declared)+len(manifest.Services.Provides))
	for _, filename := range declared {
		resources[filename] = struct{}{}
	}
	for _, service := range manifest.Services.Provides {
		serviceDeclarations = append(serviceDeclarations, servicecontract.Declaration{
			Contract:  service.Contract,
			Version:   service.Version,
			Document:  service.Schema,
			Exclusive: service.Exclusive,
		})
		serviceDocuments[service.Schema] = struct{}{}
		resources[service.Schema] = struct{}{}
	}
	for filename := range entries {
		if strings.HasPrefix(filename, "contracts/") && strings.HasSuffix(filename, ".json") {
			resources[filename] = struct{}{}
		}
	}

	filenames := make([]string, 0, len(resources))
	for filename := range resources {
		filenames = append(filenames, filename)
	}
	sort.Strings(filenames)

	resourceBodies := make(map[string][]byte, len(filenames))
	schemaResourceBodies := make(map[string][]byte, len(filenames))
	schemaCompiler := jsonschema.NewCompiler()
	schemaCompiler.DefaultDraft(jsonschema.Draft2020)
	schemaCompiler.AssertFormat()
	schemaCompiler.UseLoader(packageOfflineLoader{})
	resourceURLs := make(map[string]string, len(filenames))
	for _, filename := range filenames {
		entry, ok := entries[filename]
		if !ok {
			return nil, nil, nil, inspectionError(CodeInvalidSchema, filename, errors.New("schema resource is missing"))
		}
		body, err := readEntry(ctx, entry, i.limits.MaxSchemaBytes)
		if err != nil {
			return nil, nil, nil, inspectionError(CodeInvalidSchema, filename, err)
		}
		resourceBodies[filename] = body
		if _, isServiceDocument := serviceDocuments[filename]; isServiceDocument {
			continue
		}
		schemaResourceBodies[filename] = body
		document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
		if err != nil {
			return nil, nil, nil, inspectionError(CodeInvalidSchema, filename, err)
		}
		resourceURL := packageResourceURL(filename)
		if err := schemaCompiler.AddResource(resourceURL, document); err != nil {
			return nil, nil, nil, inspectionError(CodeInvalidSchema, filename, err)
		}
		resourceURLs[filename] = resourceURL
	}

	for _, filename := range declared {
		if _, err := schemaCompiler.Compile(resourceURLs[filename]); err != nil {
			return nil, nil, nil, inspectionError(CodeInvalidSchema, filename, err)
		}
	}
	dataRegistry, err := datacontract.Compile(dataDeclarations(manifest), schemaResourceBodies)
	if err != nil {
		return nil, nil, nil, inspectionError(CodeInvalidSchema, "", err)
	}
	contentSchemas, err := datacontract.Compile(contentSchemaDeclarations(manifest), schemaResourceBodies)
	if err != nil {
		return nil, nil, nil, inspectionError(CodeInvalidSchema, "", err)
	}
	serviceRegistry, err := i.serviceCompiler.Compile(serviceDeclarations, resourceBodies)
	if err != nil {
		code := CodeInvalidSchema
		if errors.Is(err, servicecontract.ErrInvalidDeclaration) {
			code = CodeInvalidDeclaration
		}
		var compileError *servicecontract.CompileError
		if errors.As(err, &compileError) {
			return nil, nil, nil, inspectionError(code, compileError.Path, compileError.Cause)
		}
		return nil, nil, nil, inspectionError(code, "", err)
	}
	return dataRegistry, contentSchemas, serviceRegistry, nil
}

func dataDeclarations(manifest Manifest) []datacontract.Declaration {
	result := make([]datacontract.Declaration, 0, len(manifest.Collections)+len(manifest.RecordExtensions))
	for _, collection := range manifest.Collections {
		indexes := make([]datacontract.Index, len(collection.Indexes))
		for index, value := range collection.Indexes {
			indexes[index] = datacontract.Index{Path: value.Path, Unique: value.Unique}
		}
		result = append(result, datacontract.Declaration{
			Kind: datacontract.Collection, ID: collection.ID, Keyed: collection.Keyed,
			Visibility: datacontract.Visibility(collection.Visibility), Schema: collection.Schema,
			SchemaVersion: collection.SchemaVersion, Indexes: indexes,
		})
	}
	for _, extension := range manifest.RecordExtensions {
		result = append(result, datacontract.Declaration{
			Kind: datacontract.RecordExtension, ID: extension.ID, Target: extension.Target,
			Visibility: datacontract.Visibility(extension.Visibility), Schema: extension.Schema,
			SchemaVersion: extension.SchemaVersion,
		})
	}
	return result
}

func contentSchemaDeclarations(manifest Manifest) []datacontract.Declaration {
	result := make([]datacontract.Declaration, 0, len(manifest.Content))
	for _, content := range manifest.Content {
		result = append(result, datacontract.Declaration{
			Kind: datacontract.Collection, ID: content.ID, Keyed: true,
			Visibility: datacontract.VisibilityPublic,
			Schema:     content.Schema, SchemaVersion: content.Revision,
		})
	}
	return result
}

func contentDeclarations(manifest Manifest) []contentcontract.Declaration {
	result := make([]contentcontract.Declaration, 0, len(manifest.Content))
	for _, content := range manifest.Content {
		var groups *contentcontract.Groups
		if content.Groups != nil {
			groups = &contentcontract.Groups{
				Field: content.Groups.Field, AdditionalField: content.Groups.AdditionalField,
				Label: content.Groups.Label,
			}
		}
		result = append(result, contentcontract.Declaration{
			ID: content.ID, Root: content.Root, Schema: content.Schema, Revision: content.Revision,
			Groups: groups,
		})
	}
	return result
}

func (i *Inspector) readContentFiles(
	ctx context.Context,
	manifest Manifest,
	entries map[string]*zip.File,
) ([]contentcontract.File, error) {
	paths := make([]string, 0)
	for filename := range entries {
		if !strings.HasSuffix(filename, ".json") {
			continue
		}
		for _, content := range manifest.Content {
			if strings.HasPrefix(filename, content.Root+"/") {
				paths = append(paths, filename)
				break
			}
		}
	}
	sort.Strings(paths)
	files := make([]contentcontract.File, 0, len(paths))
	for _, filename := range paths {
		body, err := readEntry(ctx, entries[filename], i.limits.MaxFileBytes)
		if err != nil {
			return nil, inspectionError(CodeInvalidContent, filename, err)
		}
		files = append(files, contentcontract.File{Path: filename, Body: body})
	}
	return files, nil
}

func declaredDataSchemaPaths(manifest Manifest) []string {
	unique := make(map[string]struct{})
	for _, collection := range manifest.Collections {
		unique[collection.Schema] = struct{}{}
	}
	for _, extension := range manifest.RecordExtensions {
		unique[extension.Schema] = struct{}{}
	}
	for _, content := range manifest.Content {
		unique[content.Schema] = struct{}{}
	}
	result := make([]string, 0, len(unique))
	for filename := range unique {
		result = append(result, filename)
	}
	sort.Strings(result)
	return result
}

func packageResourceURL(filename string) string {
	return (&url.URL{Scheme: "file", Path: "/addon/" + filename}).String()
}

type packageOfflineLoader struct{}

func (packageOfflineLoader) Load(location string) (any, error) {
	return nil, fmt.Errorf("external schema resource %q is unavailable during package inspection", location)
}

func (i *Inspector) indexEntries(zipEntries []*zip.File) (map[string]*zip.File, map[string]struct{}, uint64, error) {
	entries := make(map[string]*zip.File, len(zipEntries))
	directories := make(map[string]struct{})
	caseFolded := make(map[string]string, len(zipEntries))
	var expandedBytes uint64
	fileCount := 0

	for _, entry := range zipEntries {
		isDirectory := entry.FileInfo().IsDir()
		normalized, err := normalizedPackagePath(entry.Name, isDirectory)
		if err != nil {
			return nil, nil, 0, inspectionError(CodeUnsafePath, entry.Name, err)
		}
		folded := strings.ToLower(normalized)
		if previous, exists := caseFolded[folded]; exists {
			return nil, nil, 0, inspectionError(CodeDuplicatePath, normalized, fmt.Errorf("collides with %s", previous))
		}
		caseFolded[folded] = normalized

		mode := entry.FileInfo().Mode()
		if mode&os.ModeSymlink != 0 || (!isDirectory && !mode.IsRegular()) {
			return nil, nil, 0, inspectionError(CodeUnsupportedEntry, normalized, fmt.Errorf("mode %s is not a regular file", mode))
		}
		if entry.Flags&0x1 != 0 {
			return nil, nil, 0, inspectionError(CodeUnsupportedEntry, normalized, errors.New("encrypted zip entries are unsupported"))
		}
		if isDirectory {
			directories[normalized] = struct{}{}
			continue
		}

		fileCount++
		if fileCount > i.limits.MaxFiles {
			return nil, nil, 0, inspectionError(CodeTooManyFiles, "", fmt.Errorf("file count exceeds %d", i.limits.MaxFiles))
		}
		if entry.UncompressedSize64 > i.limits.MaxFileBytes {
			return nil, nil, 0, inspectionError(CodeExpandedTooLarge, normalized, fmt.Errorf("file exceeds %d bytes", i.limits.MaxFileBytes))
		}
		if entry.UncompressedSize64 > i.limits.MaxExpandedBytes-expandedBytes {
			return nil, nil, 0, inspectionError(CodeExpandedTooLarge, normalized, fmt.Errorf("expanded package exceeds %d bytes", i.limits.MaxExpandedBytes))
		}
		expandedBytes += entry.UncompressedSize64
		entries[normalized] = entry
	}
	return entries, directories, expandedBytes, nil
}

func normalizedPackagePath(name string, isDirectory bool) (string, error) {
	if name == "" {
		return "", errors.New("empty path")
	}
	if strings.Contains(name, "\\") {
		return "", errors.New("backslashes are forbidden")
	}
	if strings.HasPrefix(name, "/") {
		return "", errors.New("absolute paths are forbidden")
	}
	for _, character := range name {
		if character == 0 || unicode.IsControl(character) {
			return "", errors.New("control characters are forbidden")
		}
	}

	candidate := name
	if isDirectory {
		candidate = strings.TrimSuffix(candidate, "/")
	}
	cleaned := path.Clean(candidate)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("path traversal is forbidden")
	}
	if cleaned != candidate {
		return "", errors.New("path is not normalized")
	}
	firstSegment := strings.SplitN(cleaned, "/", 2)[0]
	if strings.Contains(firstSegment, ":") {
		return "", errors.New("drive or URI paths are forbidden")
	}
	return cleaned, nil
}

func (i *Inspector) parseManifest(body []byte) (Manifest, error) {
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return Manifest{}, inspectionError(CodeInvalidManifest, manifestFilename, err)
	}
	if err := i.manifestSchema.Validate(instance); err != nil {
		return Manifest{}, inspectionError(CodeInvalidManifest, manifestFilename, err)
	}
	var manifest Manifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return Manifest{}, inspectionError(CodeInvalidManifest, manifestFilename, err)
	}
	return manifest, nil
}

type checksumFile struct {
	Algorithm string            `json:"algorithm"`
	Files     map[string]string `json:"files"`
}

func (i *Inspector) parseChecksums(body []byte) (checksumFile, error) {
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return checksumFile{}, inspectionError(CodeInvalidChecksums, checksumsFilename, err)
	}
	if err := i.checksumsSchema.Validate(instance); err != nil {
		return checksumFile{}, inspectionError(CodeInvalidChecksums, checksumsFilename, err)
	}
	var inventory checksumFile
	if err := json.Unmarshal(body, &inventory); err != nil {
		return checksumFile{}, inspectionError(CodeInvalidChecksums, checksumsFilename, err)
	}
	if _, listed := inventory.Files[checksumsFilename]; listed {
		return checksumFile{}, inspectionError(CodeInvalidChecksums, checksumsFilename, errors.New("checksum inventory must not list itself"))
	}
	return inventory, nil
}

func (i *Inspector) verifyChecksums(ctx context.Context, entries map[string]*zip.File, inventory checksumFile) ([]File, error) {
	if len(inventory.Files) != len(entries)-1 {
		return nil, inspectionError(CodeInvalidChecksums, checksumsFilename, fmt.Errorf("inventory has %d files, package has %d", len(inventory.Files), len(entries)-1))
	}

	paths := make([]string, 0, len(inventory.Files))
	for filename := range inventory.Files {
		if _, err := normalizedPackagePath(filename, false); err != nil {
			return nil, inspectionError(CodeInvalidChecksums, filename, err)
		}
		if _, ok := entries[filename]; !ok {
			return nil, inspectionError(CodeInvalidChecksums, filename, errors.New("listed file is missing from package"))
		}
		paths = append(paths, filename)
	}
	for filename := range entries {
		if filename == checksumsFilename {
			continue
		}
		if _, ok := inventory.Files[filename]; !ok {
			return nil, inspectionError(CodeInvalidChecksums, filename, errors.New("package file is missing from checksum inventory"))
		}
	}
	sort.Strings(paths)

	files := make([]File, 0, len(paths))
	for _, filename := range paths {
		body, err := readEntry(ctx, entries[filename], i.limits.MaxFileBytes)
		if err != nil {
			return nil, inspectionError(CodeChecksumMismatch, filename, err)
		}
		digest := sha256.Sum256(body)
		actual := hex.EncodeToString(digest[:])
		if actual != inventory.Files[filename] {
			return nil, inspectionError(CodeChecksumMismatch, filename, fmt.Errorf("got %s, want %s", actual, inventory.Files[filename]))
		}
		files = append(files, File{Path: filename, Bytes: uint64(len(body)), SHA256: actual})
	}
	return files, nil
}

func validateDeclarations(manifest Manifest, entries map[string]*zip.File, directories map[string]struct{}) error {
	if manifest.Runtime != nil {
		if manifest.Runtime.UI != nil {
			if err := requireFile(entries, manifest.Runtime.UI.Entry, "runtime.ui.entry"); err != nil {
				return err
			}
			for index, filename := range manifest.Runtime.UI.Styles {
				if err := requireFile(entries, filename, fmt.Sprintf("runtime.ui.styles[%d]", index)); err != nil {
					return err
				}
			}
		}
		if manifest.Runtime.Worker != nil {
			if manifest.Compatibility.WorkerProtocol == "" {
				return inspectionError(CodeInvalidDeclaration, "compatibility.workerProtocol", errors.New("worker runtime requires a compatible worker protocol range"))
			}
			worker := manifest.Runtime.Worker
			if worker.Entrypoint != "" {
				if err := requireFile(entries, worker.Entrypoint, "runtime.worker.entrypoint"); err != nil {
					return err
				}
			}
			targets := make([]string, 0, len(worker.Entrypoints))
			for target := range worker.Entrypoints {
				targets = append(targets, target)
			}
			sort.Strings(targets)
			for _, target := range targets {
				if err := requireFile(entries, worker.Entrypoints[target], "runtime.worker.entrypoints."+target); err != nil {
					return err
				}
			}
		}
	}

	localeNames := make([]string, 0, len(manifest.Locales))
	for locale := range manifest.Locales {
		localeNames = append(localeNames, locale)
	}
	sort.Strings(localeNames)
	for _, locale := range localeNames {
		if err := requireFile(entries, manifest.Locales[locale], "locales."+locale); err != nil {
			return err
		}
	}

	if err := validateUnique(manifest); err != nil {
		return err
	}
	for index, collection := range manifest.Collections {
		if err := requireFile(entries, collection.Schema, fmt.Sprintf("collections[%d].schema", index)); err != nil {
			return err
		}
	}
	for index, extension := range manifest.RecordExtensions {
		if err := requireFile(entries, extension.Schema, fmt.Sprintf("recordExtensions[%d].schema", index)); err != nil {
			return err
		}
	}
	for index, service := range manifest.Services.Provides {
		if err := requireFile(entries, service.Schema, fmt.Sprintf("services.provides[%d].schema", index)); err != nil {
			return err
		}
		switch service.Transport {
		case "worker":
			if manifest.Runtime == nil || manifest.Runtime.Worker == nil {
				return inspectionError(CodeInvalidDeclaration, service.Contract, errors.New("worker service has no worker runtime"))
			}
		case "ui":
			if manifest.Runtime == nil || manifest.Runtime.UI == nil {
				return inspectionError(CodeInvalidDeclaration, service.Contract, errors.New("UI service has no UI runtime"))
			}
		case "content":
			if len(manifest.Content) == 0 {
				return inspectionError(CodeInvalidDeclaration, service.Contract, errors.New("content service has no content set"))
			}
		}
	}
	for index, content := range manifest.Content {
		if err := requireFile(entries, content.Schema, fmt.Sprintf("content[%d].schema", index)); err != nil {
			return err
		}
		if !hasDirectoryContent(entries, directories, content.Root) {
			return inspectionError(CodeInvalidDeclaration, fmt.Sprintf("content[%d].root", index), fmt.Errorf("declared content root %q is empty or missing", content.Root))
		}
	}

	declaredCapabilities := make(map[string]struct{},
		len(manifest.Capabilities.Required)+len(manifest.Capabilities.Optional))
	for _, capability := range manifest.Capabilities.Required {
		declaredCapabilities[capability] = struct{}{}
	}
	for _, capability := range manifest.Capabilities.Optional {
		if _, declared := declaredCapabilities[capability]; declared {
			return inspectionError(
				CodeInvalidDeclaration,
				"capabilities.optional",
				fmt.Errorf("capability %q is both required and optional", capability),
			)
		}
		declaredCapabilities[capability] = struct{}{}
	}
	for index, contribution := range manifest.Contributions {
		for _, capability := range contribution.Requires {
			if _, declared := declaredCapabilities[capability]; !declared {
				return inspectionError(
					CodeInvalidDeclaration,
					fmt.Sprintf("contributions[%d].requires", index),
					fmt.Errorf("capability %q is not declared by the package", capability),
				)
			}
		}
		switch contribution.Surface {
		case "kind":
			// Pure manifest data needs no runtime.
		case "http-endpoint":
			if manifest.Runtime == nil || manifest.Runtime.Worker == nil {
				return inspectionError(CodeInvalidDeclaration, fmt.Sprintf("contributions[%d]", index), errors.New("HTTP endpoint has no worker runtime"))
			}
		default:
			if manifest.Runtime == nil || manifest.Runtime.UI == nil {
				return inspectionError(CodeInvalidDeclaration, fmt.Sprintf("contributions[%d]", index), errors.New("UI contribution has no UI runtime"))
			}
		}
	}
	return nil
}

func validateUnique(manifest Manifest) error {
	type item struct {
		category string
		id       string
	}
	groups := [][]item{
		make([]item, 0, len(manifest.Permissions)),
		make([]item, 0, len(manifest.Contributions)),
		make([]item, 0, len(manifest.Collections)),
		make([]item, 0, len(manifest.RecordExtensions)),
		make([]item, 0, len(manifest.Content)),
		make([]item, 0, len(manifest.Dependencies)),
		make([]item, 0, len(manifest.Services.Provides)),
		make([]item, 0, len(manifest.Services.Consumes)),
	}
	for _, value := range manifest.Permissions {
		groups[0] = append(groups[0], item{"permissions", value.ID})
	}
	for _, value := range manifest.Contributions {
		groups[1] = append(groups[1], item{"contributions", value.ID})
	}
	for _, value := range manifest.Collections {
		groups[2] = append(groups[2], item{"collections", value.ID})
	}
	for _, value := range manifest.RecordExtensions {
		groups[3] = append(groups[3], item{"recordExtensions", value.ID})
	}
	for _, value := range manifest.Content {
		groups[4] = append(groups[4], item{"content", value.ID})
	}
	for _, value := range manifest.Dependencies {
		if value.ID == manifest.ID {
			return inspectionError(CodeInvalidDeclaration, "dependencies", errors.New("an add-on cannot depend on itself"))
		}
		groups[5] = append(groups[5], item{"dependencies", value.ID})
	}
	for _, value := range manifest.Services.Provides {
		groups[6] = append(groups[6], item{"services.provides", value.Contract})
	}
	for _, value := range manifest.Services.Consumes {
		groups[7] = append(groups[7], item{"services.consumes", value.Contract})
	}

	for _, group := range groups {
		seen := make(map[string]struct{}, len(group))
		for _, value := range group {
			if _, exists := seen[value.id]; exists {
				return inspectionError(CodeInvalidDeclaration, value.category, fmt.Errorf("duplicate id %q", value.id))
			}
			seen[value.id] = struct{}{}
		}
	}
	return nil
}

func requireFile(entries map[string]*zip.File, filename, declaration string) error {
	normalized, err := normalizedPackagePath(filename, false)
	if err != nil {
		return inspectionError(CodeInvalidDeclaration, declaration, err)
	}
	if _, ok := entries[normalized]; !ok {
		return inspectionError(CodeInvalidDeclaration, declaration, fmt.Errorf("declared file %q is missing", normalized))
	}
	return nil
}

func hasDirectoryContent(entries map[string]*zip.File, directories map[string]struct{}, root string) bool {
	normalized, err := normalizedPackagePath(root, false)
	if err != nil {
		return false
	}
	if _, ok := directories[normalized]; ok {
		// An explicit directory still needs at least one regular file.
	}
	prefix := normalized + "/"
	for filename := range entries {
		if strings.HasPrefix(filename, prefix) {
			return true
		}
	}
	return false
}

func readEntry(ctx context.Context, entry *zip.File, maximum uint64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	limited := io.LimitReader(reader, int64(maximum)+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if uint64(len(body)) > maximum {
		return nil, fmt.Errorf("expanded file exceeds %d bytes", maximum)
	}
	return body, nil
}

func hashFile(ctx context.Context, filename string, maximum int64) (string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(&contextReader{ctx: ctx, reader: file}, maximum+1))
	if err != nil {
		return "", err
	}
	if written > maximum {
		return "", fmt.Errorf("archive exceeds %d bytes", maximum)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
