package packagemanager

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

func TestRulesetLockAndSourcePolicySurviveDisableAndRecovery(t *testing.T) {
	ctx := context.Background()
	manager, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	rules := &packageinspect.RulesDeclaration{Supports: []string{"system-one"}, Defines: &packageinspect.RulesetDefinition{ID: "system-one", Name: "System One", Contract: "example.rules", ContentSet: "rules", RecordKind: "ruleset", RecordID: "system-one"}}
	spec := packageSpec{ID: "rule-books", Version: "1.0.0", Contract: "example.rules", ContractVersion: "3.0.0", ContentService: true, Rules: rules,
		ContentGroups: &packageinspect.ContentGroups{Field: "book", AdditionalField: "availableIn", Label: "Books"}, ExtraFiles: map[string][]byte{
			"content/rules/ruleset.json": []byte(`{"kind":"ruleset","id":"system-one","name":"System One","book":"phb"}`),
			"content/rules/extra.json":   []byte(`{"kind":"spell","id":"extra","name":"Extra","book":"extra"}`),
		}}
	generation, err := manager.Stage(ctx, writeAddonPackage(t, spec))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: spec.ID, GenerationID: generation.GenerationID}); err != nil {
		t.Fatal(err)
	}
	policy, err := manager.RulesPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if policy.Ruleset == nil || policy.Ruleset.ID != "system-one" || len(policy.Sources) != 2 {
		t.Fatalf("policy = %+v", policy)
	}
	content, err := manager.ContentRegistry(spec.ID, generation.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := content.Get("rules", "spell", "extra"); !errors.Is(err, contentcontract.ErrRecordNotFound) {
		t.Fatal("new optional book was silently enabled", err)
	}
	plan := SourcePolicyPlan{ExpectedRevision: policy.Revision, ExpectedGraphRevision: policy.GraphRevision, Enabled: []SourceTarget{{spec.ID, "rules", "phb"}, {spec.ID, "rules", "extra"}}}
	result, err := manager.SetSourcePolicy(ctx, plan)
	if err != nil || !result.Applied || result.RecoveryError != "" {
		t.Fatalf("apply = %+v,%v", result, err)
	}
	if _, err := manager.SetSourcePolicy(ctx, plan); !errors.Is(err, ErrConfigurationConflict) {
		t.Fatal("stale source plan applied", err)
	}
	content, err = manager.ContentRegistry(spec.ID, generation.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := content.Get("rules", "spell", "extra"); err != nil {
		t.Fatal(err)
	}
	policy, err = manager.RulesPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if policy.GraphRevision == plan.ExpectedGraphRevision {
		t.Fatal("browser graph did not change with sources")
	}
	plan.ExpectedRevision, plan.ExpectedGraphRevision = policy.Revision, policy.GraphRevision
	unchanged, err := manager.SetSourcePolicy(ctx, plan)
	if err != nil || len(unchanged.RestartedAddonIDs) != 0 {
		t.Fatalf("unchanged policy restarted add-ons: %+v,%v", unchanged, err)
	}
	// Installing a newer archive preserves reviewed choices and flags only new books.
	spec.Version = "1.1.0"
	spec.ExtraFiles["content/rules/new.json"] = []byte(`{"kind":"spell","id":"new-spell","name":"New spell","book":"new-book"}`)
	updated, err := manager.Stage(ctx, writeAddonPackage(t, spec))
	if err != nil {
		t.Fatal(err)
	}
	review, err := manager.PrepareActivationReview(ctx, spec.ID, updated.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	// A source change invalidates the package review as well as content cursors.
	plan.Enabled = []SourceTarget{{spec.ID, "rules", "phb"}}
	if _, err := manager.SetSourcePolicy(ctx, plan); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.ApproveActivationReview(ctx, review.ReviewID, []string{}); err == nil {
		t.Fatal("source changes did not invalidate the prepared package review")
	}
	before, _ := manager.Snapshot(ctx, spec.ID, 1)
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: spec.ID, GenerationID: updated.GenerationID, ExpectedStateRevision: before.State.Revision}); err != nil {
		t.Fatal(err)
	}
	policy, err = manager.RulesPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range policy.Sources {
		if source.ID == "extra" && (source.Enabled || source.Pending) {
			t.Fatal("update lost the reviewed disabled choice")
		}
		if source.ID == "new-book" && (source.Enabled || !source.Pending) {
			t.Fatal("new book was enabled or not flagged for review")
		}
	}
	if _, err := manager.SetSourcePolicy(ctx, SourcePolicyPlan{ExpectedRevision: policy.Revision, ExpectedGraphRevision: policy.GraphRevision, Enabled: []SourceTarget{}}); !errors.Is(err, ErrRulesetCompatibility) {
		t.Fatal("complete rules profile could be disabled", err)
	}
	replacementSpec := spec
	replacementSpec.ID = "replacement-rules"
	replacement, err := manager.Stage(ctx, writeAddonPackage(t, replacementSpec))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: replacementSpec.ID, GenerationID: replacement.GenerationID}); !errors.Is(err, ErrRulesetCompatibility) {
		t.Fatal("two defining packages became active", err)
	}
	snapshot, _ := manager.Snapshot(ctx, spec.ID, 1)
	if _, err := manager.Disable(ctx, DisablePlan{AddonID: spec.ID, ExpectedStateRevision: snapshot.State.Revision}); err != nil {
		t.Fatal(err)
	}
	locked, _ := manager.RulesPolicy(ctx)
	if locked.Ruleset == nil || locked.Ruleset.ID != "system-one" {
		t.Fatal("disable cleared the instance ruleset")
	}
	for _, supported := range [][]string{{"other"}, {"other", "system-one"}} {
		manifest := packageinspect.Manifest{ID: "extra-books", Name: "Extra books", Rules: &packageinspect.RulesDeclaration{Supports: supported}}
		err := manager.validateRulesCompatibility(ctx, manifest)
		if (err == nil) != (len(supported) == 2) {
			t.Fatalf("compatibility %v = %v", supported, err)
		}
	}
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: replacementSpec.ID, GenerationID: replacement.GenerationID}); err != nil {
		t.Fatal(err)
	}
	replaced, _ := manager.RulesPolicy(ctx)
	if replaced.Ruleset.ID != "system-one" || replaced.Ruleset.AddonID != replacementSpec.ID {
		t.Fatal("same-ruleset replacement did not retain the instance identity")
	}
}

