package packagemanager

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/recoverystore"
)

func TestAutomaticPackageFilesPreserveRecoveryAndRestoreExactReviewedBuild(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	directory := filepath.Join(t.TempDir(), "addons")
	manager, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	archives := map[string][]byte{}
	fetch := func(ctx context.Context, ref PackageReference, destination string) error {
		if body, ok := archives[ref.GenerationID]; ok {
			return os.WriteFile(destination, body, 0o600)
		}
		return ErrPackageUnavailable
	}
	if err := manager.ConfigurePackageRetention(ctx, true, fetch); err != nil {
		t.Fatal(err)
	}
	old := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "1.0.0"})
	bytes, err := os.ReadFile(filepath.Join(directory, "example", "generations", old.GenerationID, "package.zip"))
	if err != nil {
		t.Fatal(err)
	}
	archives[old.GenerationID] = bytes
	if _, err = db.Exec(`INSERT INTO addon_github_generations(addon_id,generation_id,source_json,remote_id) VALUES('example',?,'{"channel":"release","repo":"owner/repo"}','original')`, old.GenerationID); err != nil {
		t.Fatal(err)
	}
	recovery := &recoverystore.Store{DB: db}
	if err = recovery.Create(ctx); err != nil {
		t.Fatal(err)
	}
	points, err := recovery.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	current := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "2.0.0"})
	if _, err = os.Stat(filepath.Join(directory, "example", "generations", old.GenerationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("superseded files remain: %v", err)
	}
	if _, err = os.Stat(filepath.Join(directory, "example", "generations", current.GenerationID, "package.zip")); err != nil {
		t.Fatal("current ZIP removed", err)
	}
	snapshot, err := manager.Snapshot(ctx, "example", 10)
	if err != nil || len(snapshot.Generations) != 1 {
		t.Fatalf("local inventory: %+v %v", snapshot, err)
	}
	points, err = recovery.List(ctx)
	if err != nil || len(points.Points) != 1 {
		t.Fatalf("recovery lost: %+v %v", points, err)
	}
	storage, err := manager.PackageStorage(ctx, points.Points[0].ID, points.Revision)
	if err != nil || len(storage.Packages) != 1 || storage.Packages[0].Available || !storage.Packages[0].Downloadable {
		t.Fatalf("required packages: %+v %v", storage, err)
	}
	storage, err = manager.PrepareRecoveryPackages(ctx, points.Points[0].ID, points.Revision)
	if err != nil || !storage.Packages[0].Available || storage.Packages[0].Active {
		t.Fatalf("prepared packages: %+v %v", storage, err)
	}
	snapshot, _ = manager.Snapshot(ctx, "example", 10)
	if snapshot.State.ActiveGenerationID != current.GenerationID {
		t.Fatal("download activated a package")
	}
	review, err := manager.PrepareActivationReview(ctx, "example", old.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.ApproveActivationReview(ctx, review.ReviewID, []string{}); err != nil {
		t.Fatal(err)
	}
	if _, err = manager.ActivateReviewed(ctx, review.ReviewID); err != nil {
		t.Fatal(err)
	}
	snapshot, _ = manager.Snapshot(ctx, "example", 10)
	if snapshot.State.ActiveGenerationID != old.GenerationID || len(snapshot.Generations) != 1 {
		t.Fatal("reviewed rollback or subsequent cleanup failed", snapshot)
	}
}

func TestAutomaticPackageBackupMaterializesOnlySnapshotAndRejectsMissingBytes(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	root := t.TempDir()
	directory := filepath.Join(root, "addons")
	manager, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	old := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "1.0.0"})
	body, err := os.ReadFile(filepath.Join(directory, "example", "generations", old.GenerationID, "package.zip"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO addon_github_generations(addon_id,generation_id,source_json,remote_id) VALUES('example',?,'{"channel":"release","repo":"owner/repo"}','old')`, old.GenerationID); err != nil {
		t.Fatal(err)
	}
	recovery := &recoverystore.Store{DB: db}
	if err = recovery.Create(ctx); err != nil {
		t.Fatal(err)
	}
	fetch := func(ctx context.Context, ref PackageReference, destination string) error {
		return os.WriteFile(destination, body, 0o600)
	}
	if err = manager.ConfigurePackageRetention(ctx, true, fetch); err != nil {
		t.Fatal(err)
	}
	installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "2.0.0"})
	out := filepath.Join(t.TempDir(), "backup.zip")
	creator := &backuparchive.Creator{Database: db, DataDirectory: root, HostVersion: "test", PackageSnapshot: manager.WithPackageSnapshot}
	if _, err = creator.Create(ctx, out); err == nil {
		t.Fatal("incomplete backup was published")
	}
	if _, err = os.Stat(out); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed backup left output", err)
	}
	creator.MaterializePackages = func(ctx context.Context, databasePath, stage string) error {
		return MaterializePackageBackup(ctx, databasePath, directory, stage, manager.inspector, fetch)
	}
	if _, err = creator.Create(ctx, out); err != nil {
		t.Fatal(err)
	}
	if _, err = backuparchive.Verify(ctx, backuparchive.VerifyConfig{ArchivePath: out, Migrations: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(directory, "example", "generations", old.GenerationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("backup changed live files", err)
	}
	restoredRoot := filepath.Join(t.TempDir(), "restored")
	if _, err = backuparchive.Restore(ctx, backuparchive.RestoreConfig{ArchivePath: out, DataDirectory: restoredRoot, Migrations: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	restoredDB, err := sqlite.Open(ctx, filepath.Join(restoredRoot, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restoredDB.Close() })
	restoredManager, _ := testManager(t, restoredDB, filepath.Join(restoredRoot, "addons"), &fakeRuntimeFactory{})
	if _, err = restoredManager.Recover(ctx); err != nil {
		t.Fatal("offline recovery failed", err)
	}
	if err = restoredManager.ConfigurePackageRetention(ctx, true, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = restoredManager.loadPackage(ctx, "example", old.GenerationID); err != nil {
		t.Fatal("startup evicted backup recovery files", err)
	}
	var state string
	if err = db.QueryRow(`SELECT status FROM addon_package_files WHERE addon_id='example' AND generation_id=?`, old.GenerationID).Scan(&state); err != nil || state != "remote" {
		t.Fatalf("backup changed live state: %q %v", state, err)
	}
}

func TestAutomaticPackageFilesRejectWrongDownloadAndResumeInterruptedRemoval(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	directory := filepath.Join(t.TempDir(), "addons")
	manager, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	old := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "1.0.0"})
	current := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "2.0.0"})
	wrong, err := os.ReadFile(filepath.Join(directory, "example", "generations", current.GenerationID, "package.zip"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO addon_github_generations(addon_id,generation_id,source_json,remote_id) VALUES('example',?,'{"channel":"release","repo":"owner/repo"}','old')`, old.GenerationID); err != nil {
		t.Fatal(err)
	}
	fetch := func(ctx context.Context, ref PackageReference, destination string) error {
		return os.WriteFile(destination, wrong, 0o600)
	}
	if err = manager.ConfigurePackageRetention(ctx, true, fetch); err != nil {
		t.Fatal(err)
	}
	if _, err = manager.RestorePackage(ctx, "example", old.GenerationID); !errors.Is(err, ErrInvalidPackage) {
		t.Fatalf("wrong bytes: %v", err)
	}
	if _, err = os.Stat(filepath.Join(directory, "example", "generations", old.GenerationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("wrong package published", err)
	}
	if _, err = db.Exec(`UPDATE addon_package_files SET status='pending' WHERE addon_id='example' AND generation_id=?`, old.GenerationID); err != nil {
		t.Fatal(err)
	}
	if err = manager.RetryPackageEvictions(ctx); err != nil {
		t.Fatal("missing files should complete pending eviction", err)
	}
	if _, err = db.Exec(`INSERT INTO addon_package_files VALUES('example',?,'pending','now')`, current.GenerationID); err != nil {
		t.Fatal(err)
	}
	if err = manager.RetryPackageEvictions(ctx); !errors.Is(err, ErrCleanupPending) {
		t.Fatal("active generation was not protected", err)
	}
	if _, err = os.Stat(filepath.Join(directory, "example", "generations", current.GenerationID, "package.zip")); err != nil {
		t.Fatal("active ZIP removed", err)
	}
}

func TestAutomaticRetentionPreservesOfflineRecoveryCopyAndDisabledBuild(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	manager, _ := testManager(t, db, dir, &fakeRuntimeFactory{})
	old := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "1.0.0"})
	recovery := &recoverystore.Store{DB: db}
	if err := recovery.Create(ctx); err != nil {
		t.Fatal(err)
	}
	current := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "2.0.0"})
	snap, _ := manager.Snapshot(ctx, "example", 1)
	if _, err := manager.Disable(ctx, DisablePlan{AddonID: "example", ExpectedStateRevision: snap.State.Revision}); err != nil {
		t.Fatal(err)
	}
	if err := manager.ConfigurePackageRetention(ctx, true, nil); err != nil {
		t.Fatal(err)
	}
	for _, g := range []Generation{old, current} {
		if _, err := os.Stat(filepath.Join(dir, "example", "generations", g.GenerationID, "package.zip")); err != nil {
			t.Fatal("required offline copy lost", err)
		}
	}
	storage, err := manager.PackageStorage(ctx, 0, 0)
	if err != nil || len(storage.Packages) != 1 || !storage.Packages[0].Available || storage.Packages[0].Downloadable {
		t.Fatalf("retained reason: %+v %v", storage, err)
	}
	// Once the recovery point is deliberately removed, the next healthy update
	// can remove the formerly protected ZIP without touching campaign data.
	points, _ := recovery.List(ctx)
	if _, err = db.Exec("DELETE FROM recovery_points WHERE point_id=?", points.Points[0].ID); err != nil {
		t.Fatal(err)
	}
	installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "3.0.0"})
	if _, err = os.Stat(filepath.Join(dir, "example", "generations", old.GenerationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unreferenced files remain", err)
	}
}

