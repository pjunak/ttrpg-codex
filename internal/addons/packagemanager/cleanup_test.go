package packagemanager

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/recoverystore"
)

func cleanupScope(keep int) CleanupScope { return CleanupScope{KeepInactive: &keep} }
func mustCleanupReview(t *testing.T, m *Manager, scope CleanupScope) CleanupReview {
	t.Helper()
	r, e := m.PrepareCleanup(context.Background(), scope)
	if e != nil {
		t.Fatal(e)
	}
	return r
}

func TestCleanupRemovesOnlyReviewedInactivePackages(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	directory := filepath.Join(t.TempDir(), "addons")
	factory := &fakeRuntimeFactory{}
	m, _ := testManager(t, db, directory, factory)
	m.store.now = time.Now
	old := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	active := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "2.0.0"})
	pending, e := m.PrepareActivationReview(ctx, "example", old.GenerationID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(`INSERT INTO addon_github_sources(addon_id,source_json,revision) VALUES ('example','{"repo":"owner/repo"}',1)`); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(`INSERT INTO addon_github_generations(addon_id,generation_id,source_json,remote_id) VALUES ('example',?,'{}','old')`, old.GenerationID); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(`INSERT INTO addon_data_sets(addon_id,data_kind,data_id) VALUES ('example','collection','notes')`); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec("INSERT INTO addon_history_revisions VALUES ('example','record-extension','sheet','hero',1,'then',?,'dm','now','create','create','Saved hero',0,'{}')", old.GenerationID); e != nil {
		t.Fatal(e)
	}
	r := mustCleanupReview(t, m, cleanupScope(0))
	if r.Generations[1].HistoryRecords != 1 {
		t.Fatal("history absent from review", r)
	}
	if r.RemoveCount != 1 || r.ReclaimableBytes < 1 {
		t.Fatalf("review = %+v", r)
	}
	before := len(factory.Log())
	result, e := m.Cleanup(ctx, r.Scope, r.ReviewSHA256)
	if e != nil || !result.Complete || result.RemovedCount != 1 {
		t.Fatalf("cleanup = %+v %v", result, e)
	}
	if len(factory.Log()) != before {
		t.Fatal("cleanup restarted runtime")
	}
	if _, e = os.Stat(filepath.Join(directory, "example", "generations", old.GenerationID)); !errors.Is(e, os.ErrNotExist) {
		t.Fatalf("old files: %v", e)
	}
	if _, e = os.Stat(filepath.Join(directory, "example", "generations", active.GenerationID, "package.zip")); e != nil {
		t.Fatal(e)
	}
	if _, e = m.GetActivationReview(ctx, pending.ReviewID); !errors.Is(e, ErrReviewNotFound) {
		t.Fatalf("review survived: %v", e)
	}
	for _, table := range []string{"addon_data_sets", "addon_github_sources", "addon_history_revisions"} {
		var count int
		if e = db.QueryRow("SELECT count(*) FROM " + table + " WHERE addon_id='example'").Scan(&count); e != nil || count != 1 {
			t.Fatalf("%s lost: %d %v", table, count, e)
		}
	}
	var foreignKeyError any
	if e = db.QueryRow("PRAGMA foreign_key_check").Scan(&foreignKeyError); !errors.Is(e, sql.ErrNoRows) {
		t.Fatal("foreign key violation", e)
	}
	repeated, e := m.Cleanup(ctx, r.Scope, r.ReviewSHA256)
	if e != nil || repeated != result {
		t.Fatalf("retry = %+v %v", repeated, e)
	}
	if _, e = m.Stage(ctx, writeAddonPackage(t, packageSpec{ID: "example", Version: "1.0.0"})); e != nil {
		t.Fatal("reinstall after cleanup", e)
	}
}

