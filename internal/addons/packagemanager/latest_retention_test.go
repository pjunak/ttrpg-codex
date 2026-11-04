package packagemanager

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/recoverystore"
)

func retentionExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func TestLatestRetentionCleansExistingAndFutureBuildsPreservingCampaignRecovery(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	m, _ := testManager(t, db, dir, &fakeRuntimeFactory{})
	old := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	other := installUninstallFixture(t, m, packageSpec{ID: "other", Version: "1.0.0"})
	journal, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	recovery := &recoverystore.Store{DB: db, Events: journal}
	retentionExec(t, db, `INSERT INTO campaign_records(collection_name,record_key,position,body_json,visibility,revision,created_at,updated_at) VALUES('characters','hero',0,'{"id":"hero","name":"Before"}','public',1,'then','then')`)
	retentionExec(t, db, `INSERT INTO addon_data_sets(addon_id,data_kind,data_id,materialized) VALUES('example','collection','notes',1)`)
	if err := recovery.Create(ctx); err != nil {
		t.Fatal(err)
	}
	points, err := recovery.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id := points.Parts[0].Points[0].ID
	selected := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "2.0.0"})
	if err := m.ConfigurePackageRetention(ctx, true); err != nil {
		t.Fatal(err)
	}
	assertGone := func(g Generation) {
		t.Helper()
		if _, err := os.Stat(filepath.Join(dir, g.AddonID, "generations", g.GenerationID)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("obsolete package remains", err)
		}
	}
	assertGone(old)
	points, err = recovery.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The retired build's add-on points go; the campaign and other add-on stay.
	if len(points.Parts) != 2 || points.Parts[0].Points[0].ID != id || points.Parts[0].Points[0].Records != 1 ||
		points.Parts[1].AddonID != "other" || points.Parts[1].Points[0].GenerationID != other.GenerationID {
		t.Fatal("campaign or other add-on recovery lost", points.Parts)
	}
	var materialized int
	if err := db.QueryRow(`SELECT materialized FROM addon_data_sets WHERE addon_id='example'`).Scan(&materialized); err != nil || materialized != 1 {
		t.Fatal("current save changed", materialized, err)
	}
	retentionExec(t, db, `UPDATE campaign_records SET body_json='{"id":"hero","name":"After"}'`)
	points, _ = recovery.List(ctx)
	if err := recovery.Restore(ctx, recoverystore.RestoreRequest{Scope: recoverystore.Scope{Scope: "campaign"}, ID: id, ExpectedRevision: points.Revision}, "dm"); err != nil {
		t.Fatal("campaign blocked by removed package", err)
	}
	if err := recovery.Create(ctx); err != nil {
		t.Fatal(err)
	}
	// Selecting an older semantic version is still a version change: retain the
	// user's selected build rather than silently retaining the highest version.
	current := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.5.0"})
	assertGone(selected)
	snapshot, err := m.Snapshot(ctx, "example", 10)
	if err != nil || len(snapshot.Generations) != 1 || snapshot.State.ActiveGenerationID != current.GenerationID {
		t.Fatal("latest selected generation not retained", snapshot, err)
	}
	storage, err := m.PackageStorage(ctx)
	if err != nil || !storage.Automatic || storage.Pending != 0 {
		t.Fatal("wrong retention status", storage, err)
	}
}

