package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
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
	if err := run(context.Background(), []string{
		"-in", archivePath, "-out", output,
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
	if report.ContractVersion != "codex-v1-conversion-report.v1" || report.CoreRecords != 1 {
		t.Fatalf("report = %+v", report)
	}
	if _, err := os.Stat(filepath.Join(output, "codex.db")); err != nil {
		t.Fatal(err)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %s", stderr.String())
	}
}

func TestRunRequiresBothPaths(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"-in", "backup.zip"}, &stdout, &stderr); err == nil {
		t.Fatal("run accepted missing output")
	}
}
