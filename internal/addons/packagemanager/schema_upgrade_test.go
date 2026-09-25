package packagemanager

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
)

func TestReviewedSchemaUpgradeUsesVerifiedPackageAndSeparateActivation(t *testing.T) {
	for _, tampered := range []bool{false, true} {
		t.Run(map[bool]string{false: "activate", true: "tampered"}[tampered], func(t *testing.T) {
			ctx := context.Background()
			db := testDatabase(t)
			directory := filepath.Join(t.TempDir(), "packages")
			manager, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
			journal, err := events.New(events.Config{DB: db})
			if err != nil {
				t.Fatal(err)
			}
			records, err := campaignstore.New(campaignstore.Config{DB: db, Events: journal})
			if err != nil {
				t.Fatal(err)
			}
			data, err := addondatastore.New(addondatastore.Config{DB: db, Events: journal})
			if err != nil {
				t.Fatal(err)
			}
			service, err := addondata.New(data, records)
			if err != nil {
				t.Fatal(err)
			}
			manager.dataLifecycle = service
			stage := func(version string) Generation {
				spec := packageSpec{ID: "schema-addon", Version: version, Collections: []map[string]any{{"id": "notes", "keyed": true, "visibility": "dm", "schema": "contracts/notes.json", "schemaVersion": version}},
					ExtraFiles: map[string][]byte{"contracts/notes.json": []byte(`{"type":"object","required":["text"],"properties":{"text":{"type":"string"}}}`)}}
				result, err := manager.Stage(ctx, writeAddonPackage(t, spec))
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			activate := func(generation string) {
				review, err := manager.PrepareActivationReview(ctx, "schema-addon", generation)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = manager.ApproveActivationReview(ctx, review.ReviewID, nil); err != nil {
					t.Fatal(err)
				}
				if _, err = manager.ActivateReviewed(ctx, review.ReviewID); err != nil {
					t.Fatal(err)
				}
			}
			old := stage("1.0.0")
			activate(old.GenerationID)
			if _, err = service.Transact(ctx, addondata.Transaction{Access: addondata.Access{AddonID: "schema-addon", Generation: old.GenerationID, Role: addondata.RoleDM, ActorID: "dm"}, Mutations: []addondata.Mutation{{Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: "one", Value: json.RawMessage(`{"text":"authored"}`)}}}); err != nil {
				t.Fatal(err)
			}
			next := stage("2.0.0")
			if _, err = manager.PrepareSchemaReview(ctx, "schema-addon", next.GenerationID); !errors.Is(err, datalifecycle.ErrUpgradeActive) {
				t.Fatal("active review", err)
			}
			disabling, err := manager.PrepareDisable(ctx, "schema-addon")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = manager.DisableReviewed(ctx, "schema-addon", disabling.ReviewSHA256); err != nil {
				t.Fatal(err)
			}
			staleActivation, err := manager.PrepareActivationReview(ctx, "schema-addon", next.GenerationID)
			if err != nil || len(staleActivation.Proposal.Blockers) == 0 {
				t.Fatal("missing migration blocker", err)
			}
			review, err := manager.PrepareSchemaReview(ctx, "schema-addon", next.GenerationID)
			if err != nil {
				t.Fatal(err)
			}
			if tampered {
				if err = os.WriteFile(filepath.Join(directory, "schema-addon", "generations", next.GenerationID, "root", "contracts", "notes.json"), []byte("{}"), 0600); err != nil {
					t.Fatal(err)
				}
				if _, err = manager.ApplySchemaReview(ctx, review.ReviewID, review.ReviewSHA256); !errors.Is(err, ErrInvalidPackage) {
					t.Fatal("mutated package accepted", err)
				}
				saved, _ := manager.GetSchemaReview(ctx, review.ReviewID)
				if saved.Status != "prepared" {
					t.Fatal("tamper changed receipt")
				}
				return
			}
			result, err := manager.ApplySchemaReview(ctx, review.ReviewID, review.ReviewSHA256)
			if err != nil || result.Status != "applied" {
				t.Fatal("upgrade", err)
			}
			state, err := manager.store.state(ctx, "schema-addon")
			if err != nil || state.ActiveGenerationID != "" {
				t.Fatal("autoactivation", err)
			}
			if _, err = manager.ApproveActivationReview(ctx, staleActivation.ReviewID, nil); !errors.Is(err, ErrReviewStale) {
				t.Fatal("old activation review accepted", err)
			}
			activate(next.GenerationID)
			if _, err = manager.ApplySchemaReview(ctx, review.ReviewID, review.ReviewSHA256); err != nil {
				t.Fatal("receipt unavailable after activation", err)
			}
		})
	}
}
