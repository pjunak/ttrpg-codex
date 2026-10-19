package packagemanager

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/application/campaignimport"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

// contributorFactory starts runtimes whose bundle contributor answers every
// preview with the same plan.
type contributorFactory struct {
	fakeRuntimeFactory
	plan json.RawMessage
}

func (factory *contributorFactory) New(spec RuntimeSpec) (Runtime, error) {
	runtime, err := factory.fakeRuntimeFactory.New(spec)
	return contributorRuntime{Runtime: runtime, plan: factory.plan}, err
}

type contributorRuntime struct {
	Runtime
	plan json.RawMessage
}

func (runtime contributorRuntime) Call(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) {
	return runtime.plan, nil
}

func TestCampaignContributionWritesEachCollectionForItsAudience(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	factory := &contributorFactory{plan: json.RawMessage(`{"contractVersion":"campaign-contribution-plan.v1",
		"expectedDataSets":[{"kind":"collection","dataId":"notes","revision":0},{"kind":"collection","dataId":"secrets","revision":0}],
		"mutations":[
			{"operation":"put","collection":"notes","key":"one","expectedRevision":0,"value":{"text":"for the DM"}},
			{"operation":"put","collection":"secrets","key":"one","expectedRevision":0,"value":{"text":"for the worker"}}]}`)}
	manager, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), factory)
	collection := func(id, visibility string) map[string]any {
		return map[string]any{"id": id, "keyed": true, "visibility": visibility, "schema": "contracts/object.schema.json", "schemaVersion": "1.0.0"}
	}
	manifest := map[string]any{
		"packageFormat": 1, "id": "planner", "name": "Planner", "version": "1.0.0",
		"compatibility": map[string]any{"host": ">=2.0.0 <3.0.0", "addonApi": "^3.0.0", "workerProtocol": "^1.0.0"},
		"capabilities":  map[string]any{"required": []string{"worker.native"}, "optional": []string{}},
		"permissions":   []any{},
		"runtime": map[string]any{"worker": map[string]any{
			"type": "native", "protocol": "^1.0.0",
			"entrypoints": map[string]any{"windows-amd64": "worker/windows-amd64/addon.exe"},
		}},
		"collections": []any{collection("notes", "dm"), collection("secrets", "private")},
		"services": map[string]any{"provides": []any{map[string]any{
			"contract": campaignimport.ContributorContract, "version": "1.0.0",
			"transport": "worker", "schema": "contracts/contributor.service.json",
		}}},
	}
	generation, err := manager.Stage(ctx, writePackageZip(t, map[string][]byte{
		"addon.json":                     mustJSON(t, manifest),
		"worker/windows-amd64/addon.exe": []byte("test worker"),
		"contracts/object.schema.json":   []byte(`{"type":"object"}`),
		"contracts/contributor.service.json": mustJSON(t, map[string]any{
			"contract": campaignimport.ContributorContract, "version": "1.0.0", "allowsExclusive": false,
			"methods": map[string]any{"preview": map[string]any{
				"requestSchema": "contracts/object.schema.json", "responseSchema": "contracts/object.schema.json",
				"maxDeadlineMs": 15000, "idempotency": "none",
			}},
		}),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: "planner", GenerationID: generation.GenerationID}); err != nil {
		t.Fatal(err)
	}
	transaction, err := manager.PrepareCampaignContribution(ctx, workerrpc.Actor{Role: "dm", ID: "dm"}, "planner", "planner-notes", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	// The add-on data store accepts nothing broader than the system audience
	// for a private collection.
	audiences := make(map[string]events.Audience, len(transaction.Mutations))
	for _, mutation := range transaction.Mutations {
		audiences[mutation.Definition.ID] = mutation.Audience
	}
	if len(audiences) != 2 || audiences["notes"] != events.AudienceDM || audiences["secrets"] != events.AudienceSystem {
		t.Fatalf("contribution audiences = %v", audiences)
	}
}
