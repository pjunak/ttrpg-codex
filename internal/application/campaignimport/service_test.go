package campaignimport

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

const sampleBundle = `{"format":"ttrpg-codex-campaign-bundle","schemaVersion":1,"generatedAt":0,"records":{"characters":[{"ref":"new-hero","operation":"create","record":{"name":"Aria","visibility":"public","description":"Authored prose","location":{"$ref":"secret-place"}}}],"locations":[{"ref":"secret-place","operation":"create","record":{"name":"Secret lair","visibility":"dm","mapNotes":"Hidden note"}}]}}`

type contributorFunc func(context.Context, workerrpc.Actor, string, string, json.RawMessage) (addondatastore.Transaction, error)

func (f contributorFunc) PrepareCampaignContribution(ctx context.Context, actor workerrpc.Actor, id, contributor string, body json.RawMessage) (addondatastore.Transaction, error) {
	return f(ctx, actor, id, contributor, body)
}

func setup(t *testing.T) (*Service, *sql.DB, *campaignstore.Store, *events.Broker, Owner) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err = storage.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	broker, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	core, err := campaignstore.New(campaignstore.Config{DB: db, Events: broker})
	if err != nil {
		t.Fatal(err)
	}
	addons, err := addondatastore.New(addondatastore.Config{DB: db, Events: broker})
	if err != nil {
		t.Fatal(err)
	}
	service, err := New(ctx, db, core, addons, nil)
	if err != nil {
		t.Fatal(err)
	}
	owner := Owner{ActorID: "dm-session", AddonID: "dm-tools", Generation: strings.Repeat("a", 64)}
	for _, id := range []string{"dm-tools", "planning-addon"} {
		if _, err = db.Exec(`INSERT INTO addon_package_generations(addon_id,generation_id,addon_version,archive_sha256,manifest_json,installed_at) VALUES(?,?,'1.0.0',?,'{}',?)`, id, owner.Generation, owner.Generation, time.Now().Format(time.RFC3339Nano)); err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(`INSERT INTO addon_package_states(addon_id,active_generation_id,updated_at) VALUES(?,?,?)`, id, owner.Generation, time.Now().Format(time.RFC3339Nano)); err != nil {
			t.Fatal(err)
		}
	}
	return service, db, core, broker, owner
}
func preview(t *testing.T, service *Service, owner Owner, body string) Preview {
	t.Helper()
	result, err := service.Preview(context.Background(), owner, json.RawMessage(body))
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func assertKind(t *testing.T, err error, kind string) {
	t.Helper()
	var rpc *workerrpc.RPCError
	if !errors.As(err, &rpc) || rpc.Data == nil || rpc.Data.Kind != kind {
		t.Fatalf("error = %v, want %s", err, kind)
	}
}
func records(t *testing.T, core *campaignstore.Store) []campaign.Record {
	t.Helper()
	snapshot, err := core.Snapshot(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot.Records
}

func TestPreviewRetainsExactIDsViewsAndSingleUseReceipt(t *testing.T) {
	service, db, core, _, owner := setup(t)
	ctx := context.Background()
	review := preview(t, service, owner, sampleBundle)
	if len(records(t, core)) != 0 || review.Summary.Creates != 2 || len(review.References) != 2 {
		t.Fatalf("preview mutated data or incorrect counts: %+v", review)
	}
	for _, change := range review.Changes {
		if change.Collection == "characters" && strings.Contains(string(change.Player), review.References[1].ID) {
			t.Fatal("player view leaked private location reference")
		}
		if change.Collection == "locations" && len(change.Player) > 0 {
			t.Fatal("DM location has a player view")
		}
	}
	other := owner
	other.ActorID = "another-session"
	_, err := service.Commit(ctx, other, review.Token)
	assertKind(t, err, workerrpc.KindNotFound)
	receipt, err := service.Commit(ctx, owner, review.Token)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Writes != 2 {
		t.Fatalf("receipt=%+v", receipt)
	}
	for _, record := range records(t, core) {
		matched := false
		for _, change := range review.Changes {
			if change.ID == record.Key {
				matched = string(change.DM) == string(record.Value)
			}
		}
		if !matched {
			t.Fatalf("commit differs from preview: %+v", record)
		}
	}
	// A lost response is reconciled without rerunning either planner or writes.
	status, err := service.Status(ctx, review.Token)
	if err != nil || status["status"] != "committed" {
		t.Fatalf("status=%v %v", status, err)
	}
	_, err = service.Commit(ctx, owner, review.Token)
	assertKind(t, err, workerrpc.KindNotFound)
	restarted, err := New(ctx, db, core, service.addons, nil)
	if err != nil {
		t.Fatal(err)
	}
	status, err = restarted.Status(ctx, review.Token)
	if err != nil || status["status"] != "committed" {
		t.Fatalf("durable status=%v %v", status, err)
	}
}

func TestCancelExpiryAndConflictsConsumePreview(t *testing.T) {
	for _, scenario := range []string{"cancel", "expiry", "data", "generation", "cancelled-context"} {
		t.Run(scenario, func(t *testing.T) {
			service, db, core, _, owner := setup(t)
			ctx := context.Background()
			review := preview(t, service, owner, sampleBundle)
			switch scenario {
			case "cancel":
				if err := service.Cancel(owner, review.Token); err != nil {
					t.Fatal(err)
				}
			case "expiry":
				service.now = func() time.Time { return time.Now().Add(time.Hour) }
			case "data":
				_, err := core.Transact(ctx, campaign.Transaction{ActorID: "other", Mutations: []campaign.Mutation{{Kind: campaign.Put, Collection: campaign.Settings, Key: "test", Value: json.RawMessage(`{"value":true}`)}}})
				if err != nil {
					t.Fatal(err)
				}
			case "generation":
				if _, err := db.Exec("UPDATE addon_package_states SET active_generation_id=NULL WHERE addon_id=?", owner.AddonID); err != nil {
					t.Fatal(err)
				}
			case "cancelled-context":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if _, err := service.Commit(ctx, owner, review.Token); err == nil {
				t.Fatal("invalid preview committed")
			}
			for _, record := range records(t, core) {
				if record.Collection == campaign.Characters || record.Collection == campaign.Locations {
					t.Fatal("partial import")
				}
			}
			if _, err := service.Commit(context.Background(), owner, review.Token); err == nil {
				t.Fatal("failed token reused")
			}
		})
	}
}

func TestClosedBundleAndTypedReferences(t *testing.T) {
	service, _, _, _, owner := setup(t)
	for name, body := range map[string]string{
		"extra":         strings.Replace(sampleBundle, `"generatedAt":0`, `"generatedAt":0,"settings":{}`, 1),
		"unknown-field": strings.Replace(sampleBundle, `"description":"Authored prose"`, `"arbitraryField":true`, 1),
		"wrong-type":    strings.Replace(sampleBundle, `"location":{"$ref":"secret-place"}`, `"location":{"$ref":"new-hero"}`, 1),
		"duplicate":     strings.Replace(sampleBundle, `"ref":"secret-place"`, `"ref":"new-hero"`, 1),
		"missing":       strings.Replace(sampleBundle, `"$ref":"secret-place"`, `"$id":{"collection":"locations","id":"missing"}`, 1),
		"empty":         `{"format":"ttrpg-codex-campaign-bundle","schemaVersion":1,"generatedAt":0,"records":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := service.Preview(context.Background(), owner, json.RawMessage(body))
			assertKind(t, err, workerrpc.KindValidationFailed)
		})
	}
}

func contributionBundle() string {
	return strings.TrimSuffix(sampleBundle, "}") + `,"addonImports":[{"addonId":"planning-addon","contributorId":"planning-json","document":{"target":{"$ref":"new-hero"}}}]}`
}
func attachContributor(service *Service, owner Owner, calls *int) {
	service.contributors = contributorFunc(func(_ context.Context, actor workerrpc.Actor, addonID, contributor string, body json.RawMessage) (addondatastore.Transaction, error) {
		*calls++
		if actor.Role != "dm" || addonID != "planning-addon" || contributor != "planning-json" || strings.Contains(string(body), "$ref") {
			return addondatastore.Transaction{}, errors.New("invalid contributor call")
		}
		definition := datacontract.Description{Kind: datacontract.Collection, ID: "notes", Keyed: true, Visibility: datacontract.VisibilityDM, Schema: "contracts/note.schema.json", SchemaVersion: "1.0.0", SchemaSHA256: strings.Repeat("b", 64)}
		return addondatastore.Transaction{AddonID: addonID, GenerationID: owner.Generation, ExpectedDataSets: []addondatastore.DataSetRevision{{Kind: datacontract.Collection, DataID: "notes", Revision: 0}}, Mutations: []addondatastore.Mutation{{Kind: addondatastore.Put, Definition: definition, Key: "note", Value: body, Audience: events.AudienceDM}}}, nil
	})
}
func TestAtomicCoreAndContributionRollbackAndStaleGuard(t *testing.T) {
	for _, scenario := range []string{"success", "write-failure", "receipt-failure", "addon-stale"} {
		t.Run(scenario, func(t *testing.T) {
			service, db, core, broker, owner := setup(t)
			ctx := context.Background()
			calls := 0
			attachContributor(service, owner, &calls)
			review := preview(t, service, owner, contributionBundle())
			if calls != 1 || len(records(t, core)) != 0 {
				t.Fatal("preview side effect")
			}
			var err error
			switch scenario {
			case "write-failure":
				_, err = db.Exec(`CREATE TRIGGER reject_import BEFORE INSERT ON addon_documents BEGIN SELECT RAISE(ABORT,'test'); END`)
			case "receipt-failure":
				_, err = db.Exec(`CREATE TRIGGER reject_receipt BEFORE UPDATE ON campaign_import_receipts WHEN NEW.status='committed' BEGIN SELECT RAISE(ABORT,'test'); END`)
			case "addon-stale":
				_, err = db.Exec(`UPDATE addon_package_states SET active_generation_id=NULL WHERE addon_id='planning-addon'`)
			}
			if err != nil {
				t.Fatal(err)
			}
			receipt, err := service.Commit(ctx, owner, review.Token)
			if calls != 1 {
				t.Fatal("commit reran contributor")
			}
			var docs, commits int
			if scanErr := db.QueryRow("SELECT count(*) FROM addon_documents").Scan(&docs); scanErr != nil {
				t.Fatal(scanErr)
			}
			if scanErr := db.QueryRow("SELECT count(*) FROM campaign_commits").Scan(&commits); scanErr != nil {
				t.Fatal(scanErr)
			}
			replay, replayErr := broker.Replay(ctx, events.AudienceDM, 0, 100)
			if replayErr != nil {
				t.Fatal(replayErr)
			}
			status, statusErr := service.Status(ctx, review.Token)
			if statusErr != nil {
				t.Fatal(statusErr)
			}
			if scenario == "success" {
				if err != nil || receipt.Writes != 3 || len(records(t, core)) != 2 || docs != 1 || commits != 1 || len(replay.Events) == 0 || status["status"] != "committed" {
					t.Fatalf("atomic success: %+v %v %d %d %v", receipt, err, docs, commits, status)
				}
			} else if err == nil || len(records(t, core)) != 0 || docs != 0 || commits != 0 || len(replay.Events) != 0 || status["status"] != "failed" {
				t.Fatalf("rollback failure: %v docs=%d commits=%d replay=%+v status=%v", err, docs, commits, replay, status)
			}
		})
	}
}
func TestConcurrentDoubleCommitPublishesOnce(t *testing.T) {
	service, _, core, _, owner := setup(t)
	review := preview(t, service, owner, sampleBundle)
	var wait sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := service.Commit(context.Background(), owner, review.Token)
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	if success != 1 || len(records(t, core)) != 2 {
		t.Fatalf("successes=%d records=%d", success, len(records(t, core)))
	}
}
