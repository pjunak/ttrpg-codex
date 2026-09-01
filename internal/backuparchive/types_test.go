package backuparchive

import "testing"

func TestArchivePathsAreRestrictedToOwnedDurableRoots(t *testing.T) {
	t.Parallel()
	for _, valid := range []string{
		"codex.db",
		"addons/example/generations/abcdef/package.zip",
		"blobs/sha256/ab/abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
	} {
		if !validArchivePath(valid) {
			t.Errorf("valid path rejected: %q", valid)
		}
	}
	for _, invalid := range []string{
		"", "manifest.json", "codex.db-wal", "/codex.db", "../codex.db",
		"addons/../codex.db", `addons\example\file`, "addons//file",
		"blobs/unowned", "blobs/sha256/ab/not-a-hash",
		"blobs/sha256/cd/abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
	} {
		if validArchivePath(invalid) {
			t.Errorf("unsafe path accepted: %q", invalid)
		}
	}
}
