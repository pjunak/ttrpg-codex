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