func TestAutomaticRetentionLeavesFailedAndCancelledUpdatesUntouched(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	factory := &fakeRuntimeFactory{failVersions: map[string]error{"2.0.0": errors.New("failed startup")}}
	manager, _ := testManager(t, db, dir, factory)
	if err := manager.ConfigurePackageRetention(ctx, true, nil); err != nil {
		t.Fatal(err)
	}
	old := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: "engine-addon", GenerationID: old.GenerationID, GrantedPermissionIDs: []string{"core.data.read"}}); err != nil {
		t.Fatal(err)
	}
	target := stageServicePackage(t, manager, "engine-addon", "2.0.0", "3.2.0")
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: "engine-addon", GenerationID: target.GenerationID, ExpectedStateRevision: 1, GrantedPermissionIDs: []string{"core.data.read"}}); !errors.Is(err, ErrActivationFailed) {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := manager.StageArchive(cancelled, strings.NewReader("cancelled")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	snap, err := manager.Snapshot(ctx, "engine-addon", 10)
	if err != nil || snap.State.ActiveGenerationID != old.GenerationID || len(snap.Generations) != 2 {
		t.Fatalf("failed update altered installation: %+v %v", snap, err)
	}
	for _, g := range []Generation{old, target} {
		if _, err := os.Stat(filepath.Join(dir, "engine-addon", "generations", g.GenerationID, "package.zip")); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInitialRetentionPreservesPendingReviewAndRepairsPublishedResidency(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	manager, _ := testManager(t, db, dir, &fakeRuntimeFactory{})
	old := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "1.0.0"})
	installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "2.0.0"})
	review, err := manager.PrepareActivationReview(ctx, "example", old.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if err = manager.ConfigurePackageRetention(ctx, true, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = manager.ApproveActivationReview(ctx, review.ReviewID, []string{}); err != nil {
		t.Fatal("startup invalidated prepared review", err)
	}
	if _, err = db.Exec("INSERT INTO addon_package_files VALUES('example',?,'remote','now')", old.GenerationID); err != nil {
		t.Fatal(err)
	}
	// Simulate publication completing just before a crash; no fetcher is configured.
	if _, err = manager.RestorePackage(ctx, "example", old.GenerationID); err != nil {
		t.Fatal("verified files were not recovered offline", err)
	}
	var status string
	if err = db.QueryRow("SELECT status FROM addon_package_files WHERE addon_id='example' AND generation_id=?", old.GenerationID).Scan(&status); err != nil || status != "local" {
		t.Fatal(status, err)
	}
}

func TestPreparationCanRestageAnUninstalledRecoveryPackage(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	manager, _ := testManager(t, db, dir, &fakeRuntimeFactory{})
	old := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "1.0.0"})
	recovery := &recoverystore.Store{DB: db}
	if err := recovery.Create(ctx); err != nil {
		t.Fatal(err)
	}
	review, err := manager.PrepareUninstall(ctx, "example")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Uninstall(ctx, "example", review.ReviewSHA256); err != nil {
		t.Fatal(err)
	}
	points, err := recovery.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	storage, err := manager.PackageStorage(ctx, points.Points[0].ID, points.Revision)
	if err != nil || len(storage.Packages) != 1 || storage.Packages[0].Available || !storage.Packages[0].Downloadable {
		t.Fatalf("reinstall preparation: %+v %v", storage, err)
	}
	// Reinstating package registration changes the installation revision. Require
	// a fresh recovery review, and never start its runtime during preparation.
	if _, err = manager.PrepareRecoveryPackages(ctx, points.Points[0].ID, points.Revision); !errors.Is(err, ErrReviewStale) {
		t.Fatal(err)
	}
	snap, err := manager.Snapshot(ctx, "example", 1)
	if err != nil || snap.State.ActiveGenerationID != "" || len(snap.Generations) != 1 || snap.Generations[0].GenerationID != old.GenerationID {
		t.Fatal(snap, err)
	}
}

