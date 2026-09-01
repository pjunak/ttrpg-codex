package packageinspect

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestInspectFileAcceptsVerifiedPackage(t *testing.T) {
	t.Parallel()

	packagePath := writePackage(t, map[string][]byte{
		manifestFilename: minimalManifest("example-addon"),
	})
	inspector := newTestInspector(t)
	report, err := inspector.InspectFile(context.Background(), packagePath)
	if err != nil {
		t.Fatal(err)
	}

	if report.Manifest.ID != "example-addon" {
		t.Fatalf("manifest id = %q", report.Manifest.ID)
	}
	if len(report.Files) != 1 || report.Files[0].Path != manifestFilename {
		t.Fatalf("unexpected verified files: %+v", report.Files)
	}
	if len(report.ArchiveSHA256) != 64 || report.ArchiveBytes == 0 || report.ExpandedBytes == 0 {
		t.Fatalf("incomplete report: %+v", report)
	}
}

func TestInspectFileRejectsUnsafeAndCaseCollidingPaths(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		entries []zipEntry
		code    string
	}{
		{
			name: "traversal",
			entries: []zipEntry{
				{name: "../escape", body: []byte("no")},
			},
			code: CodeUnsafePath,
		},
		{
			name: "case collision",
			entries: []zipEntry{
				{name: "file.txt", body: []byte("one")},
				{name: "FILE.txt", body: []byte("two")},
			},
			code: CodeDuplicatePath,
		},
		{
			name: "symlink",
			entries: []zipEntry{
				{name: "link", body: []byte("target"), mode: os.ModeSymlink | 0o777},
			},
			code: CodeUnsupportedEntry,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			packagePath := writeRawZip(t, test.entries)
			_, err := newTestInspector(t).InspectFile(context.Background(), packagePath)
			assertInspectionCode(t, err, test.code)
		})
	}
}