func TestCleanupProtectsRecoveryAndLastInstalledPackage(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	m, _ := testManager(t, db, filepath.Join(t.TempDir(), "addons"), &fakeRuntimeFactory{})
	m.store.now = time.Now
	old := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	recovery := &recoverystore.Store{DB: db}
	if e := recovery.Create(ctx); e != nil {
		t.Fatal(e)
	}
	installUninstallFixture(t, m, packageSpec{ID: "example", Version: "2.0.0"})
	r := mustCleanupReview(t, m, CleanupScope{AddonID: "example", GenerationID: old.GenerationID})
	if r.RemoveCount != 0 || r.Generations[0].Protection != "recovery" || len(r.Generations[0].RecoveryPointIDs) != 1 {
		t.Fatalf("review %+v", r)
	}
	if _, e := m.Cleanup(ctx, r.Scope, r.ReviewSHA256); !errors.Is(e, ErrReviewBlocked) {
		t.Fatal(e)
	}
	list, e := recovery.List(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = recovery.Delete(ctx, list.Points[0].ID, list.Revision); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Cleanup(ctx, r.Scope, r.ReviewSHA256); !errors.Is(e, ErrReviewStale) {
		t.Fatal("stale recovery review", e)
	}
	r = mustCleanupReview(t, m, cleanupScope(0))
	if r.RemoveCount != 1 {
		t.Fatal(r)
	}
	state, e := m.store.state(ctx, "example")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Disable(ctx, DisablePlan{AddonID: "example", ExpectedStateRevision: state.Revision}); e != nil {
		t.Fatal(e)
	}
	r = mustCleanupReview(t, m, cleanupScope(0))
	if r.RemoveCount != 1 || r.Generations[0].Protection != "last-installed" {
		t.Fatalf("last installed: %+v", r)
	}
	uninstall, e := m.PrepareUninstall(ctx, "example")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Uninstall(ctx, "example", uninstall.ReviewSHA256); e != nil {
		t.Fatal(e)
	}
	r = mustCleanupReview(t, m, cleanupScope(0))
	if r.RemoveCount != 2 {
		t.Fatalf("uninstalled archives: %+v", r)
	}
	if _, e = m.Cleanup(ctx, r.Scope, r.ReviewSHA256); e != nil {
		t.Fatal(e)
	}
}

func TestCleanupRetentionAndStaleReview(t *testing.T) {
	ctx := context.Background()
	m, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "addons"), &fakeRuntimeFactory{})
	m.store.now = time.Now
	for _, version := range []string{"1.0.0", "2.0.0", "3.0.0"} {
		installUninstallFixture(t, m, packageSpec{ID: "example", Version: version})
	}
	r := mustCleanupReview(t, m, cleanupScope(1))
	if r.RemoveCount != 1 || r.Generations[1].Protection != "retention" {
		t.Fatalf("review %+v", r)
	}
	target := r.Generations[2]
	approval, e := m.PrepareActivationReview(ctx, target.AddonID, target.GenerationID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Cleanup(ctx, r.Scope, r.ReviewSHA256); !errors.Is(e, ErrReviewStale) {
		t.Fatal("new activation review did not invalidate", e)
	}
	r = mustCleanupReview(t, m, r.Scope)
	if _, e = m.ApproveActivationReview(ctx, approval.ReviewID, []string{}); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Cleanup(ctx, r.Scope, r.ReviewSHA256); !errors.Is(e, ErrReviewStale) {
		t.Fatal("approval did not invalidate", e)
	}
	r = mustCleanupReview(t, m, r.Scope)
	if e = os.WriteFile(filepath.Join(m.directory, target.AddonID, "generations", target.GenerationID, "unexpected"), []byte("changed"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Cleanup(ctx, r.Scope, r.ReviewSHA256); !errors.Is(e, ErrReviewStale) {
		t.Fatal("file change did not invalidate", e)
	}
	for _, scope := range []CleanupScope{{}, cleanupScope(-1), cleanupScope(6), {AddonID: "../outside", KeepInactive: new(int)}, {GenerationID: strings.Repeat("a", 64)}} {
		if _, e = m.PrepareCleanup(ctx, scope); !errors.Is(e, ErrInvalidPackage) {
			t.Fatalf("scope %+v: %v", scope, e)
		}
	}
}

// Simulate loss of the process after the metadata transaction but before files
// are removed. Startup must resume only that durable approved receipt.
func TestCleanupResumesAfterInterruptionAndRejectsResurrectedMetadata(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	directory := filepath.Join(t.TempDir(), "addons")
	m, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	m.store.now = time.Now
	old := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	installUninstallFixture(t, m, packageSpec{ID: "example", Version: "2.0.0"})
	r := mustCleanupReview(t, m, cleanupScope(0))
	body, _ := json.Marshal(r)
	if _, e := db.Exec(`INSERT INTO addon_package_cleanups VALUES (?,?,'pending','now',NULL)`, r.ReviewSHA256, string(body)); e != nil {
		t.Fatal(e)
	}
	if _, e := m.RetryCleanups(ctx); !errors.Is(e, ErrCleanupPending) {
		t.Fatal("live metadata not protected", e)
	}
	if _, e := m.Stage(ctx, writeAddonPackage(t, packageSpec{ID: "example", Version: "1.0.0"})); !errors.Is(e, ErrCleanupPending) {
		t.Fatal("restaging pending package", e)
	}
	if _, e := db.Exec(`DELETE FROM addon_package_generations WHERE addon_id='example' AND generation_id=?`, old.GenerationID); e != nil {
		t.Fatal(e)
	}
	// A filesystem failure leaves the approved receipt pending for an explicit retry.
	path := filepath.Join(directory, "example", "generations", old.GenerationID)
	if e := os.Rename(path, path+"-held"); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, []byte("temporarily blocked"), 0600); e != nil {
		t.Fatal(e)
	}
	pending, e := m.RetryCleanups(ctx)
	if e != nil || pending.Complete || pending.PendingCleanups != 1 {
		t.Fatalf("pending: %+v %v", pending, e)
	}
	if e := os.Remove(path); e != nil {
		t.Fatal(e)
	}
	if e := os.Rename(path+"-held", path); e != nil {
		t.Fatal(e)
	}
	next, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	if _, e := next.Recover(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(directory, "example", "generations", old.GenerationID)); !errors.Is(e, os.ErrNotExist) {
		t.Fatal(e)
	}
	result, e := next.Cleanup(ctx, r.Scope, r.ReviewSHA256)
	if e != nil || !result.Complete {
		t.Fatalf("receipt %+v %v", result, e)
	}
	corrupt := r
	corrupt.Generations = append([]CleanupGeneration{}, r.Generations...)
	corrupt.Generations[1].GenerationID = strings.Repeat("b", 64)
	if e = validateCleanupReceipt(corrupt, r.ReviewSHA256); !errors.Is(e, ErrInvalidPackage) {
		t.Fatal("tampered receipt accepted", e)
	}
}

func TestCleanupBackupSnapshotIsSerializedAndSelfContained(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	data := t.TempDir()
	m, _ := testManager(t, db, filepath.Join(data, "addons"), &fakeRuntimeFactory{})
	m.store.now = time.Now
	old := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	installUninstallFixture(t, m, packageSpec{ID: "example", Version: "2.0.0"})
	r := mustCleanupReview(t, m, cleanupScope(0))
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	creator := &backuparchive.Creator{Database: db, DataDirectory: data, HostVersion: "test", PackageSnapshot: func(ctx context.Context, f func() error) error {
		return m.WithPackageSnapshot(ctx, func() error { close(entered); <-release; return f() })
	}}
	archive := filepath.Join(t.TempDir(), "backup.zip")
	go func() { _, e := creator.Create(ctx, archive); done <- e }()
	<-entered
	if m.mu.TryLock() {
		m.mu.Unlock()
		t.Fatal("backup did not hold lifecycle lock")
	}
	close(release)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	if _, e := m.Cleanup(ctx, r.Scope, r.ReviewSHA256); e != nil {
		t.Fatal(e)
	}
	verified, e := backuparchive.Verify(ctx, backuparchive.VerifyConfig{ArchivePath: archive, Migrations: migrations.FS})
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, file := range verified.Manifest.Entries {
		if file.Path == "addons/example/generations/"+old.GenerationID+"/package.zip" {
			found = true
		}
	}
	if !found {
		t.Fatal("backup lost old package")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	ran := false
	if e = m.WithPackageSnapshot(canceled, func() error { ran = true; return nil }); !errors.Is(e, context.Canceled) || ran {
		t.Fatal("canceled backup ran", e)
	}
}

func TestCleanupRejectsSymlinkDirectory(t *testing.T) {
	m, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "addons"), &fakeRuntimeFactory{})
	m.store.now = time.Now
	outside := t.TempDir()
	id := strings.Repeat("a", 64)
	if e := os.MkdirAll(filepath.Join(m.directory, "example"), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.Symlink(outside, filepath.Join(m.directory, "example", "generations")); e != nil {
		t.Skipf("symlink unavailable: %v", e)
	}
	sentinel := filepath.Join(outside, id)
	if e := os.Mkdir(sentinel, 0700); e != nil {
		t.Fatal(e)
	}
	if e := m.removeCleanupGeneration("example", id); !errors.Is(e, ErrInvalidPackage) {
		t.Fatal(e)
	}
	if _, e := os.Stat(sentinel); e != nil {
		t.Fatal("escaped root", e)
	}
}

func TestCleanupRollsBackMetadataFailureBeforeRemovingFiles(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	m, _ := testManager(t, db, filepath.Join(t.TempDir(), "addons"), &fakeRuntimeFactory{})
	m.store.now = time.Now
	old := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	installUninstallFixture(t, m, packageSpec{ID: "example", Version: "2.0.0"})
	r := mustCleanupReview(t, m, cleanupScope(0))
	if _, e := db.Exec("CREATE TRIGGER cleanup_fail BEFORE DELETE ON addon_package_generations BEGIN SELECT RAISE(ABORT,'injected failure'); END"); e != nil {
		t.Fatal(e)
	}
	if _, e := m.Cleanup(ctx, r.Scope, r.ReviewSHA256); e == nil {
		t.Fatal("metadata failure ignored")
	}
	if _, e := os.Stat(filepath.Join(m.directory, "example", "generations", old.GenerationID, "package.zip")); e != nil {
		t.Fatal(e)
	}
	var count int
	if e := db.QueryRow("SELECT count(*) FROM addon_package_cleanups").Scan(&count); e != nil || count != 0 {
		t.Fatal("partial receipt", count, e)
	}
	if after := mustCleanupReview(t, m, r.Scope); after.ReviewSHA256 != r.ReviewSHA256 {
		t.Fatal("failed cleanup changed metadata")
	}
}

func TestCleanupCanNarrowAnOversizedInventoryToOneGeneration(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	m, _ := testManager(t, db, filepath.Join(t.TempDir(), "addons"), &fakeRuntimeFactory{})
	installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	if _, e := db.Exec(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<512)
 INSERT INTO addon_package_generations(addon_id,generation_id,addon_version,archive_sha256,manifest_json,installed_at)
 SELECT 'example',printf('%064x',n),'1.0.0',printf('%064x',n),'{}','before' FROM numbers`); e != nil {
		t.Fatal(e)
	}
	if _, e := m.PrepareCleanup(ctx, cleanupScope(0)); !errors.Is(e, ErrInvalidPackage) {
		t.Fatal("unbounded inventory accepted", e)
	}
	r := mustCleanupReview(t, m, CleanupScope{AddonID: "example", GenerationID: strings.Repeat("0", 63) + "1"})
	if r.RemoveCount != 1 || r.ReclaimableBytes != 0 {
		t.Fatal(r)
	}
	if result, e := m.Cleanup(ctx, r.Scope, r.ReviewSHA256); e != nil || !result.Complete {
		t.Fatalf("narrow cleanup: %+v %v", result, e)
	}
}
