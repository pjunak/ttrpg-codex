package packagemanager

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

func TestReviewedDisablePreservesDataPackagesGrantsAndOptionalConsumers(t *testing.T) {
	ctx := context.Background()
	db, directory, factory := testDatabase(t), filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{}
	manager, broker := testManager(t, db, directory, factory)
	provider := installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true, Permission: true, Contract: "example.rules", ContractVersion: "3.0.0"})
	installUninstallFixture(t, manager, packageSpec{ID: "required", Version: "1.0.0", Worker: true, ConsumeContract: "example.rules"})
	installUninstallFixture(t, manager, packageSpec{ID: "transitive", Version: "1.0.0", Worker: true, DependencyID: "required", DependencyRange: "^1.0.0"})
	installUninstallFixture(t, manager, packageSpec{ID: "optional", Version: "1.0.0", Worker: true, ConsumeContract: "example.rules", OptionalConsume: true})
	for _, query := range []string{
		`INSERT INTO addon_data_sets(addon_id,data_kind,data_id) VALUES ('provider','collection','notes')`,
		`INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at) VALUES ('provider','collection','notes','one',0,'{"text":"Keep me"}','1.0.0','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'2026-09-16T00:00:00Z','2026-09-16T00:00:00Z')`,
		`INSERT INTO addon_github_sources(addon_id,source_json,revision) VALUES ('provider','{"repo":"owner/repository"}',1)`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	review, err := manager.PrepareDisable(ctx, "provider")
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, target := range review.Targets {
		ids = append(ids, target.AddonID)
	}
	if !slices.Equal(ids, []string{"provider", "required", "transitive"}) || !slices.ContainsFunc(review.Effects, func(effect UninstallEffect) bool { return effect.AddonID == "optional" && !effect.Disabled }) {
		t.Fatalf("wrong impact: %+v", review)
	}
	beforeLog := len(factory.Log())
	result, err := manager.DisableReviewed(ctx, "provider", review.ReviewSHA256)
	if err != nil || !result.Applied || len(result.RecoveryResults) != 1 || result.RecoveryResults[0].AddonID != "optional" || !result.RecoveryResults[0].Recovered {
		t.Fatalf("disable = %+v, %v", result, err)
	}
	stopped := []string{}
	for _, entry := range factory.Log()[beforeLog:] {
		if strings.HasPrefix(entry, "stop:") {
			stopped = append(stopped, strings.Split(entry, ":")[1])
		}
	}
	if !slices.Equal(stopped, review.StoppedAddonIDs) || slices.Index(stopped, "transitive") > slices.Index(stopped, "required") || slices.Index(stopped, "required") > slices.Index(stopped, "provider") {
		t.Fatalf("stop order %v differs from review %+v", stopped, review)
	}
	for _, target := range review.Targets {
		snapshot, err := manager.Snapshot(ctx, target.AddonID, 2)
		if err != nil || snapshot.State.ActiveGenerationID != "" || snapshot.State.Revision != target.ExpectedStateRevision+1 || len(snapshot.Generations) != 1 {
			t.Fatalf("disabled state not retained: %+v, %v", snapshot, err)
		}
	}
	state, _ := manager.store.state(ctx, "provider")
	if !slices.Equal(state.GrantedPermissionIDs, []string{"core.data.read"}) {
		t.Fatal("grants removed")
	}
	var body string
	if err := db.QueryRow("SELECT body_json FROM addon_documents WHERE addon_id='provider'").Scan(&body); err != nil || body != `{"text":"Keep me"}` {
		t.Fatalf("authored data changed: %q %v", body, err)
	}
	var links int
	if err := db.QueryRow("SELECT COUNT(*) FROM addon_github_sources WHERE addon_id='provider' AND deleted=0").Scan(&links); err != nil || links != 1 {
		t.Fatal("GitHub source lost", err)
	}
	if _, err := os.Stat(filepath.Join(directory, "provider", "generations", provider.GenerationID, "package.zip")); err != nil {
		t.Fatal("saved package lost", err)
	}
	providers, _ := broker.ListProviders(ctx, "example.rules")
	for _, item := range providers {
		if item.ActiveGeneration != "" {
			t.Fatal("disabled provider still callable", item)
		}
	}
	if _, err := manager.DisableReviewed(ctx, "provider", review.ReviewSHA256); !errors.Is(err, ErrReviewStale) {
		t.Fatal("old confirmation replayed", err)
	}
	activation, err := manager.PrepareActivationReview(ctx, "provider", provider.GenerationID)
	if err != nil || len(activation.Proposal.Blockers) != 0 {
		t.Fatal("saved package could not be reviewed", err)
	}
	approved, err := manager.ApproveActivationReview(ctx, activation.ReviewID, []string{"core.data.read"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.ActivateReviewed(ctx, approved.ReviewID); err != nil {
		t.Fatal("reactivation failed", err)
	}
	required, _ := manager.store.state(ctx, "required")
	if required.ActiveGenerationID != "" {
		t.Fatal("dependent silently reactivated")
	}
}

func TestReviewedDisableRejectsChangedDependentsAndRollsBackAllWrites(t *testing.T) {
	ctx := context.Background()
	db, factory := testDatabase(t), &fakeRuntimeFactory{}
	manager, broker := testManager(t, db, filepath.Join(t.TempDir(), "packages"), factory)
	provider := installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true, Contract: "example.rules", ContractVersion: "3.0.0"})
	review, err := manager.PrepareDisable(ctx, "provider")
	if err != nil {
		t.Fatal(err)
	}
	dependent := installUninstallFixture(t, manager, packageSpec{ID: "required", Version: "1.0.0", Worker: true, ConsumeContract: "example.rules"})
	before := len(factory.Log())
	if _, err := manager.DisableReviewed(ctx, "provider", review.ReviewSHA256); !errors.Is(err, ErrReviewStale) {
		t.Fatal("new dependency not reviewed", err)
	}
	if len(factory.Log()) != before {
		t.Fatal("stale review stopped workers")
	}
	review, err = manager.PrepareDisable(ctx, "provider")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER reject_disable BEFORE UPDATE ON addon_package_states WHEN OLD.addon_id = 'required' AND NEW.active_generation_id IS NULL BEGIN SELECT RAISE(ABORT,'simulated disable failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DisableReviewed(ctx, "provider", review.ReviewSHA256); err == nil {
		t.Fatal("write failure hidden")
	}
	for _, generation := range []Generation{provider, dependent} {
		state, _ := manager.store.state(ctx, generation.AddonID)
		if state.ActiveGenerationID != generation.GenerationID || state.Revision != 1 {
			t.Fatalf("partial durable disable: %+v", state)
		}
		if _, exists := manager.runtimes[generation.AddonID]; !exists {
			t.Fatal("previous runtime not restored")
		}
	}
	assertProviderGeneration(t, broker, "example.rules", provider.GenerationID, "3.0.0")
}