func TestAutomaticCleanupWaitsForPackageSnapshot(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	manager, _ := testManager(t, db, dir, &fakeRuntimeFactory{})
	if err := manager.ConfigurePackageRetention(ctx, true, nil); err != nil {
		t.Fatal(err)
	}
	old := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "1.0.0"})
	next, err := manager.Stage(ctx, writeAddonPackage(t, packageSpec{ID: "example", Version: "2.0.0"}))
	if err != nil {
		t.Fatal(err)
	}
	entered, release, snapshotDone := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		snapshotDone <- manager.WithPackageSnapshot(ctx, func() error {
			close(entered)
			<-release
			_, err := manager.loadPackage(ctx, "example", old.GenerationID)
			return err
		})
	}()
	<-entered
	if manager.mu.TryLock() {
		manager.mu.Unlock()
		close(release)
		t.Fatal("snapshot does not hold lifecycle lock")
	}
	activationDone := make(chan error, 1)
	go func() {
		_, err := manager.Activate(ctx, ActivationPlan{AddonID: "example", GenerationID: next.GenerationID, ExpectedStateRevision: 1})
		activationDone <- err
	}()
	close(release)
	if err := <-snapshotDone; err != nil {
		t.Fatal("snapshot lost old files", err)
	}
	if err := <-activationDone; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "example", "generations", old.GenerationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("post-snapshot cleanup did not finish", err)
	}
}

