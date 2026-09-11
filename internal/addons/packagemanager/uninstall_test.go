package packagemanager

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

func installUninstallFixture(t *testing.T, manager *Manager, spec packageSpec) Generation {
	t.Helper()
	ctx := context.Background()
	generation, err := manager.Stage(ctx, writeAddonPackage(t, spec))
	if err != nil {
		t.Fatal(err)
	}
	state, err := manager.store.state(ctx, spec.ID)
	if err != nil {
		t.Fatal(err)
	}
	grants := []string{}
	if spec.Permission {
		grants = append(grants, "core.data.read")
	}
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: spec.ID, GenerationID: generation.GenerationID, ExpectedStateRevision: state.Revision, GrantedPermissionIDs: grants}); err != nil {
		t.Fatal(err)
	}
	return generation
}

func TestUninstallRetainsDataAndDisablesRequiredDependents(t *testing.T) {
	ctx := context.Background()
	db, directory, factory := testDatabase(t), filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{}
	manager, broker := testManager(t, db, directory, factory)
	providerSpec := packageSpec{ID: "provider", Version: "1.0.0", Worker: true, Permission: true, Contract: "example.rules", ContractVersion: "3.0.0"}
	provider := installUninstallFixture(t, manager, providerSpec)
	installUninstallFixture(t, manager, packageSpec{ID: "required", Version: "1.0.0", Worker: true, ConsumeContract: "example.rules"})
	installUninstallFixture(t, manager, packageSpec{ID: "transitive", Version: "1.0.0", Worker: true, DependencyID: "required", DependencyRange: "^1.0.0"})
	installUninstallFixture(t, manager, packageSpec{ID: "optional", Version: "1.0.0", Worker: true, ConsumeContract: "example.rules", OptionalConsume: true})
	requirement := servicebroker.Requirement{ConsumerAddonID: "optional", Contract: "example.rules", Range: "^3.0.0", Cardinality: servicebroker.CardinalityOne, Selection: servicebroker.SelectionOperator, Scope: servicebroker.GlobalScope()}
	if _, err := broker.SetBinding(ctx, requirement, []string{"provider"}, 0); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO addon_data_sets(addon_id,data_kind,data_id) VALUES ('provider','collection','notes')`,
		`INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at) VALUES ('provider','collection','notes','one',0,'{"text":"Keep me"}','1.0.0','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'2026-09-11T00:00:00Z','2026-09-11T00:00:00Z')`,
		`INSERT INTO addon_github_sources(addon_id,source_json,revision) VALUES ('provider','{"repo":"owner/repository"}',1)`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	review, err := manager.PrepareUninstall(ctx, "provider")
	if err != nil {
		t.Fatal(err)
	}
	if !review.UnlinksSource || len(review.RetainedData) != 1 || review.RetainedData[0].Documents != 1 {
		t.Fatalf("review = %+v", review)
	}
	disabled := []string{}
	for _, effect := range review.Effects {
		if effect.Disabled {
			disabled = append(disabled, effect.AddonID)
		}
	}
	if !slices.Equal(disabled, []string{"required", "transitive"}) {
		t.Fatalf("disabled = %v", disabled)
	}
	beforeLog := len(factory.Log())
	result, err := manager.Uninstall(ctx, "provider", review.ReviewSHA256)
	if err != nil || !result.Applied {
		t.Fatalf("uninstall = %+v, %v", result, err)
	}
	if len(result.RecoveryResults) != 1 || result.RecoveryResults[0].AddonID != "optional" || !result.RecoveryResults[0].Recovered {
		t.Fatalf("recovery = %+v", result)
	}
	log := factory.Log()[beforeLog:]
	if slices.Index(log, "stop:provider:"+provider.GenerationID) < slices.IndexFunc(log, func(item string) bool { return len(item) > 14 && item[:14] == "stop:required:" }) {
		t.Fatalf("provider stopped before consumer: %v", log)
	}
	ids, _ := manager.InstalledAddonIDs(ctx)
	if slices.Contains(ids, "provider") || len(ids) != 3 {
		t.Fatalf("inventory = %v", ids)
	}
	if _, err := manager.Snapshot(ctx, "provider", 1); !errors.Is(err, ErrGenerationNotFound) {
		t.Fatalf("removed snapshot = %v", err)
	}
	state, _ := manager.store.state(ctx, "provider")
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: "provider", GenerationID: provider.GenerationID, ExpectedStateRevision: state.Revision}); !errors.Is(err, ErrGenerationNotFound) {
		t.Fatalf("removed generation activated: %v", err)
	}
	var body string
	if err := db.QueryRow(`SELECT body_json FROM addon_documents WHERE addon_id='provider'`).Scan(&body); err != nil || body != `{"text":"Keep me"}` {
		t.Fatalf("retained document = %s, %v", body, err)
	}
	var linked int
	if err := db.QueryRow(`SELECT COUNT(*) FROM addon_github_sources WHERE addon_id='provider' AND deleted=0`).Scan(&linked); err != nil || linked != 0 {
		t.Fatalf("source link = %d, %v", linked, err)
	}
	if _, err := os.Stat(filepath.Join(directory, "provider", "generations", provider.GenerationID, "package.zip")); err != nil {
		t.Fatal("recovery archive lost", err)
	}
	providers, _ := broker.ListProviders(ctx, "example.rules")
	if len(providers) != 0 {
		t.Fatal("provider remained registered", providers)
	}
	resolution, _ := broker.Resolve(ctx, requirement)
	if resolution.Status != servicebroker.ResolutionStale {
		t.Fatalf("explicit selection silently changed: %+v", resolution)
	}
	retry, err := manager.Uninstall(ctx, "provider", review.ReviewSHA256)
	if err != nil || !retry.AlreadyRemoved {
		t.Fatalf("retry = %+v,%v", retry, err)
	}
	if _, err := manager.Uninstall(ctx, "provider", "different"); !errors.Is(err, ErrReviewStale) {
		t.Fatal("wrong retry accepted", err)
	}
	if err := manager.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	recovered, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	results, err := recovered.Recover(ctx)
	if err != nil || len(results) != 1 || results[0].AddonID != "optional" {
		t.Fatalf("restart resurrected removal: %+v,%v", results, err)
	}
	restaged, err := recovered.Stage(ctx, writeAddonPackage(t, providerSpec))
	if err != nil || restaged.GenerationID != provider.GenerationID {
		t.Fatalf("reinstall = %+v,%v", restaged, err)
	}
	recovered.dataLifecycle = &fakeDataLifecycle{issues: []datalifecycle.Issue{{Code: "RETAINED_DATA", Message: "incompatible retained data"}}}
	activation, err := recovered.PrepareActivationReview(ctx, "provider", restaged.GenerationID)
	if err != nil || !slices.ContainsFunc(activation.Proposal.Blockers, func(item ReviewBlocker) bool { return item.Code == "RETAINED_DATA" }) {
		t.Fatalf("retained data bypassed review: %+v,%v", activation, err)
	}
	if len(activation.Proposal.PreviouslyGrantedPermissionIDs) != 0 {
		t.Fatal("uninstall retained activation grants")
	}
}