func TestLatestRetentionKeepsDisabledSelectionAndValidPendingReview(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	m, _ := testManager(t, db, dir, &fakeRuntimeFactory{})
	installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	selected := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "2.0.0"})
	snapshot, _ := m.Snapshot(ctx, "example", 10)
	if _, err := m.Disable(ctx, DisablePlan{AddonID: "example", ExpectedStateRevision: snapshot.State.Revision}); err != nil {
		t.Fatal(err)
	}
	staged, err := m.Stage(ctx, writeAddonPackage(t, packageSpec{ID: "example", Version: "3.0.0"}))
	if err != nil {
		t.Fatal(err)
	}
	review, err := m.PrepareActivationReview(ctx, "example", staged.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.ConfigurePackageRetention(ctx, true); err != nil {
		t.Fatal(err)
	}
	snapshot, err = m.Snapshot(ctx, "example", 10)
	if err != nil || len(snapshot.Generations) != 2 || snapshot.State.ActiveGenerationID != "" {
		t.Fatal("disabled selection or review lost", snapshot, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "example", "generations", selected.GenerationID, "package.zip")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ApproveActivationReview(ctx, review.ReviewID, []string{}); err != nil {
		t.Fatal("cleanup invalidated pending review", err)
	}
	if _, err := m.ActivateReviewed(ctx, review.ReviewID); err != nil {
		t.Fatal(err)
	}
	snapshot, err = m.Snapshot(ctx, "example", 10)
	if err != nil || len(snapshot.Generations) != 1 || snapshot.State.ActiveGenerationID != staged.GenerationID {
		t.Fatal("completed review did not retire disabled build", snapshot, err)
	}
}

func TestLatestRetentionRollsBackContextRetirementBeforeDeletingFiles(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	m, _ := testManager(t, db, dir, &fakeRuntimeFactory{})
	old := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	recovery := &recoverystore.Store{DB: db}
	if err := recovery.Create(ctx); err != nil {
		t.Fatal(err)
	}
	installUninstallFixture(t, m, packageSpec{ID: "example", Version: "2.0.0"})
	before, _ := recovery.List(ctx)
	retentionExec(t, db, `CREATE TRIGGER reject_cleanup BEFORE DELETE ON addon_package_generations BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END`)
	if err := m.ConfigurePackageRetention(ctx, true); err == nil {
		t.Fatal("accepted failed metadata retirement")
	}
	after, _ := recovery.List(ctx)
	if after.Revision != before.Revision || len(after.Parts) != len(before.Parts) {
		t.Fatal("failed cleanup retired recovery", after)
	}
	if _, err := os.Stat(filepath.Join(dir, "example", "generations", old.GenerationID, "package.zip")); err != nil {
		t.Fatal("files removed before commit", err)
	}
	retentionExec(t, db, `DROP TRIGGER reject_cleanup`)
	if err := m.RetryPackageCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "example", "generations", old.GenerationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("retry did not finish", err)
	}
}

func TestAutomaticRetentionLeavesFailedAndCancelledUpdatesUntouched(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	dir := filepath.Join(t.TempDir(), "addons")
	factory := &fakeRuntimeFactory{failVersions: map[string]error{"2.0.0": errors.New("failed startup")}}
	manager, _ := testManager(t, db, dir, factory)
	if err := manager.ConfigurePackageRetention(ctx, true); err != nil {
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

func TestBackupRequiresTheSelectedPackageFiles(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	root := t.TempDir()
	directory := filepath.Join(root, "addons")
	m, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	installed := installUninstallFixture(t, m, packageSpec{ID: "example", Version: "1.0.0"})
	out := filepath.Join(t.TempDir(), "backup.zip")
	create := func(output string) error {
		_, err := backuparchive.Create(ctx, backuparchive.CreateConfig{Database: db, DataDirectory: root, OutputPath: output, HostVersion: "test"})
		return err
	}
	if err := create(out); err != nil {
		t.Fatal(err)
	}
	if _, err := backuparchive.Verify(ctx, backuparchive.VerifyConfig{ArchivePath: out, Migrations: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	// With the files gone, the backup fails rather than publishing a broken copy.
	if err := os.RemoveAll(filepath.Join(directory, "example", "generations", installed.GenerationID)); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "missing.zip")
	if err := create(missing); !errors.Is(err, backuparchive.ErrInvalidArchive) {
		t.Fatal("published a backup without required package files", err)
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed backup left output", err)
	}
}
