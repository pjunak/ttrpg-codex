package addondata

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
)

func TestSchemaReviewValidatesPreservationBeforeIdentityChanges(t *testing.T) {
	for _, scenario := range []string{"compatible", "unique", "required", "removed", "keyed", "active"} {
		t.Run(scenario, func(t *testing.T) {
			service, _, db, _ := testService(t)
			ctx := context.Background()
			activate(t, service, testRegistry(t, "1.0.0", false), generationOne)
			access := Access{AddonID: "dm-tools", Generation: generationOne, Role: RoleSystem}
			for _, key := range []string{"one", "two"} {
				if _, err := service.Transact(ctx, Transaction{Access: access, Mutations: []Mutation{{Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: key, Value: json.RawMessage(`{"id":"` + key + `","title":"same"}`)}}}); err != nil {
					t.Fatal(err)
				}
			}
			next := strings.Repeat("2", 64)
			if _, err := db.Exec(`INSERT INTO addon_package_generations(addon_id,generation_id,addon_version,archive_sha256,manifest_json,installed_at) VALUES('dm-tools',?,'2.0.0',?,'{}','2026-09-01T12:00:00Z')`, next, next); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO addon_package_states(addon_id,revision,updated_at) VALUES('dm-tools',1,'2026-09-01T12:00:00Z')`); err != nil {
				t.Fatal(err)
			}
			if scenario != "active" {
				service.BeginDeactivation("dm-tools", generationOne).Commit()
			}
			declarations := []datacontract.Declaration{{Kind: datacontract.Collection, ID: "notes", Visibility: datacontract.VisibilityPublic, Schema: "contracts/note.json", SchemaVersion: "2.0.0"}}
			schema := `{"type":"object","additionalProperties":false,"required":["id","title"],"properties":{"id":{"type":"string"},"title":{"type":"string"},"optional":{"type":"boolean"}}}`
			switch scenario {
			case "unique":
				declarations[0].Indexes = []datacontract.Index{{Path: "/title", Unique: true}}
			case "required":
				schema = strings.Replace(schema, `["id","title"]`, `["id","title","optional"]`, 1)
			case "removed":
				declarations = nil
			case "keyed":
				declarations[0].Keyed = true
			}
			registry, err := datacontract.Compile(declarations, map[string][]byte{"contracts/note.json": []byte(schema)})
			if err != nil {
				t.Fatal(err)
			}
			review, err := service.PrepareSchemaReview(ctx, datalifecycle.SchemaReviewRequest{ReviewID: "review", AddonID: "dm-tools", GenerationID: next, ExpectedStateRevision: 1}, registry)
			if scenario == "active" {
				if !errors.Is(err, datalifecycle.ErrUpgradeActive) {
					t.Fatal("active review", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(review)
			if strings.Contains(string(encoded), `"same"`) || strings.Contains(string(encoded), `"one"`) {
				t.Fatal("review leaked saved bodies or keys")
			}
			if scenario != "compatible" {
				if len(review.Blockers) == 0 {
					t.Fatal("incompatible data accepted")
				}
				if _, err = service.ApplySchemaReview(ctx, review.ReviewID, review.ReviewSHA256); !errors.Is(err, datalifecycle.ErrUpgradeBlocked) {
					t.Fatal("blocked apply", err)
				}
				return
			}
			if len(review.Blockers) != 0 || len(review.Changes) != 1 {
				t.Fatalf("compatible review %+v", review)
			}
			issues, err := service.ReviewActivation(ctx, "dm-tools", registry)
			if err != nil || len(issues) == 0 {
				t.Fatal("activation bypassed review")
			}
			if _, err = service.ApplySchemaReview(ctx, review.ReviewID, review.ReviewSHA256); err != nil {
				t.Fatal(err)
			}
			issues, err = service.ReviewActivation(ctx, "dm-tools", registry)
			if err != nil || len(issues) != 0 {
				t.Fatal("upgrade did not unlock activation", issues, err)
			}
			if _, err = service.Get(ctx, access, datacontract.Collection, "notes", "one"); !errors.Is(err, ErrInactiveGeneration) {
				t.Fatal("old generation regained authority", err)
			}
			activate(t, service, registry, next)
			access.Generation = next
			record, err := service.Get(ctx, access, datacontract.Collection, "notes", "one")
			if err != nil || string(record.Value) != `{"id":"one","title":"same"}` {
				t.Fatal("values changed", err)
			}
		})
	}
}
