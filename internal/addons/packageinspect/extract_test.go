package packageinspect

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestInspectAndExtractFilePublishesVerifiedRegularFiles(t *testing.T) {
	t.Parallel()

	archive := writePackage(t, map[string][]byte{
		manifestFilename: minimalManifest("example-addon"),
		"web/index.js":   []byte("export const ready = true;\n"),
	})
	destination := filepath.Join(t.TempDir(), "root")
	report, err := newTestInspector(t).InspectAndExtractFile(context.Background(), archive, destination)
	if err != nil {
		t.Fatal(err)
	}
	if report.Manifest.ID != "example-addon" {
		t.Fatalf("manifest = %+v", report.Manifest)
	}
	body, err := os.ReadFile(filepath.Join(destination, "web", "index.js"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "export const ready = true;\n" {
		t.Fatalf("extracted body = %q", body)
	}
	if _, err := os.Stat(filepath.Join(destination, checksumsFilename)); err != nil {
		t.Fatalf("checksum inventory was not extracted: %v", err)
	}
}

func TestInspectAndExtractFileRequiresNewDestination(t *testing.T) {
	t.Parallel()

	archive := writePackage(t, map[string][]byte{manifestFilename: minimalManifest("example-addon")})
	destination := t.TempDir()
	_, err := newTestInspector(t).InspectAndExtractFile(context.Background(), archive, destination)
	var inspection *InspectionError
	if !errors.As(err, &inspection) || inspection.Code != CodeExtractionFailed {
		t.Fatalf("existing destination error = %v", err)
	}
}

func TestVerifyExtractedRejectsGenerationMutation(t *testing.T) {
	t.Parallel()

	archive := writePackage(t, map[string][]byte{
		manifestFilename: minimalManifest("example-addon"),
		"web/index.js":   []byte("export const ready = true;\n"),
	})
	destination := filepath.Join(t.TempDir(), "root")
	inspector := newTestInspector(t)
	report, err := inspector.InspectAndExtractFile(context.Background(), archive, destination)
	if err != nil {
		t.Fatal(err)
	}
	if err := inspector.VerifyExtracted(context.Background(), destination, report); err != nil {
		t.Fatalf("verify fresh extraction: %v", err)
	}
	if err := os.WriteFile(filepath.Join(destination, "web", "index.js"), []byte("mutated\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := inspector.VerifyExtracted(context.Background(), destination, report); err == nil {
		t.Fatal("mutated generation passed verification")
	}
}

func TestVerifyExtractedRejectsUnexpectedFile(t *testing.T) {
	t.Parallel()

	archive := writePackage(t, map[string][]byte{manifestFilename: minimalManifest("example-addon")})
	destination := filepath.Join(t.TempDir(), "root")
	inspector := newTestInspector(t)
	report, err := inspector.InspectAndExtractFile(context.Background(), archive, destination)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(destination, "injected.js"), []byte("unsafe\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := inspector.VerifyExtracted(context.Background(), destination, report); err == nil {
		t.Fatal("generation with unexpected file passed verification")
	}
}