func TestAutomaticRetentionPreservesRecoveryArtifactsUntilReleaseIsRecorded(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	manager, _ := testManager(t, db, dir, &fakeRuntimeFactory{})
	old := installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "1.0.0"})
	if _, err := db.Exec(`INSERT INTO addon_github_generations(addon_id,generation_id,source_json,remote_id) VALUES('example',?,'{"channel":"actions","repo":"owner/repo","artifact":"package"}','artifact')`, old.GenerationID); err != nil {
		t.Fatal(err)
	}
	recovery := &recoverystore.Store{DB: db}
	if err := recovery.Create(ctx); err != nil {
		t.Fatal(err)
	}
	installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "2.0.0"})
	if err := manager.ConfigurePackageRetention(ctx, true, nil); err != nil {
		t.Fatal(err)
	}
	storage, err := manager.PackageStorage(ctx, 0, 0)
	if err != nil || len(storage.Packages) != 1 || !storage.Packages[0].Available {
		t.Fatal("expiring artifact lost its recovery copy", storage, err)
	}
	if _, err = db.Exec(`INSERT INTO addon_github_generations(addon_id,generation_id,source_json,remote_id) VALUES('example',?,'{"channel":"release","repo":"owner/repo"}','release')`, old.GenerationID); err != nil {
		t.Fatal(err)
	}
	installUninstallFixture(t, manager, packageSpec{ID: "example", Version: "3.0.0"})
	if _, err = os.Stat(filepath.Join(dir, "example", "generations", old.GenerationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("durable release did not allow cleanup", err)
	}
}
