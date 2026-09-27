package packagemanager

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
)

type updateFixture struct {
	manager   *Manager
	service   *addondata.Service
	data      *addondatastore.Store
	factory   *fakeRuntimeFactory
	old, next Generation
	review    ActivationReview
	schema    datalifecycle.SchemaReview
}

func newUpdateFixture(t *testing.T, incompatible bool) updateFixture {
	t.Helper()
	ctx := context.Background()
	db := testDatabase(t)
	factory := &fakeRuntimeFactory{failVersions: map[string]error{}}
	manager, _ := testManager(t, db, filepath.Join(t.TempDir(), "packages"), factory)
	journal, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	core, err := campaignstore.New(campaignstore.Config{DB: db, Events: journal})
	if err != nil {
		t.Fatal(err)
	}
	data, err := addondatastore.New(addondatastore.Config{DB: db, Events: journal})
	if err != nil {
		t.Fatal(err)
	}
	service, err := addondata.New(data, core)
	if err != nil {
		t.Fatal(err)
	}
	manager.dataLifecycle = service
	stage := func(id, version, valueType string) Generation {
		generation, err := manager.Stage(ctx, writeAddonPackage(t, packageSpec{ID: id, Version: version, Worker: true,
			Collections: []map[string]any{{"id": "notes", "keyed": true, "visibility": "dm", "schema": "contracts/notes.json", "schemaVersion": version}},
			ExtraFiles:  map[string][]byte{"contracts/notes.json": []byte(`{"type":"object","required":["text"],"properties":{"text":{"type":"` + valueType + `"}}}`)}}))
		if err != nil {
			t.Fatal(err)
		}
		return generation
	}
	activate := func(g Generation) {
		r, err := manager.PrepareActivationReview(ctx, g.AddonID, g.GenerationID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = manager.ApproveActivationReview(ctx, r.ReviewID, nil); err != nil {
			t.Fatal(err)
		}
		if _, err = manager.ActivateReviewed(ctx, r.ReviewID); err != nil {
			t.Fatal(err)
		}
		if _, err = service.Transact(ctx, addondata.Transaction{Access: addondata.Access{AddonID: g.AddonID, Generation: g.GenerationID, Role: addondata.RoleDM, ActorID: "dm"}, Mutations: []addondata.Mutation{{Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: "one", Value: json.RawMessage(`{ "text": "authored" }`)}}}); err != nil {
			t.Fatal(err)
		}
	}
	old := stage("update-addon", "1.0.0", "string")
	activate(old)
	other := stage("other-addon", "1.0.0", "string")
	activate(other)
	valueType := "string"
	if incompatible {
		valueType = "number"
	}
	next := stage("update-addon", "2.0.0", valueType)
	review, err := manager.PrepareActivationReview(ctx, next.AddonID, next.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := manager.PrepareUpdateDataReview(ctx, review.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	return updateFixture{manager, service, data, factory, old, next, review, schema}
}

func (f updateFixture) request(action string) UpdateResolution {
	return UpdateResolution{ProposalSHA256: f.review.ProposalSHA256, SchemaReviewID: f.schema.ReviewID, SchemaReviewSHA256: f.schema.ReviewSHA256, Action: action}
}
func (f updateFixture) snapshot(t *testing.T, addon string) addondatastore.Snapshot {
	t.Helper()
	value, err := f.data.SnapshotAddon(context.Background(), addon)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestUpdateResolutionPreservesValuesOrRemovesOnlySelectedSaves(t *testing.T) {
	for _, action := range []string{"heal", "remove"} {
		t.Run(action, func(t *testing.T) {
			ctx := context.Background()
			f := newUpdateFixture(t, action == "remove")
			before, other := f.snapshot(t, "update-addon"), f.snapshot(t, "other-addon")
			backup, err := f.manager.SchemaReviewRecovery(ctx, f.schema.ReviewID)
			if err != nil {
				t.Fatal(err)
			}
			var image struct {
				Bodies [][]byte `json:"bodiesBase64"`
			}
			if err = json.Unmarshal(backup, &image); err != nil || string(image.Bodies[0]) != string(before.Documents[0].Value) {
				t.Fatal("backup did not preserve exact values", err)
			}
			if action == "remove" {
				if _, err = f.manager.ResolveAndActivate(ctx, f.review.ReviewID, f.request("heal")); !errors.Is(err, datalifecycle.ErrUpgradeBlocked) {
					t.Fatal("unsafe healing accepted", err)
				}
			}
			if err = f.manager.ConfigureLatestPackageRetention(ctx, true, nil); err != nil {
				t.Fatal(err)
			}
			result, err := f.manager.ResolveAndActivate(ctx, f.review.ReviewID, f.request(action))
			if err != nil || result.State.ActiveGenerationID != f.next.GenerationID {
				t.Fatal("update", err)
			}
			after := f.snapshot(t, "update-addon")
			if action == "heal" {
				if len(after.Documents) != 1 || string(after.Documents[0].Value) != string(before.Documents[0].Value) || after.Documents[0].Revision != before.Documents[0].Revision || after.States[0].SchemaVersion != "2.0.0" {
					t.Fatal("heal changed authored data", after)
				}
			} else if len(after.Documents) != 0 || after.States[0].Materialized {
				t.Fatal("reset retained current saves", after)
			}
			if !reflect.DeepEqual(other, f.snapshot(t, "other-addon")) {
				t.Fatal("another namespace changed")
			}
			if _, err = f.manager.store.generation(ctx, f.old.AddonID, f.old.GenerationID); !errors.Is(err, ErrGenerationNotFound) {
				t.Fatal("old package not automatically removed", err)
			}
			again, err := f.manager.ResolveAndActivate(ctx, f.review.ReviewID, f.request(action))
			if err != nil || again.State.Revision != result.State.Revision {
				t.Fatal("lost-response retry", err)
			}
			changed := f.request(action)
			changed.Action = map[string]string{"heal": "remove", "remove": "heal"}[action]
			if _, err = f.manager.ResolveAndActivate(ctx, f.review.ReviewID, changed); !errors.Is(err, ErrReviewStale) {
				t.Fatal("receipt accepted another action", err)
			}
			retained, err := f.manager.SchemaReviewRecovery(ctx, f.schema.ReviewID)
			if err != nil || string(retained) != string(backup) {
				t.Fatal("backup lost after pruning", err)
			}
		})
	}
}

func TestUpdateResolutionOffersResetForConflictingUniqueValues(t *testing.T) {
	ctx := context.Background()
	f := newUpdateFixture(t, false)
	_, err := f.service.Transact(ctx, addondata.Transaction{Access: addondata.Access{AddonID: f.old.AddonID, Generation: f.old.GenerationID, Role: addondata.RoleDM, ActorID: "dm"}, Mutations: []addondata.Mutation{{Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: "two", Value: json.RawMessage(`{"text":"authored"}`)}}})
	if err != nil {
		t.Fatal(err)
	}
	// The unchanged schema isolates an index conflict from schema migration.
	f.next, err = f.manager.Stage(ctx, writeAddonPackage(t, packageSpec{ID: f.old.AddonID, Version: "3.0.0", Worker: true,
		Collections: []map[string]any{{"id": "notes", "keyed": true, "visibility": "dm", "schema": "contracts/notes.json", "schemaVersion": "1.0.0", "indexes": []map[string]any{{"path": "/text", "unique": true}}}},
		ExtraFiles:  map[string][]byte{"contracts/notes.json": []byte(`{"type":"object","required":["text"],"properties":{"text":{"type":"string"}}}`)}}))
	if err != nil {
		t.Fatal(err)
	}
	f.review, err = f.manager.PrepareActivationReview(ctx, f.next.AddonID, f.next.GenerationID)
	if err != nil || len(f.review.Proposal.Blockers) != 1 || f.review.Proposal.Blockers[0].Code != "UNIQUE_INDEX_CONFLICT" {
		t.Fatal("expected only a unique index conflict", f.review.Proposal.Blockers, err)
	}
	f.schema, err = f.manager.PrepareUpdateDataReview(ctx, f.review.ReviewID)
	if err != nil || len(f.schema.Blockers) != 1 || f.schema.Blockers[0].Code != "UNIQUE_INDEX_CONFLICT" {
		t.Fatal("missing guided resolution for duplicate values", f.schema.Blockers, err)
	}
	before, other := f.snapshot(t, f.old.AddonID), f.snapshot(t, "other-addon")
	if _, err = f.manager.ResolveAndActivate(ctx, f.review.ReviewID, f.request("heal")); !errors.Is(err, datalifecycle.ErrUpgradeBlocked) {
		t.Fatal("healing accepted duplicate values", err)
	}
	if !reflect.DeepEqual(before, f.snapshot(t, f.old.AddonID)) {
		t.Fatal("blocked healing changed current saves")
	}
	result, err := f.manager.ResolveAndActivate(ctx, f.review.ReviewID, f.request("remove"))
	if err != nil || result.State.ActiveGenerationID != f.next.GenerationID {
		t.Fatal("confirmed reset did not activate unique index", err)
	}
	if len(f.snapshot(t, f.old.AddonID).Documents) != 0 || !reflect.DeepEqual(other, f.snapshot(t, "other-addon")) {
		t.Fatal("reset did not remain scoped to this add-on")
	}
}

func TestUpdateResolutionRejectsChangedDataAndRollsBackFailedActivation(t *testing.T) {
	for _, failure := range []string{"changed-save", "transaction", "worker"} {
		t.Run(failure, func(t *testing.T) {
			ctx := context.Background()
			f := newUpdateFixture(t, true)
			if failure == "changed-save" {
				_, err := f.service.Transact(ctx, addondata.Transaction{Access: addondata.Access{AddonID: f.old.AddonID, Generation: f.old.GenerationID, Role: addondata.RoleDM, ActorID: "dm"}, Mutations: []addondata.Mutation{{Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: "one", ExpectedRevision: 1, Value: json.RawMessage(`{"text":"newer edit"}`)}}})
				if err != nil {
					t.Fatal(err)
				}
			}
			if failure == "transaction" {
				if _, err := f.manager.store.db.Exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON addon_package_states WHEN NEW.active_generation_id='` + f.next.GenerationID + `' BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
					t.Fatal(err)
				}
			}
			if failure == "worker" {
				f.factory.failVersions["2.0.0"] = errors.New("injected start failure")
			}
			before, other := f.snapshot(t, "update-addon"), f.snapshot(t, "other-addon")
			_, err := f.manager.ResolveAndActivate(ctx, f.review.ReviewID, f.request("remove"))
			if err == nil {
				t.Fatal("failed update succeeded")
			}
			if failure == "changed-save" && !errors.Is(err, datalifecycle.ErrUpgradeStale) {
				t.Fatal(err)
			}
			if failure == "worker" && !errors.Is(err, ErrUpdateRestored) {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, f.snapshot(t, "update-addon")) || !reflect.DeepEqual(other, f.snapshot(t, "other-addon")) {
				t.Fatal("failed update lost data")
			}
			state, err := f.manager.store.state(ctx, "update-addon")
			if err != nil || state.ActiveGenerationID != f.old.GenerationID {
				t.Fatal("old selection not restored", err)
			}
			if _, err = f.service.Get(ctx, addondata.Access{AddonID: f.old.AddonID, Generation: f.old.GenerationID, Role: addondata.RoleDM, ActorID: "dm"}, datacontract.Collection, "notes", "one"); err != nil {
				t.Fatal("old runtime unusable", err)
			}
		})
	}
}

func TestInterruptedUpdateRestoresDataBeforeStartupRecovery(t *testing.T) {
	ctx := context.Background()
	f := newUpdateFixture(t, true)
	before := f.snapshot(t, "update-addon")
	if _, err := f.manager.ResolveAndActivate(ctx, f.review.ReviewID, f.request("remove")); err != nil {
		t.Fatal(err)
	}
	// Recreate the durable checkpoint immediately before the success receipt.
	if _, err := f.manager.store.db.Exec("UPDATE addon_update_attempts SET status='pending',result_json=NULL WHERE review_id=?", f.review.ReviewID); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	// Both automatic and operator maintenance must retain the rollback package
	// while a durable update journal still needs it.
	for _, automatic := range []bool{false, true} {
		review, err := f.manager.PrepareCleanup(ctx, CleanupScope{AddonID: f.old.AddonID, GenerationID: f.old.GenerationID, DiscardAddonRecovery: automatic})
		if err != nil || review.RemoveCount != 0 || review.Generations[0].Protection != "review" {
			t.Fatal("pending rollback package exposed to cleanup", review, err)
		}
	}
	restarted, _ := testManager(t, f.manager.store.db, f.manager.directory, &fakeRuntimeFactory{})
	restarted.dataLifecycle = f.service
	results, err := restarted.Recover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range results {
		if !result.Recovered {
			t.Fatal(result)
		}
	}
	if !reflect.DeepEqual(before, f.snapshot(t, "update-addon")) {
		t.Fatal("startup lost original saves")
	}
	if _, err = restarted.ResolveAndActivate(ctx, f.review.ReviewID, f.request("remove")); !errors.Is(err, ErrUpdateRestored) {
		t.Fatal("interrupted receipt", err)
	}
}

func TestUpdateRollbackFailureRemainsExclusiveUntilMaintenanceRecovers(t *testing.T) {
	ctx := context.Background()
	f := newUpdateFixture(t, true)
	before := f.snapshot(t, "update-addon")
	f.factory.failVersions["2.0.0"] = errors.New("injected worker failure")
	if _, err := f.manager.store.db.Exec(`CREATE TRIGGER reject_snapshot_restore BEFORE INSERT ON addon_documents WHEN NEW.addon_id='update-addon' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.ResolveAndActivate(ctx, f.review.ReviewID, f.request("remove")); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatal("pending rollback was not reported", err)
	}
	state, err := f.manager.store.state(ctx, "update-addon")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.manager.Disable(ctx, DisablePlan{AddonID: "update-addon", ExpectedStateRevision: state.Revision}); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatal("disable displaced rollback state", err)
	}
	if _, err = f.manager.ActivateReviewed(ctx, f.review.ReviewID); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatal("ordinary activation bypassed pending receipt", err)
	}
	if err = f.manager.WithPackageSnapshot(ctx, func() error { t.Fatal("recovery bypassed pending update"); return nil }); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatal(err)
	}
	if _, err = f.manager.store.db.Exec("DROP TRIGGER reject_snapshot_restore"); err != nil {
		t.Fatal(err)
	}
	if err = f.manager.MaintainPackages(ctx); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, f.snapshot(t, "update-addon")) {
		t.Fatal("maintenance did not restore original data")
	}
	if _, err = f.manager.ResolveAndActivate(ctx, f.review.ReviewID, f.request("remove")); !errors.Is(err, ErrUpdateRestored) {
		t.Fatal("pending receipt not resolved", err)
	}
}

func TestAutomaticMaintenanceExpiresCancelledFirstInstallation(t *testing.T) {
	ctx := context.Background()
	f := newUpdateFixture(t, false)
	generation, err := f.manager.Stage(ctx, writeAddonPackage(t, packageSpec{ID: "never-started", Version: "1.0.0"}))
	if err != nil {
		t.Fatal(err)
	}
	if err = f.manager.ConfigureLatestPackageRetention(ctx, true, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = f.manager.store.generation(ctx, generation.AddonID, generation.GenerationID); err != nil {
		t.Fatal("stage-to-review gap was not protected", err)
	}
	review, err := f.manager.PrepareActivationReview(ctx, generation.AddonID, generation.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.manager.CancelActivationReview(ctx, review.ReviewID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.manager.store.generation(ctx, generation.AddonID, generation.GenerationID); !errors.Is(err, ErrGenerationNotFound) {
		t.Fatal("cancelled first installation retained", err)
	}
}

func TestAutomaticMaintenanceCancelsAndExpiresUnselectedBuilds(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "abandoned", true: "cancelled"}[cancelled], func(t *testing.T) {
			ctx := context.Background()
			f := newUpdateFixture(t, false)
			if err := f.manager.ConfigureLatestPackageRetention(ctx, true, nil); err != nil {
				t.Fatal(err)
			}
			if cancelled {
				if err := f.manager.CancelActivationReview(ctx, f.review.ReviewID); err != nil {
					t.Fatal(err)
				}
			} else {
				now := f.manager.store.now()
				f.manager.store.now = func() time.Time { return now.Add(31 * time.Minute) }
				if err := f.manager.MaintainPackages(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.manager.store.generation(ctx, f.next.AddonID, f.next.GenerationID); !errors.Is(err, ErrGenerationNotFound) {
				t.Fatal("abandoned package retained", err)
			}
			state, err := f.manager.store.state(ctx, f.old.AddonID)
			if err != nil || state.ActiveGenerationID != f.old.GenerationID {
				t.Fatal("cancel changed active package", err)
			}
			if len(f.snapshot(t, "update-addon").Documents) != 1 {
				t.Fatal("cancel changed saved data")
			}
		})
	}
}