func TestConfigurationKeepsAcceptedSelectionVisibleWhenAWorkerCannotRestart(t *testing.T) {
	ctx := context.Background()
	factory := &fakeRuntimeFactory{}
	manager, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), factory)
	for _, id := range []string{"engine-one", "engine-two"} {
		generation := stageServicePackage(t, manager, id, "1.0.0", "3.0.0")
		if _, err := manager.Activate(ctx, ActivationPlan{AddonID: id, GenerationID: generation.GenerationID, GrantedPermissionIDs: []string{"core.data.read"}}); err != nil {
			t.Fatal(err)
		}
	}
	consumer := stageConsumerPackage(t, manager, "sheets", "1.0.0")
	selections, _ := manager.ServiceSelections(ctx)
	factory.failVersions = map[string]error{"1.0.0": errors.New("fixture restart rejected")}
	result, err := manager.SetServiceSelection(ctx, ServiceSelectionPlan{ExpectedRevision: selections.Revision, ExpectedGraphRevision: selections.GraphRevision, ConsumerAddonID: "sheets", GenerationID: consumer.GenerationID, Contract: "dnd5e.rules-engine", ProviderAddonIDs: []string{"engine-two"}})
	if err != nil || !result.Applied || len(result.RecoveryResults) != 2 {
		t.Fatalf("result=%+v,%v", result, err)
	}
	for _, recovery := range result.RecoveryResults {
		if recovery.Error == "" {
			t.Fatal("worker failure was hidden")
		}
	}
	current, _ := manager.ServiceSelections(ctx)
	if current.Services[0].Resolution.Binding == nil || current.Services[0].Resolution.Binding.ProviderAddonIDs[0] != "engine-two" {
		t.Fatal("accepted binding was silently replaced after restart failure")
	}
}

func TestOperatorCanResolveAndClearAServiceSelectionWithRevisionGuards(t *testing.T) {
	ctx := context.Background()
	manager, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	for _, id := range []string{"engine-one", "engine-two"} {
		generation := stageServicePackage(t, manager, id, "1.0.0", "3.0.0")
		if _, err := manager.Activate(ctx, ActivationPlan{AddonID: id, GenerationID: generation.GenerationID, GrantedPermissionIDs: []string{"core.data.read"}}); err != nil {
			t.Fatal(err)
		}
	}
	consumer := stageConsumerPackage(t, manager, "sheets", "1.0.0")
	selections, err := manager.ServiceSelections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(selections.Services) != 1 || selections.Services[0].Resolution.Status != servicebroker.ResolutionAmbiguous {
		t.Fatalf("selections = %+v", selections)
	}
	plan := ServiceSelectionPlan{ExpectedRevision: selections.Revision, ExpectedGraphRevision: selections.GraphRevision, ConsumerAddonID: "sheets", GenerationID: consumer.GenerationID, Contract: "dnd5e.rules-engine", ProviderAddonIDs: []string{"engine-two"}}
	if _, err := manager.SetServiceSelection(ctx, plan); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetServiceSelection(ctx, plan); !errors.Is(err, ErrConfigurationConflict) {
		t.Fatal("stale selection accepted", err)
	}
	selections, err = manager.ServiceSelections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	row := selections.Services[0]
	if row.Resolution.Status != servicebroker.ResolutionResolved || row.Resolution.Binding.ProviderAddonIDs[0] != "engine-two" {
		t.Fatalf("selected = %+v", row)
	}
	plan.ExpectedRevision = selections.Revision
	plan.ExpectedGraphRevision = selections.GraphRevision
	plan.ExpectedBindingRevision = row.Resolution.Binding.Revision
	plan.Automatic = true
	plan.ProviderAddonIDs = []string{}
	if _, err := manager.SetServiceSelection(ctx, plan); err != nil {
		t.Fatal(err)
	}
	selections, err = manager.ServiceSelections(ctx)
	if err != nil || selections.Services[0].Resolution.Status != servicebroker.ResolutionAmbiguous {
		t.Fatalf("automatic selection = %+v,%v", selections, err)
	}
}
