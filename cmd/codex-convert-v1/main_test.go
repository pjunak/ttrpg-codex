package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/legacyconvert"
)

func TestRunConvertsOldUIBackupAndPrintsReport(t *testing.T) {
	directory := t.TempDir()
	archivePath := filepath.Join(directory, "backup.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	entry, err := archive.Create("data/characters.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte(`[{"id":"hero","name":"Hero"}]`)); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	output := filepath.Join(directory, "rewrite-data")
	reportPath := filepath.Join(directory, "reports", "conversion.json")
	if err := run(context.Background(), []string{
		"-in", archivePath, "-out", output, "-report", reportPath,
	}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	var report struct {
		ContractVersion string `json:"contractVersion"`
		CoreRecords     int    `json:"coreRecords"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.ContractVersion != "codex-v1-conversion-report.v3" || report.CoreRecords != 1 {
		t.Fatalf("report = %+v", report)
	}
	reportFile, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	var persistedReport struct {
		ContractVersion string `json:"contractVersion"`
		CoreRecords     int    `json:"coreRecords"`
	}
	if err := json.Unmarshal(reportFile, &persistedReport); err != nil {
		t.Fatal(err)
	}
	if persistedReport != report {
		t.Fatalf("persisted report = %+v, stdout report = %+v", persistedReport, report)
	}
	if _, err := os.Stat(filepath.Join(output, "codex.db")); err != nil {
		t.Fatal(err)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func TestWriteReportDoesNotOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conversion.json")
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeReport(path, legacyconvert.Report{}); err == nil {
		t.Fatal("writeReport overwrote an existing report")
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "keep" {
		t.Fatalf("existing report changed to %q", contents)
	}
}

func TestRunRejectsExistingReportBeforeConversion(t *testing.T) {
	directory := t.TempDir()
	reportPath := filepath.Join(directory, "conversion.json")
	if err := os.WriteFile(reportPath, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "rewrite-data")
	var stdout, stderr bytes.Buffer
	err := run(context.Background(), []string{
		"-in", filepath.Join(directory, "unused.zip"),
		"-out", output,
		"-report", reportPath,
	}, &stdout, &stderr)
	if err == nil {
		t.Fatal("run accepted an existing report path")
	}
	if _, statErr := os.Stat(output); !os.IsNotExist(statErr) {
		t.Fatalf("conversion output exists after report preflight: %v", statErr)
	}
}

func TestRunRequiresBothPaths(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"-in", "backup.zip"}, &stdout, &stderr); err == nil {
		t.Fatal("run accepted missing output")
	}
}
