package main

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/maintenance/processlock"
)

func TestRestoreRefusesWhileHostOwnsDataDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "data")
	lock, err := processlock.AcquireHost(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	err = runRestore(context.Background(), []string{
		"-data-dir", directory, "-in", filepath.Join(t.TempDir(), "backup.zip"),
	}, &bytes.Buffer{}, &bytes.Buffer{})
	if !errors.Is(err, processlock.ErrAlreadyLocked) {
		t.Fatalf("restore error = %v", err)
	}
}
