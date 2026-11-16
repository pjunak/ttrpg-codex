package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRequiresExactlyOnePackage(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run(context.Background(), nil, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "usage:") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRunFailsOnMessageCatalogIssues(t *testing.T) {
	t.Parallel()

	manifest := `{"packageFormat":1,"id":"example-addon","name":"Example","version":"1.0.0",
		"compatibility":{"host":">=2.0.0 <3.0.0","addonApi":"^3.0.0"},
		"capabilities":{"required":[],"optional":[]},"permissions":[],
		"locales":{"en":"locales/en.json"}}`
	for _, test := range []struct {
		name    string
		catalog string
		code    int
	}{
		{name: "valid", catalog: `{"contractVersion":"message-catalog.v1","locale":"en","sections":{"main":{"main.title":"Example"}}}`},
		{name: "flat legacy", catalog: `{"main.title":"Example"}`, code: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			archive := writeTestPackage(t, map[string]string{"addon.json": manifest, "locales/en.json": test.catalog})
			var stdout, stderr bytes.Buffer
			if code := run(context.Background(), []string{"-compact", archive}, &stdout, &stderr); code != test.code {
				t.Fatalf("exit code = %d, want %d (stderr %q)", code, test.code, stderr.String())
			}
			if test.code == 0 {
				if !strings.Contains(stdout.String(), `"ok":true`) || stderr.Len() != 0 {
					t.Fatalf("stdout %q, stderr %q", stdout.String(), stderr.String())
				}
				return
			}
			if !strings.Contains(stdout.String(), `"ok":false`) ||
				!strings.Contains(stderr.String(), "en: not a message-catalog.v1 file") {
				t.Fatalf("stdout %q, stderr %q", stdout.String(), stderr.String())
			}
		})
	}
}

func writeTestPackage(t *testing.T, files map[string]string) string {
	t.Helper()
	digests := map[string]string{}
	for name, body := range files {
		digest := sha256.Sum256([]byte(body))
		digests[name] = hex.EncodeToString(digest[:])
	}
	checksums, err := json.Marshal(map[string]any{"algorithm": "sha256", "files": digests})
	if err != nil {
		t.Fatal(err)
	}
	files["checksums.json"] = string(checksums)
	path := filepath.Join(t.TempDir(), "package.zip")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for name, body := range files {
		entry, err := writer.Create(name)
		if err == nil {
			_, err = entry.Write([]byte(body))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunBuildsAndInspectsLanguagePacks(t *testing.T) {
	t.Parallel()
	manifest := `{"packageFormat":1,"id":"example-addon","name":"Example","version":"1.2.0",
		"compatibility":{"host":">=2.0.0 <3.0.0","addonApi":"^3.0.0"},
		"capabilities":{"required":[],"optional":[]},"permissions":[],
		"locales":{"en":"locales/en.json"}}`
	archive := writeTestPackage(t, map[string]string{"addon.json": manifest,
		"locales/en.json": `{"contractVersion":"message-catalog.v1","locale":"en","sections":{"main":{"main.title":"Example","main.count":"{n} items"}}}`})
	renamed := filepath.Join(filepath.Dir(archive), "example-addon-1.2.0.zip")
	if err := os.Rename(archive, renamed); err != nil {
		t.Fatal(err)
	}
	source := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(source, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(source, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("de/messages.json", `{"contractVersion":"message-catalog.v1","locale":"de","sections":{"main":{"main.title":"Beispiel"}}}`)
	write("de/content/i18n/de.json", `{"id":"de","kind":"i18n","name":"Deutsch","entries":{}}`)
	output := filepath.Join(t.TempDir(), "packs")

	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), []string{"-compact", "-build-packs", source, "-out", output, renamed}, &stdout, &stderr); code != 0 {
		t.Fatalf("build exit %d: %s %s", code, stdout.String(), stderr.String())
	}
	pack := filepath.Join(output, "example-addon-1.2.0.de.langpack.zip")
	if !strings.Contains(stdout.String(), `"file":"example-addon-1.2.0.de.langpack.zip"`) ||
		!strings.Contains(stdout.String(), `"addonVersions":">=1.2.0 <2.0.0"`) ||
		!strings.Contains(stdout.String(), `"source":"pack"`) {
		t.Fatalf("build output %s", stdout.String())
	}
	stdout.Reset()
	if code := run(context.Background(), []string{"-compact", "-pack", pack}, &stdout, &stderr); code != 0 ||
		!strings.Contains(stdout.String(), `"content":["content/i18n/de.json"]`) {
		t.Fatalf("inspect exit %d: %s %s", code, stdout.String(), stderr.String())
	}

	// A message that breaks the package's English fails the build.
	write("de/messages.json", `{"contractVersion":"message-catalog.v1","locale":"de","sections":{"main":{"main.count":"{count} Dinge"}}}`)
	stdout.Reset()
	stderr.Reset()
	if code := run(context.Background(), []string{"-compact", "-build-packs", source, "-out", output, renamed}, &stdout, &stderr); code != 1 ||
		!strings.Contains(stderr.String(), "de: language pack: main.count: placeholders differ") {
		t.Fatalf("broken pack exit %d: %s", code, stderr.String())
	}
	// Anything but language directories is refused.
	write("notes.txt", "x")
	if code := run(context.Background(), []string{"-build-packs", source, "-out", output, renamed}, &stdout, &stderr); code != 1 {
		t.Fatalf("stray file exit %d", code)
	}
	if code := run(context.Background(), []string{"-build-packs", source, renamed}, &stdout, &stderr); code != 2 {
		t.Fatalf("missing -out exit %d", code)
	}
}
