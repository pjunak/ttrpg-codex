package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestFormattingGateDiscoversAndRejectsNewGoFile(t *testing.T) {
	probe := ".check-unformatted-probe.go"
	if err := os.WriteFile(probe, []byte("package main\nfunc probe( ){}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(probe) })

	files := goFiles()
	if !hasFile(files, probe) {
		t.Fatalf("new nonignored Go file was not discovered: %v", files)
	}
	if !hasFile(files, "check.go") {
		t.Fatalf("runner Go file was not discovered: %v", files)
	}

	unformatted, err := unformattedFiles(files)
	if err != nil {
		t.Fatal(err)
	}
	if !hasFile(unformatted, probe) {
		t.Fatalf("unformatted new Go file passed the formatting gate: %v", unformatted)
	}
}

func TestFormattingGateIgnoresDeletedTrackedGoFile(t *testing.T) {
	t.Chdir(t.TempDir())
	if output, err := exec.Command("git", "init", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("initialize isolated fixture: %v: %s", err, output)
	}
	const path = "removed.go"
	if err := os.WriteFile(path, []byte("package main\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("git", "add", "--", path).CombinedOutput(); err != nil {
		t.Fatalf("track fixture: %v: %s", err, output)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if files := goFiles(); len(files) != 0 {
		t.Fatalf("deleted tracked file reached formatter: %v", files)
	}
}

func hasFile(files []string, name string) bool {
	for _, file := range files {
		if filepath.Base(filepath.FromSlash(file)) == name {
			return true
		}
	}
	return false
}
