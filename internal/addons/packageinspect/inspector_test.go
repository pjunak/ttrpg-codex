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