func TestInspectFileRejectsInvalidManifestAndMissingDeclaration(t *testing.T) {
	t.Parallel()

	t.Run("invalid manifest", func(t *testing.T) {
		t.Parallel()
		packagePath := writePackage(t, map[string][]byte{
			manifestFilename: minimalManifest("INVALID_ID"),
		})
		_, err := newTestInspector(t).InspectFile(context.Background(), packagePath)
		assertInspectionCode(t, err, CodeInvalidManifest)
	})

	t.Run("missing UI entry", func(t *testing.T) {
		t.Parallel()
		var manifest map[string]any
		if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
			t.Fatal(err)
		}
		manifest["runtime"] = map[string]any{
			"ui": map[string]any{
				"mode":  "integrated",
				"entry": "web/missing.js",
			},
		}
		body, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		packagePath := writePackage(t, map[string][]byte{manifestFilename: body})
		_, err = newTestInspector(t).InspectFile(context.Background(), packagePath)
		assertInspectionCode(t, err, CodeInvalidDeclaration)
	})

	t.Run("UI files outside web subtree", func(t *testing.T) {
		t.Parallel()
		for _, field := range []string{"entry", "styles"} {
			field := field
			t.Run(field, func(t *testing.T) {
				t.Parallel()
				var manifest map[string]any
				if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
					t.Fatal(err)
				}
				ui := map[string]any{"mode": "integrated", "entry": "web/index.js"}
				if field == "entry" {
					ui["entry"] = "contracts/browser.js"
				} else {
					ui["styles"] = []string{"content/browser.css"}
				}
				manifest["runtime"] = map[string]any{"ui": ui}
				body, err := json.Marshal(manifest)
				if err != nil {
					t.Fatal(err)
				}
				packagePath := writePackage(t, map[string][]byte{
					manifestFilename:       body,
					"web/index.js":         []byte("export function activate() {}"),
					"contracts/browser.js": []byte("export function activate() {}"),
					"content/browser.css":  []byte(":host {}"),
				})
				_, err = newTestInspector(t).InspectFile(context.Background(), packagePath)
				assertInspectionCode(t, err, CodeInvalidManifest)
			})
		}
	})

	t.Run("UI files require executable and stylesheet types", func(t *testing.T) {
		t.Parallel()
		for _, test := range []struct {
			name   string
			entry  string
			styles []string
		}{
			{name: "entry", entry: "web/index.html"},
			{name: "style", entry: "web/index.js", styles: []string{"web/theme.js"}},
		} {
			test := test
			t.Run(test.name, func(t *testing.T) {
				t.Parallel()
				var manifest map[string]any
				if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
					t.Fatal(err)
				}
				manifest["runtime"] = map[string]any{"ui": map[string]any{
					"mode": "isolated", "entry": test.entry, "styles": test.styles,
				}}
				body, err := json.Marshal(manifest)
				if err != nil {
					t.Fatal(err)
				}
				packagePath := writePackage(t, map[string][]byte{
					manifestFilename: body,
					"web/index.html": []byte("<!doctype html>"),
					"web/index.js":   []byte("export function activate() {}"),
					"web/theme.js":   []byte("export {}"),
				})
				_, err = newTestInspector(t).InspectFile(context.Background(), packagePath)
				assertInspectionCode(t, err, CodeInvalidManifest)
			})
		}
	})

	t.Run("contribution requires undeclared capability", func(t *testing.T) {
		t.Parallel()
		var manifest map[string]any
		if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
			t.Fatal(err)
		}
		manifest["runtime"] = map[string]any{
			"ui": map[string]any{"mode": "integrated", "entry": "web/index.js"},
		}
		manifest["contributions"] = []any{map[string]any{
			"id": "planner.route", "surface": "route", "label": "Planner",
			"requires": []string{"ui.contributions"},
		}}
		body, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		packagePath := writePackage(t, map[string][]byte{
			manifestFilename: body,
			"web/index.js":   []byte("export function activate() {}"),
		})
		_, err = newTestInspector(t).InspectFile(context.Background(), packagePath)
		assertInspectionCode(t, err, CodeInvalidDeclaration)
	})

	t.Run("capability cannot be required and optional", func(t *testing.T) {
		t.Parallel()
		var manifest map[string]any
		if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
			t.Fatal(err)
		}
		manifest["capabilities"] = map[string]any{
			"required": []string{"ui.contributions"},
			"optional": []string{"ui.contributions"},
		}
		body, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		packagePath := writePackage(t, map[string][]byte{manifestFilename: body})
		_, err = newTestInspector(t).InspectFile(context.Background(), packagePath)
		assertInspectionCode(t, err, CodeInvalidDeclaration)
	})
}

func TestInspectFileRejectsChecksumMismatchAndIncompleteInventory(t *testing.T) {
	t.Parallel()

	t.Run("mismatch", func(t *testing.T) {
		t.Parallel()
		manifest := minimalManifest("example-addon")
		inventory := checksumJSON(t, map[string][]byte{manifestFilename: manifest})
		packagePath := writeRawZip(t, []zipEntry{
			{name: manifestFilename, body: append(manifest, '\n')},
			{name: checksumsFilename, body: inventory},
		})
		_, err := newTestInspector(t).InspectFile(context.Background(), packagePath)
		assertInspectionCode(t, err, CodeChecksumMismatch)
	})

	t.Run("unlisted file", func(t *testing.T) {
		t.Parallel()
		manifest := minimalManifest("example-addon")
		inventory := checksumJSON(t, map[string][]byte{manifestFilename: manifest})
		packagePath := writeRawZip(t, []zipEntry{
			{name: manifestFilename, body: manifest},
			{name: "extra.txt", body: []byte("not listed")},
			{name: checksumsFilename, body: inventory},
		})
		_, err := newTestInspector(t).InspectFile(context.Background(), packagePath)
		assertInspectionCode(t, err, CodeInvalidChecksums)
	})
}