func TestUninstallReviewRejectsStagingChangesAndRollsBackFailedSave(t *testing.T) {
	ctx := context.Background()
	db := testDatabase(t)
	manager, broker := testManager(t, db, filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	generation := installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true, Contract: "example.rules", ContractVersion: "3.0.0"})
	review, err := manager.PrepareUninstall(ctx, "provider")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Stage(ctx, writeAddonPackage(t, packageSpec{ID: "provider", Version: "1.1.0"})); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Uninstall(ctx, "provider", review.ReviewSHA256); !errors.Is(err, ErrReviewStale) {
		t.Fatal("stale removal accepted", err)
	}
	review, err = manager.PrepareUninstall(ctx, "provider")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER reject_uninstall BEFORE INSERT ON addon_package_uninstalls BEGIN SELECT RAISE(ABORT,'simulated write failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Uninstall(ctx, "provider", review.ReviewSHA256); err == nil {
		t.Fatal("expected failed save")
	}
	snapshot, err := manager.Snapshot(ctx, "provider", 1)
	if err != nil || snapshot.State.ActiveGenerationID != generation.GenerationID {
		t.Fatalf("failed uninstall lost installation: %+v,%v", snapshot, err)
	}
	assertProviderGeneration(t, broker, "example.rules", generation.GenerationID, "3.0.0")
}