type disableStopRuntime struct {
	Runtime
	stop func(context.Context) error
}

func (runtime disableStopRuntime) Shutdown(ctx context.Context) error {
	if err := runtime.Runtime.Shutdown(ctx); err != nil {
		return err
	}
	return runtime.stop(ctx)
}

func TestReviewedDisableStopFailureRestoresThePreviousGraph(t *testing.T) {
	ctx := context.Background()
	manager, broker := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	generation := installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true, Contract: "example.rules", ContractVersion: "3.0.0"})
	active := manager.runtimes["provider"]
	active.runtime = disableStopRuntime{Runtime: active.runtime, stop: func(context.Context) error { return errors.New("simulated stop failure") }}
	manager.runtimes["provider"] = active
	review, err := manager.PrepareDisable(ctx, "provider")
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.DisableReviewed(ctx, "provider", review.ReviewSHA256)
	if err == nil || result.Applied {
		t.Fatalf("failed stop applied: %+v %v", result, err)
	}
	state, _ := manager.store.state(ctx, "provider")
	if state.ActiveGenerationID != generation.GenerationID {
		t.Fatal("failed stop cleared durable state")
	}
	assertProviderGeneration(t, broker, "example.rules", generation.GenerationID, "3.0.0")
}

func TestReviewedDisableCompletesAfterDisconnectAndReportsRestartFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	factory := &fakeRuntimeFactory{failVersions: map[string]error{}}
	manager, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), factory)
	installUninstallFixture(t, manager, packageSpec{ID: "provider", Version: "1.0.0", Worker: true})
	installUninstallFixture(t, manager, packageSpec{ID: "remaining", Version: "1.1.0", Worker: true})
	active := manager.runtimes["provider"]
	active.runtime = disableStopRuntime{Runtime: active.runtime, stop: func(transition context.Context) error { cancel(); return transition.Err() }}
	manager.runtimes["provider"] = active
	review, err := manager.PrepareDisable(ctx, "provider")
	if err != nil {
		t.Fatal(err)
	}
	factory.failVersions["1.1.0"] = errors.New("simulated restart failure")
	result, err := manager.DisableReviewed(ctx, "provider", review.ReviewSHA256)
	if err != nil || !result.Applied || len(result.RecoveryResults) != 1 || result.RecoveryResults[0].Error == "" {
		t.Fatalf("outcome hidden: %+v %v", result, err)
	}
	state, _ := manager.store.state(context.Background(), "provider")
	if state.ActiveGenerationID != "" {
		t.Fatal("disabled package resurrected")
	}
}

func TestReviewedDisableKeepsRequiredConsumerUsingAnotherProvider(t *testing.T) {
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
	review, err := manager.PrepareDisable(ctx, "provider-a")
	if err != nil || len(review.Targets) != 1 {
		t.Fatalf("surviving binding disabled: %+v %v", review, err)
	}
	if _, err := manager.DisableReviewed(ctx, "provider-a", review.ReviewSHA256); err != nil {
		t.Fatal(err)
	}
	resolution, err := broker.Resolve(ctx, requirement)
	if err != nil || resolution.Status != servicebroker.ResolutionResolved || len(resolution.Providers) != 1 || resolution.Providers[0].AddonID != "provider-b" {
		t.Fatalf("selection changed: %+v %v", resolution, err)
	}
}

func TestReviewedDisableCanRecoverFromCorruptPackageWithoutStartingIt(t *testing.T) {
	ctx := context.Background()
	db, directory := testDatabase(t), filepath.Join(t.TempDir(), "packages")
	manager, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	generation := installUninstallFixture(t, manager, packageSpec{ID: "broken", Version: "1.0.0", Worker: true})
	if err := manager.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "broken", "generations", generation.GenerationID, "package.zip"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	recovered, _ := testManager(t, db, directory, &fakeRuntimeFactory{})
	results, err := recovered.Recover(ctx)
	if err != nil || len(results) != 1 || results[0].Recovered {
		t.Fatal("expected failed startup", err)
	}
	review, err := recovered.PrepareDisable(ctx, "broken")
	if err != nil || len(review.StoppedAddonIDs) != 0 || len(review.RestartedAddonIDs) != 0 {
		t.Fatalf("failed runtime review: %+v %v", review, err)
	}
	if result, err := recovered.DisableReviewed(ctx, "broken", review.ReviewSHA256); err != nil || !result.Applied {
		t.Fatalf("disable of corrupt package: %+v %v", result, err)
	}
	state, _ := recovered.store.state(ctx, "broken")
	if state.ActiveGenerationID != "" {
		t.Fatal("failed package stayed active")
	}
}