func TestInspectFileHonorsExpandedSizeLimit(t *testing.T) {
	t.Parallel()

	manifest := minimalManifest("example-addon")
	packagePath := writePackage(t, map[string][]byte{manifestFilename: manifest})
	inspector, err := New(Limits{MaxExpandedBytes: uint64(len(manifest) - 1)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = inspector.InspectFile(context.Background(), packagePath)
	assertInspectionCode(t, err, CodeExpandedTooLarge)
}

func TestInspectFileCompilesDeclaredSchemas(t *testing.T) {
	t.Parallel()

	var manifest map[string]any
	if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["collections"] = []any{map[string]any{
		"id":            "notes",
		"keyed":         true,
		"visibility":    "dm",
		"schema":        "contracts/notes.schema.json",
		"schemaVersion": "1.0.0",
	}}
	manifestBody, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	packagePath := writePackage(t, map[string][]byte{
		manifestFilename:              manifestBody,
		"contracts/notes.schema.json": []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"not-a-json-type"}`),
	})

	_, err = newTestInspector(t).InspectFile(context.Background(), packagePath)
	assertInspectionCode(t, err, CodeInvalidSchema)
}

func TestInspectFileCompilesAndReportsServiceDocuments(t *testing.T) {
	t.Parallel()

	manifest := manifestWithWorkerService(t, "dnd5e.rules-engine", "3.1.0")
	serviceBody, err := json.Marshal(map[string]any{
		"contract": "dnd5e.rules-engine", "version": "3.1.0", "allowsExclusive": false,
		"methods": map[string]any{
			"evaluate-character": map[string]any{
				"requestSchema": "contracts/evaluate.request.schema.json", "responseSchema": "contracts/evaluate.response.schema.json",
				"maxDeadlineMs": 2000, "idempotency": "optional", "errors": []string{"INVALID_INPUT"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	packagePath := writePackage(t, map[string][]byte{
		manifestFilename:                         manifest,
		"worker/addon.wasm":                      []byte("not executed during inspection"),
		"contracts/engine.service.json":          serviceBody,
		"contracts/evaluate.request.schema.json": []byte(`{"$ref":"common.schema.json#/$defs/request"}`),
		"contracts/evaluate.response.schema.json": []byte(
			`{"type":"object","required":["total"],"properties":{"total":{"type":"integer"}}}`,
		),
		"contracts/common.schema.json": []byte(
			`{"$defs":{"request":{"type":"object","required":["level"],"properties":{"level":{"type":"integer"}}}}}`,
		),
	})
	report, err := newTestInspector(t).InspectFile(context.Background(), packagePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.ServiceContracts) != 1 || report.ServiceContracts[0].Contract != "dnd5e.rules-engine" ||
		len(report.ServiceContracts[0].Methods) != 1 || report.ServiceContracts[0].Methods[0].MaxDeadlineMS != 2000 {
		t.Fatalf("unexpected service contract report: %+v", report.ServiceContracts)
	}
}

func TestInspectFileRejectsServiceDocumentMismatchAndExternalSchemaReference(t *testing.T) {
	t.Parallel()

	t.Run("service version mismatch", func(t *testing.T) {
		t.Parallel()
		serviceBody := []byte(`{
			"contract":"dnd5e.rules-engine","version":"4.0.0","allowsExclusive":false,
			"methods":{"evaluate-character":{"requestSchema":"contracts/request.json","responseSchema":"contracts/response.json","maxDeadlineMs":2000,"idempotency":"none"}}
		}`)
		packagePath := writePackage(t, map[string][]byte{
			manifestFilename:                manifestWithWorkerService(t, "dnd5e.rules-engine", "3.1.0"),
			"worker/addon.wasm":             []byte("worker"),
			"contracts/engine.service.json": serviceBody,
			"contracts/request.json":        []byte(`{"type":"object"}`),
			"contracts/response.json":       []byte(`{"type":"object"}`),
		})
		_, err := newTestInspector(t).InspectFile(context.Background(), packagePath)
		assertInspectionCode(t, err, CodeInvalidDeclaration)
	})

	t.Run("external collection schema reference", func(t *testing.T) {
		t.Parallel()
		var manifest map[string]any
		if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
			t.Fatal(err)
		}
		manifest["collections"] = []any{map[string]any{
			"id": "notes", "keyed": true, "visibility": "dm",
			"schema": "contracts/notes.schema.json", "schemaVersion": "1.0.0",
		}}
		manifestBody, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		packagePath := writePackage(t, map[string][]byte{
			manifestFilename: manifestBody,
			"contracts/notes.schema.json": []byte(
				`{"$ref":"file:///outside/host.schema.json"}`,
			),
		})
		_, err = newTestInspector(t).InspectFile(context.Background(), packagePath)
		assertInspectionCode(t, err, CodeInvalidSchema)
	})
}

func newTestInspector(t *testing.T) *Inspector {
	t.Helper()
	inspector, err := New(DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	return inspector
}

func minimalManifest(id string) []byte {
	value := map[string]any{
		"packageFormat": 1,
		"id":            id,
		"name":          "Example Add-on",
		"version":       "1.0.0",
		"compatibility": map[string]any{
			"host":     ">=2.0.0 <3.0.0",
			"addonApi": "^3.0.0",
		},
		"capabilities": map[string]any{
			"required": []string{},
			"optional": []string{},
		},
		"permissions": []any{},
	}
	body, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return body
}

func manifestWithWorkerService(t *testing.T, contract, version string) []byte {
	t.Helper()
	var manifest map[string]any
	if err := json.Unmarshal(minimalManifest("engine-addon"), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["compatibility"].(map[string]any)["workerProtocol"] = "^1.0.0"
	manifest["runtime"] = map[string]any{
		"worker": map[string]any{
			"type": "wasi", "protocol": "^1.0.0", "entrypoint": "worker/addon.wasm",
		},
	}
	manifest["services"] = map[string]any{
		"provides": []any{map[string]any{
			"contract": contract, "version": version, "transport": "worker",
			"schema": "contracts/engine.service.json",
		}},
	}
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func writePackage(t *testing.T, files map[string][]byte) string {
	t.Helper()
	copyFiles := make(map[string][]byte, len(files)+1)
	for name, body := range files {
		copyFiles[name] = append([]byte(nil), body...)
	}
	copyFiles[checksumsFilename] = checksumJSON(t, files)

	names := make([]string, 0, len(copyFiles))
	for name := range copyFiles {
		names = append(names, name)
	}
	sort.Strings(names)
	entries := make([]zipEntry, 0, len(names))
	for _, name := range names {
		entries = append(entries, zipEntry{name: name, body: copyFiles[name]})
	}
	return writeRawZip(t, entries)
}

func checksumJSON(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	digests := make(map[string]string, len(files))
	for name, body := range files {
		digest := sha256.Sum256(body)
		digests[name] = hex.EncodeToString(digest[:])
	}
	body, err := json.Marshal(map[string]any{
		"algorithm": "sha256",
		"files":     digests,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

type zipEntry struct {
	name string
	body []byte
	mode os.FileMode
}

func writeRawZip(t *testing.T, entries []zipEntry) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "addon.zip")
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
		if entry.mode != 0 {
			header.SetMode(entry.mode)
		}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(entry.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return filename
}

func assertInspectionCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("inspection succeeded, want %s", want)
	}
	var inspection *InspectionError
	if !errors.As(err, &inspection) {
		t.Fatalf("got %T %v, want InspectionError", err, err)
	}
	if inspection.Code != want {
		t.Fatalf("code = %s, want %s: %v", inspection.Code, want, err)
	}
}