func TestUninstallCorruptRulesPackageKeepsInstanceRuleset(t *testing.T) {
	ctx := context.Background()
	db, directory := testDatabase(t), filepath.Join(t.TempDir(), "packages")
	manager, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	rules := &packageinspect.RulesDeclaration{Supports: []string{"system-one"}, Defines: &packageinspect.RulesetDefinition{ID: "system-one", Name: "System One", Contract: "example.rules", ContentSet: "rules", RecordKind: "ruleset", RecordID: "system-one"}}
	generation := installUninstallFixture(t, manager, packageSpec{ID: "rules", Version: "1.0.0", Contract: "example.rules", ContractVersion: "3.0.0", ContentService: true, Rules: rules,
		ExtraFiles: map[string][]byte{"content/rules/profile.json": []byte(`{"kind":"ruleset","id":"system-one","name":"System One","book":"core"}`)}})
	if err := manager.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	goodArchive, err := os.ReadFile(filepath.Join(directory, "rules", "generations", generation.GenerationID, "package.zip"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "rules", "generations", generation.GenerationID, "package.zip"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	manager, _ = testManager(t, db, directory, &fakeRuntimeFactory{})
	results, err := manager.Recover(ctx)
	if err != nil || len(results) != 1 || results[0].Recovered {
		t.Fatalf("expected failed recovery: %+v,%v", results, err)
	}
	review, err := manager.PrepareUninstall(ctx, "rules")
	if err != nil || review.RulesetName != "System One" {
		t.Fatalf("failed package removal review: %+v,%v", review, err)
	}
	if _, err := manager.Uninstall(ctx, "rules", review.ReviewSHA256); err != nil {
		t.Fatal(err)
	}
	policy, err := manager.RulesPolicy(ctx)
	if err != nil || policy.Ruleset == nil || policy.Ruleset.ID != "system-one" {
		t.Fatal("instance ruleset lost", policy, err)
	}
	reinstalled, err := manager.StageArchive(ctx, bytes.NewReader(goodArchive))
	if err != nil || reinstalled.GenerationID != generation.GenerationID {
		t.Fatalf("retired corrupt generation could not be repaired: %+v,%v", reinstalled, err)
	}
	retired, err := filepath.Glob(filepath.Join(directory, "rules", "retired", "*", "package.zip"))
	if err != nil || len(retired) != 1 {
		t.Fatalf("original corrupt bytes were not retained: %v,%v", retired, err)
	}
	original, err := os.ReadFile(retired[0])
	if err != nil || string(original) != "corrupt" {
		t.Fatalf("original archive changed: %q,%v", original, err)
	}
}

func TestUninstallKeepsARequiredConsumerBoundToAnotherProvider(t *testing.T) {
	ctx := context.Background()
	manager, broker := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	for _, id := range []string{"provider-a", "provider-b"} {
		installUninstallFixture(t, manager, packageSpec{ID: id, Version: "1.0.0", Worker: true, Contract: "example.rules", ContractVersion: "3.0.0"})
	}
	requirement := servicebroker.Requirement{ConsumerAddonID: "consumer", Contract: "example.rules", Range: "^3.0.0", Cardinality: servicebroker.CardinalityOne, Selection: servicebroker.SelectionOperator, Required: true, Scope: servicebroker.GlobalScope()}
	if _, err := broker.SetBinding(ctx, requirement, []string{"provider-b"}, 0); err != nil {
		t.Fatal(err)
	}
	installUninstallFixture(t, manager, packageSpec{ID: "consumer", Version: "1.0.0", Worker: true, ConsumeContract: "example.rules"})
	review, err := manager.PrepareUninstall(ctx, "provider-a")
	if err != nil {
		t.Fatal(err)
	}
	if slices.ContainsFunc(review.Effects, func(effect UninstallEffect) bool { return effect.Disabled }) {
		t.Fatalf("unrelated required binding disabled: %+v", review)
	}
	if _, err := manager.Uninstall(ctx, "provider-a", review.ReviewSHA256); err != nil {
		t.Fatal(err)
	}
	resolution, err := broker.Resolve(ctx, requirement)
	if err != nil || resolution.Status != servicebroker.ResolutionResolved || len(resolution.Providers) != 1 || resolution.Providers[0].AddonID != "provider-b" {
		t.Fatalf("surviving connection = %+v,%v", resolution, err)
	}
}

func TestUninstallReportsRecoveryFailureWithoutResurrectingPackage(t *testing.T) {
	ctx := context.Background()
	factory := &fakeRuntimeFactory{failVersions: map[string]error{}}
	manager, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), factory)
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	installUninstallFixture(t, manager, packageSpec{ID: "remaining", Version: "1.1.0", Worker: true})
	review, err := manager.PrepareUninstall(ctx, "provider")
	if err != nil {
		t.Fatal(err)
	}
	factory.failVersions["1.1.0"] = errors.New("simulated restart failure")
	result, err := manager.Uninstall(ctx, "provider", review.ReviewSHA256)
	if err != nil || !result.Applied || len(result.RecoveryResults) != 1 || result.RecoveryResults[0].Error == "" {
		t.Fatalf("failure hidden: %+v,%v", result, err)
	}
	if _, err := manager.Snapshot(ctx, "provider", 1); !errors.Is(err, ErrGenerationNotFound) {
		t.Fatal("removed package resurrected", err)
	}
}
