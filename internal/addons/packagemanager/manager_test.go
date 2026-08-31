package packagemanager

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/requestcontext"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestStagePublishesContentAddressedGenerationWithoutActivation(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	packageDirectory := filepath.Join(t.TempDir(), "packages")
	manager, broker := testManager(t, db, packageDirectory, &fakeRuntimeFactory{})
	archive := writeAddonPackage(t, packageSpec{ID: "notes-addon", Version: "1.0.0"})
	generation, err := manager.Stage(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	if generation.GenerationID != generation.ArchiveSHA256 || len(generation.GenerationID) != 64 {
		t.Fatalf("generation is not content addressed: %+v", generation)
	}
	if _, err := os.Stat(filepath.Join(
		packageDirectory, "notes-addon", "generations", generation.GenerationID, "root", "addon.json",
	)); err != nil {
		t.Fatalf("published generation missing: %v", err)
	}
	snapshot, err := manager.Snapshot(context.Background(), "notes-addon", 20)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.State.Revision != 0 || snapshot.State.ActiveGenerationID != "" ||
		len(snapshot.Generations) != 1 || len(snapshot.Events) != 1 || snapshot.Events[0].Kind != "staged" {
		t.Fatalf("staging changed authority or produced incomplete diagnostics: %+v", snapshot)
	}
	providers, err := broker.ListProviders(context.Background(), "codex.notes")
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 0 {
		t.Fatalf("staging published providers: %+v", providers)
	}
	stagedAgain, err := manager.Stage(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	if stagedAgain.GenerationID != generation.GenerationID {
		t.Fatalf("idempotent stage changed generation: %+v", stagedAgain)
	}
	snapshot, err = manager.Snapshot(context.Background(), "notes-addon", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Generations) != 1 || len(snapshot.Events) != 1 {
		t.Fatalf("idempotent stage duplicated durable records: %+v", snapshot)
	}
}

func TestActivateUpdateAndRollbackUseExactReviewedGenerations(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	factory := &fakeRuntimeFactory{}
	manager, broker := testManager(t, db, filepath.Join(t.TempDir(), "packages"), factory)
	first := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	firstResult, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: first.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if firstResult.State.Revision != 1 || firstResult.State.ActiveGenerationID != first.GenerationID {
		t.Fatalf("first activation state = %+v", firstResult.State)
	}
	assertProviderGeneration(t, broker, "dnd5e.rules-engine", first.GenerationID, "3.1.0")
	assertServiceCall(t, broker, "sheet-addon", "dnd5e.rules-engine", "^3.0.0")

	second := stageServicePackage(t, manager, "engine-addon", "2.0.0", "3.2.0")
	secondResult, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: second.GenerationID,
		ExpectedStateRevision: 1, GrantedPermissionIDs: []string{"core.data.read"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if secondResult.State.Revision != 2 || secondResult.PreviousGenerationID != first.GenerationID {
		t.Fatalf("update result = %+v", secondResult)
	}
	assertProviderGeneration(t, broker, "dnd5e.rules-engine", second.GenerationID, "3.2.0")

	rollback, err := manager.Rollback(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: first.GenerationID,
		ExpectedStateRevision: 2, GrantedPermissionIDs: []string{"core.data.read"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rollback.State.Revision != 3 || rollback.State.ActiveGenerationID != first.GenerationID ||
		rollback.PreviousGenerationID != second.GenerationID {
		t.Fatalf("rollback result = %+v", rollback)
	}
	assertProviderGeneration(t, broker, "dnd5e.rules-engine", first.GenerationID, "3.1.0")

	wantLog := []string{
		"start:engine-addon:" + first.GenerationID,
		"start:engine-addon:" + second.GenerationID,
		"stop:engine-addon:" + first.GenerationID,
		"start:engine-addon:" + first.GenerationID,
		"stop:engine-addon:" + second.GenerationID,
	}
	if got := factory.Log(); !reflect.DeepEqual(got, wantLog) {
		t.Fatalf("runtime handoff order =\n%v\nwant\n%v", got, wantLog)
	}
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: second.GenerationID,
		ExpectedStateRevision: 2, GrantedPermissionIDs: []string{"core.data.read"},
	}); !errors.Is(err, ErrStaleActivationPlan) {
		t.Fatalf("stale activation error = %v", err)
	}
}

func TestActivationReviewIsDurableApprovedAuthorityConsumedWithSwitch(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	manager, broker := testManager(t, db, filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	generation := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	review, err := manager.PrepareActivationReview(context.Background(), "engine-addon", generation.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if review.Status != ReviewPrepared || review.ProposalSHA256 == "" ||
		review.Proposal.ExpectedStateRevision != 0 || len(review.Proposal.Blockers) != 0 {
		t.Fatalf("prepared review = %+v", review)
	}
	if !reflect.DeepEqual(review.Proposal.Changes.Permissions.Added, []string{"core.data.read"}) ||
		!reflect.DeepEqual(review.Proposal.RequiredPermissionIDs, []string{"core.data.read"}) ||
		len(review.Proposal.SuggestedPermissionIDs) != 0 {
		t.Fatalf("permission review = %+v", review.Proposal)
	}
	if _, err := manager.ApproveActivationReview(context.Background(), review.ReviewID, nil); !errors.Is(err, ErrPermission) {
		t.Fatalf("missing required grant error = %v", err)
	}
	approved, err := manager.ApproveActivationReview(
		context.Background(), review.ReviewID, []string{"core.data.read"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != ReviewApproved || approved.ApprovalSHA256 == "" || approved.ApprovedAt == nil {
		t.Fatalf("approved review = %+v", approved)
	}
	retriedApproval, err := manager.ApproveActivationReview(
		context.Background(), review.ReviewID, []string{"core.data.read"},
	)
	if err != nil || retriedApproval.ApprovalSHA256 != approved.ApprovalSHA256 {
		t.Fatalf("idempotent approval = %+v, %v", retriedApproval, err)
	}
	result, err := manager.ActivateReviewed(context.Background(), review.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	if result.ReviewID != review.ReviewID || result.State.Revision != 1 ||
		result.State.ActiveGenerationID != generation.GenerationID {
		t.Fatalf("reviewed activation result = %+v", result)
	}
	consumed, err := manager.GetActivationReview(context.Background(), review.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	if consumed.Status != ReviewConsumed || consumed.ConsumedAt == nil {
		t.Fatalf("consumed review = %+v", consumed)
	}
	retriedActivation, err := manager.ActivateReviewed(context.Background(), review.ReviewID)
	if err != nil || retriedActivation.State.Revision != result.State.Revision {
		t.Fatalf("idempotent reviewed activation = %+v, %v", retriedActivation, err)
	}
	assertProviderGeneration(t, broker, "dnd5e.rules-engine", generation.GenerationID, "3.1.0")
}

func TestActivationReviewBecomesStaleWhenStateChanges(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	manager, _ := testManager(t, db, filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	first := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	second := stageServicePackage(t, manager, "engine-addon", "2.0.0", "3.2.0")
	review, err := manager.PrepareActivationReview(context.Background(), "engine-addon", first.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: second.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.ApproveActivationReview(
		context.Background(), review.ReviewID, []string{"core.data.read"},
	); !errors.Is(err, ErrReviewStale) {
		t.Fatalf("stale review approval error = %v", err)
	}
}

func TestReloadKeepsGenerationHandlesValidAndDisableRevokesRouting(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	factory := &fakeRuntimeFactory{}
	manager, broker := testManager(t, db, filepath.Join(t.TempDir(), "packages"), factory)
	generation := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: generation.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	handle, err := broker.ConnectOne(context.Background(), servicebroker.Requirement{
		ConsumerAddonID: "sheet-addon", Contract: "dnd5e.rules-engine", Range: "^3.0.0",
		Cardinality: servicebroker.CardinalityOne, Selection: servicebroker.SelectionOperator,
		Scope: servicebroker.GlobalScope(),
	})
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := manager.Reload(context.Background(), "engine-addon", 1)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.State.Revision != 2 || reloaded.State.ActiveGenerationID != generation.GenerationID {
		t.Fatalf("reload result = %+v", reloaded)
	}
	result, err := broker.Call(context.Background(), handle, servicebroker.MethodCall{
		Method: "evaluate-character", Params: map[string]any{"value": 4},
		Context: servicebroker.CallContext{
			Deadline: time.Now().Add(time.Second), Actor: workerrpc.Actor{Role: "system"},
		},
	})
	if err != nil || string(result) != `{"result":8}` {
		t.Fatalf("pre-reload handle after reload = %s, %v", result, err)
	}
	disabled, err := manager.Disable(context.Background(), DisablePlan{
		AddonID: "engine-addon", ExpectedStateRevision: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if disabled.State.Revision != 3 || disabled.State.ActiveGenerationID != "" ||
		!reflect.DeepEqual(disabled.State.GrantedPermissionIDs, []string{"core.data.read"}) {
		t.Fatalf("disable result = %+v", disabled)
	}
	if _, err := broker.Call(context.Background(), handle, servicebroker.MethodCall{
		Method: "evaluate-character", Params: map[string]any{"value": 4},
		Context: servicebroker.CallContext{
			Deadline: time.Now().Add(time.Second), Actor: workerrpc.Actor{Role: "system"},
		},
	}); !errors.Is(err, servicebroker.ErrStaleBinding) {
		t.Fatalf("disabled handle error = %v", err)
	}
	wantLog := []string{
		"start:engine-addon:" + generation.GenerationID,
		"start:engine-addon:" + generation.GenerationID,
		"stop:engine-addon:" + generation.GenerationID,
		"stop:engine-addon:" + generation.GenerationID,
	}
	if got := factory.Log(); !reflect.DeepEqual(got, wantLog) {
		t.Fatalf("reload/disable runtime order = %v, want %v", got, wantLog)
	}
	results, err := manager.Recover(context.Background())
	if err != nil || len(results) != 0 {
		t.Fatalf("disabled recovery = %+v, %v", results, err)
	}
}

func TestDisableWorksAfterRuntimeShutdownWithoutRecovery(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	manager, _ := testManager(t, db, filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	generation := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: generation.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	disabled, err := manager.Disable(context.Background(), DisablePlan{
		AddonID: "engine-addon", ExpectedStateRevision: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if disabled.State.ActiveGenerationID != "" || disabled.State.Revision != 2 {
		t.Fatalf("unrecovered disable result = %+v", disabled)
	}
}

func TestFailedUpdateKeepsPreviousGenerationCallable(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	factory := &fakeRuntimeFactory{failVersions: map[string]error{"2.0.0": errors.New("worker refused startup")}}
	manager, broker := testManager(t, db, filepath.Join(t.TempDir(), "packages"), factory)
	first := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: first.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	second := stageServicePackage(t, manager, "engine-addon", "2.0.0", "3.2.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: second.GenerationID,
		ExpectedStateRevision: 1, GrantedPermissionIDs: []string{"core.data.read"},
	}); !errors.Is(err, ErrActivationFailed) {
		t.Fatalf("failed update error = %v", err)
	}
	snapshot, err := manager.Snapshot(context.Background(), "engine-addon", 20)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.State.ActiveGenerationID != first.GenerationID || snapshot.State.Revision != 1 {
		t.Fatalf("failed update changed durable active pointer: %+v", snapshot.State)
	}
	assertProviderGeneration(t, broker, "dnd5e.rules-engine", first.GenerationID, "3.1.0")
	assertServiceCall(t, broker, "sheet-addon", "dnd5e.rules-engine", "^3.0.0")
	if got := factory.Log(); containsLog(got, "stop:engine-addon:"+first.GenerationID) {
		t.Fatalf("failed update stopped previous runtime: %v", got)
	}
}

func TestActivationRejectsMutatedExtractedGeneration(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	packageDirectory := filepath.Join(t.TempDir(), "packages")
	factory := &fakeRuntimeFactory{}
	manager, _ := testManager(t, db, packageDirectory, factory)
	generation := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	worker := filepath.Join(
		packageDirectory, "engine-addon", "generations", generation.GenerationID,
		"root", "worker", "windows-amd64", "addon.exe",
	)
	if err := os.WriteFile(worker, []byte("mutated worker"), 0o750); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: generation.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); !errors.Is(err, ErrInvalidPackage) {
		t.Fatalf("mutated generation activation error = %v", err)
	}
	if got := factory.Log(); len(got) != 0 {
		t.Fatalf("mutated generation started a runtime: %v", got)
	}
}

func TestRecoveryStartsRequiredProvidersBeforeConsumers(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	packageDirectory := filepath.Join(t.TempDir(), "packages")
	initialFactory := &fakeRuntimeFactory{}
	manager, _ := testManager(t, db, packageDirectory, initialFactory)
	provider := stageServicePackage(t, manager, "z-provider", "1.0.0", "3.1.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "z-provider", GenerationID: provider.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	consumer := stageConsumerPackage(t, manager, "a-consumer", "1.0.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "a-consumer", GenerationID: consumer.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{},
	}); err != nil {
		t.Fatal(err)
	}
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	recoveryFactory := &fakeRuntimeFactory{}
	recovered, broker := testManager(t, db, packageDirectory, recoveryFactory)
	results, err := recovered.Recover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || !results[0].Recovered || !results[1].Recovered {
		t.Fatalf("recovery results = %+v", results)
	}
	wantStarts := []string{
		"start:z-provider:" + provider.GenerationID,
		"start:a-consumer:" + consumer.GenerationID,
	}
	if got := recoveryFactory.Log(); !reflect.DeepEqual(got, wantStarts) {
		t.Fatalf("recovery order = %v, want %v", got, wantStarts)
	}
	specs := recoveryFactory.Specs()
	if len(specs) != 2 || len(specs[1].BoundServices) != 1 || specs[1].BoundServices[0].ProviderAddonID != "z-provider" {
		t.Fatalf("consumer recovered without exact service handle: %+v", specs)
	}
	assertProviderGeneration(t, broker, "dnd5e.rules-engine", provider.GenerationID, "3.1.0")
}

func TestRecoveryPrefersAvailableOptionalProvider(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	packageDirectory := filepath.Join(t.TempDir(), "packages")
	manager, _ := testManager(t, db, packageDirectory, &fakeRuntimeFactory{})
	provider := stageServicePackage(t, manager, "z-provider", "1.0.0", "3.1.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "z-provider", GenerationID: provider.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	archive := writeAddonPackage(t, packageSpec{
		ID: "a-consumer", Version: "1.0.0", ConsumeContract: "dnd5e.rules-engine",
		OptionalConsume: true, Worker: true,
	})
	consumer, err := manager.Stage(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "a-consumer", GenerationID: consumer.GenerationID, ExpectedStateRevision: 0,
	}); err != nil {
		t.Fatal(err)
	}
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	factory := &fakeRuntimeFactory{}
	recovered, _ := testManager(t, db, packageDirectory, factory)
	results, err := recovered.Recover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || !results[0].Recovered || !results[1].Recovered {
		t.Fatalf("recovery results = %+v", results)
	}
	wantStarts := []string{
		"start:z-provider:" + provider.GenerationID,
		"start:a-consumer:" + consumer.GenerationID,
	}
	if got := factory.Log(); !reflect.DeepEqual(got, wantStarts) {
		t.Fatalf("optional recovery order = %v, want %v", got, wantStarts)
	}
	if specs := factory.Specs(); len(specs) != 2 || len(specs[1].BoundServices) != 1 {
		t.Fatalf("optional consumer did not bind available provider: %+v", specs)
	}
}

func TestRecoveryAllowsOptionalConsumerAfterProviderFailure(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	packageDirectory := filepath.Join(t.TempDir(), "packages")
	manager, _ := testManager(t, db, packageDirectory, &fakeRuntimeFactory{})
	provider := stageServicePackage(t, manager, "z-provider", "1.0.0", "3.1.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "z-provider", GenerationID: provider.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	archive := writeAddonPackage(t, packageSpec{
		ID: "a-consumer", Version: "1.0.0", ConsumeContract: "dnd5e.rules-engine",
		OptionalConsume: true, Worker: true,
	})
	consumer, err := manager.Stage(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "a-consumer", GenerationID: consumer.GenerationID, ExpectedStateRevision: 0,
	}); err != nil {
		t.Fatal(err)
	}
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	providerWorker := filepath.Join(
		packageDirectory, "z-provider", "generations", provider.GenerationID,
		"root", "worker", "windows-amd64", "addon.exe",
	)
	if err := os.WriteFile(providerWorker, []byte("corrupt provider"), 0o750); err != nil {
		t.Fatal(err)
	}

	factory := &fakeRuntimeFactory{}
	recovered, _ := testManager(t, db, packageDirectory, factory)
	results, err := recovered.Recover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || !results[0].Recovered || results[1].Recovered {
		t.Fatalf("recovery results = %+v", results)
	}
	wantLog := []string{"start:a-consumer:" + consumer.GenerationID}
	if got := factory.Log(); !reflect.DeepEqual(got, wantLog) {
		t.Fatalf("standalone recovery log = %v, want %v", got, wantLog)
	}
	if specs := factory.Specs(); len(specs) != 1 || len(specs[0].BoundServices) != 0 {
		t.Fatalf("optional consumer retained failed provider binding: %+v", specs)
	}
}

func TestProviderUpdateRequiresCoordinatedConsumerRestart(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	manager, broker := testManager(t, db, filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	provider := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: provider.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	consumer := stageConsumerPackage(t, manager, "sheet-addon", "1.0.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "sheet-addon", GenerationID: consumer.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{},
	}); err != nil {
		t.Fatal(err)
	}
	next := stageServicePackage(t, manager, "engine-addon", "2.0.0", "3.2.0")
	review, err := manager.PrepareActivationReview(context.Background(), "engine-addon", next.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(review.Proposal.AffectedAddonIDs, []string{"sheet-addon"}) ||
		len(review.Proposal.Blockers) == 0 || review.Proposal.Blockers[0].Code != "ACTIVATION_COHORT_REQUIRED" {
		t.Fatalf("dependent activation review = %+v", review.Proposal)
	}
	if _, err := manager.ApproveActivationReview(
		context.Background(), review.ReviewID, []string{"core.data.read"},
	); !errors.Is(err, ErrReviewBlocked) {
		t.Fatalf("blocked review approval error = %v", err)
	}
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: next.GenerationID,
		ExpectedStateRevision: 1, GrantedPermissionIDs: []string{"core.data.read"},
	}); !errors.Is(err, ErrActivationCohort) {
		t.Fatalf("provider update error = %v", err)
	}
	assertProviderGeneration(t, broker, "dnd5e.rules-engine", provider.GenerationID, "3.1.0")
	assertServiceCall(t, broker, "external-consumer", "dnd5e.rules-engine", "^3.0.0")
}

func TestRecoveryNeverFallsBackFromCorruptActiveGeneration(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	packageDirectory := filepath.Join(t.TempDir(), "packages")
	manager, _ := testManager(t, db, packageDirectory, &fakeRuntimeFactory{})
	first := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: first.GenerationID,
		ExpectedStateRevision: 0, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	second := stageServicePackage(t, manager, "engine-addon", "2.0.0", "3.2.0")
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: second.GenerationID,
		ExpectedStateRevision: 1, GrantedPermissionIDs: []string{"core.data.read"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(
		packageDirectory, "engine-addon", "generations", second.GenerationID,
		"root", "worker", "windows-amd64", "addon.exe",
	)
	if err := os.WriteFile(worker, []byte("corrupt active worker"), 0o750); err != nil {
		t.Fatal(err)
	}

	factory := &fakeRuntimeFactory{}
	recovered, _ := testManager(t, db, packageDirectory, factory)
	results, err := recovered.Recover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Recovered || results[0].GenerationID != second.GenerationID || results[0].Error == "" {
		t.Fatalf("recovery result = %+v", results)
	}
	if got := factory.Log(); len(got) != 0 {
		t.Fatalf("recovery silently started another generation: %v", got)
	}
	snapshot, err := recovered.Snapshot(context.Background(), "engine-addon", 20)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.State.ActiveGenerationID != second.GenerationID || snapshot.State.Revision != 2 {
		t.Fatalf("recovery rewrote durable active generation: %+v", snapshot.State)
	}
}

func TestActivationFailsClosedForUnplannedSelfServiceBinding(t *testing.T) {
	t.Parallel()

	db := testDatabase(t)
	manager, _ := testManager(t, db, filepath.Join(t.TempDir(), "packages"), &fakeRuntimeFactory{})
	archive := writeAddonPackage(t, packageSpec{
		ID: "engine-addon", Version: "1.0.0", Contract: "dnd5e.rules-engine",
		ContractVersion: "3.1.0", ConsumeContract: "dnd5e.rules-engine", Worker: true,
	})
	generation, err := manager.Stage(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(context.Background(), ActivationPlan{
		AddonID: "engine-addon", GenerationID: generation.GenerationID, ExpectedStateRevision: 0,
	}); !errors.Is(err, ErrServiceResolution) {
		t.Fatalf("self-service activation error = %v", err)
	}
}

type packageSpec struct {
	ID              string
	Version         string
	Contract        string
	ContractVersion string
	ConsumeContract string
	OptionalConsume bool
	Worker          bool
	Permission      bool
}

func stageServicePackage(t *testing.T, manager *Manager, addonID, version, contractVersion string) Generation {
	t.Helper()
	archive := writeAddonPackage(t, packageSpec{
		ID: addonID, Version: version, Contract: "dnd5e.rules-engine",
		ContractVersion: contractVersion, Worker: true, Permission: true,
	})
	generation, err := manager.Stage(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	return generation
}

func stageConsumerPackage(t *testing.T, manager *Manager, addonID, version string) Generation {
	t.Helper()
	archive := writeAddonPackage(t, packageSpec{
		ID: addonID, Version: version, ConsumeContract: "dnd5e.rules-engine", Worker: true,
	})
	generation, err := manager.Stage(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	return generation
}

func writeAddonPackage(t *testing.T, spec packageSpec) string {
	t.Helper()
	manifest := map[string]any{
		"packageFormat": 1,
		"id":            spec.ID,
		"name":          spec.ID,
		"version":       spec.Version,
		"compatibility": map[string]any{
			"host": ">=2.0.0 <3.0.0", "addonApi": "^3.0.0",
		},
		"capabilities": map[string]any{"required": []string{}, "optional": []string{}},
		"permissions":  []any{},
	}
	files := make(map[string][]byte)
	if spec.Permission {
		manifest["permissions"] = []any{map[string]any{
			"id": "core.data.read", "resources": []string{"characters"}, "reason": "Evaluate character state.",
		}}
	}
	if spec.Worker {
		manifest["compatibility"].(map[string]any)["workerProtocol"] = "^1.0.0"
		manifest["capabilities"].(map[string]any)["required"] = []string{"worker.native"}
		manifest["runtime"] = map[string]any{
			"worker": map[string]any{
				"type": "native", "protocol": "^1.0.0",
				"entrypoints": map[string]any{"windows-amd64": "worker/windows-amd64/addon.exe"},
			},
		}
		files["worker/windows-amd64/addon.exe"] = []byte("test worker")
	}
	services := map[string]any{}
	if spec.Contract != "" {
		services["provides"] = []any{map[string]any{
			"contract": spec.Contract, "version": spec.ContractVersion,
			"transport": "worker", "schema": "contracts/engine.service.json",
		}}
		files["contracts/engine.service.json"] = mustJSON(t, map[string]any{
			"contract": spec.Contract, "version": spec.ContractVersion, "allowsExclusive": false,
			"methods": map[string]any{
				"evaluate-character": map[string]any{
					"requestSchema": "contracts/request.schema.json", "responseSchema": "contracts/response.schema.json",
					"maxDeadlineMs": 2000, "idempotency": "optional",
				},
			},
		})
		files["contracts/request.schema.json"] = []byte(`{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}}}`)
		files["contracts/response.schema.json"] = []byte(`{"type":"object","required":["result"],"properties":{"result":{"type":"integer"}}}`)
	}
	if spec.ConsumeContract != "" {
		services["consumes"] = []any{map[string]any{
			"contract": spec.ConsumeContract, "range": "^3.0.0", "cardinality": "one",
			"required": !spec.OptionalConsume, "selection": "operator",
		}}
	}
	if len(services) > 0 {
		manifest["services"] = services
	}
	files["addon.json"] = mustJSON(t, manifest)
	return writePackageZip(t, files)
}

func writePackageZip(t *testing.T, files map[string][]byte) string {
	t.Helper()
	digests := make(map[string]string, len(files))
	for name, body := range files {
		digest := sha256.Sum256(body)
		digests[name] = hex.EncodeToString(digest[:])
	}
	allFiles := make(map[string][]byte, len(files)+1)
	for name, body := range files {
		allFiles[name] = body
	}
	allFiles["checksums.json"] = mustJSON(t, map[string]any{"algorithm": "sha256", "files": digests})
	names := make([]string, 0, len(allFiles))
	for name := range allFiles {
		names = append(names, name)
	}
	sort.Strings(names)
	filename := filepath.Join(t.TempDir(), "addon.zip")
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for _, name := range names {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		if name == "worker/windows-amd64/addon.exe" {
			header.SetMode(0o755)
		}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(allFiles[name]); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return filename
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func testDatabase(t *testing.T) *sql.DB {
	t.Helper()
	db, err := codexsqlite.Open(context.Background(), filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	result, err := codexsqlite.Migrate(context.Background(), db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if result.CurrentVersion != 4 {
		t.Fatalf("migration version = %d, want 4", result.CurrentVersion)
	}
	return db
}

func testManager(
	t *testing.T,
	db *sql.DB,
	packageDirectory string,
	factory RuntimeFactory,
) (*Manager, *servicebroker.Broker) {
	t.Helper()
	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	brokerStore, err := servicebroker.NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	contexts, err := requestcontext.New(requestcontext.Config{})
	if err != nil {
		t.Fatal(err)
	}
	broker, err := servicebroker.New(brokerStore, servicebroker.NewRuntimeDirectory(), contexts)
	if err != nil {
		t.Fatal(err)
	}
	stageCounter := 0
	manager, err := New(Config{
		DB: db, PackageDirectory: packageDirectory, Inspector: inspector, Broker: broker,
		RuntimeFactory: factory, HostVersion: "2.0.0", AddonAPIVersion: "3.0.0",
		WorkerProtocolVersion: "1.0.0", AvailableCapabilities: []string{"worker.native"},
		Now: func() time.Time { return time.Date(2026, time.August, 31, 12, 0, 0, 0, time.UTC) },
		GenerateID: func() (string, error) {
			stageCounter++
			return fmt.Sprintf("stage%011d", stageCounter), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return manager, broker
}

func assertProviderGeneration(
	t *testing.T,
	broker *servicebroker.Broker,
	contract, generation, version string,
) {
	t.Helper()
	providers, err := broker.ListProviders(context.Background(), contract)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].ActiveGeneration != generation || providers[0].ContractVersion != version {
		t.Fatalf("provider catalog = %+v", providers)
	}
}

func assertServiceCall(t *testing.T, broker *servicebroker.Broker, consumer, contract, versionRange string) {
	t.Helper()
	handle, err := broker.ConnectOne(context.Background(), servicebroker.Requirement{
		ConsumerAddonID: consumer, Contract: contract, Range: versionRange,
		Cardinality: servicebroker.CardinalityOne, Selection: servicebroker.SelectionOperator,
		Scope: servicebroker.GlobalScope(),
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := broker.Call(context.Background(), handle, servicebroker.MethodCall{
		Method: "evaluate-character", Params: map[string]any{"value": 4},
		Context: servicebroker.CallContext{
			Deadline: time.Now().Add(time.Second), Actor: workerrpc.Actor{Role: "system"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(result) != `{"result":8}` {
		t.Fatalf("service result = %s", result)
	}
}

func containsLog(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

type fakeRuntimeFactory struct {
	mu           sync.Mutex
	log          []string
	specs        []RuntimeSpec
	failVersions map[string]error
}

func (factory *fakeRuntimeFactory) New(spec RuntimeSpec) (Runtime, error) {
	factory.mu.Lock()
	factory.specs = append(factory.specs, spec)
	factory.mu.Unlock()
	return &fakeRuntime{factory: factory, spec: spec, startError: factory.failVersions[spec.Identity.Version]}, nil
}

func (factory *fakeRuntimeFactory) Log() []string {
	factory.mu.Lock()
	defer factory.mu.Unlock()
	return append([]string(nil), factory.log...)
}

func (factory *fakeRuntimeFactory) Specs() []RuntimeSpec {
	factory.mu.Lock()
	defer factory.mu.Unlock()
	return append([]RuntimeSpec(nil), factory.specs...)
}

type fakeRuntime struct {
	factory    *fakeRuntimeFactory
	spec       RuntimeSpec
	startError error
	started    bool
}

func (runtime *fakeRuntime) Start(context.Context) error {
	runtime.factory.mu.Lock()
	defer runtime.factory.mu.Unlock()
	runtime.factory.log = append(runtime.factory.log, "start:"+runtime.spec.Identity.AddonID+":"+runtime.spec.Identity.Generation)
	if runtime.startError != nil {
		return runtime.startError
	}
	runtime.started = true
	return nil
}

func (runtime *fakeRuntime) Shutdown(context.Context) error {
	runtime.factory.mu.Lock()
	defer runtime.factory.mu.Unlock()
	runtime.factory.log = append(runtime.factory.log, "stop:"+runtime.spec.Identity.AddonID+":"+runtime.spec.Identity.Generation)
	runtime.started = false
	return nil
}

func (runtime *fakeRuntime) Call(
	_ context.Context,
	_ string,
	_ any,
	meta *workerrpc.Meta,
) (json.RawMessage, error) {
	if !runtime.started || meta == nil || meta.Generation != runtime.spec.Identity.Generation {
		return nil, errors.New("fake runtime is not active for requested generation")
	}
	return json.RawMessage(`{"result":8}`), nil
}

func (runtime *fakeRuntime) Snapshot() workersupervisor.Snapshot {
	state := workersupervisor.StateStopped
	if runtime.started {
		state = workersupervisor.StateReady
	}
	return workersupervisor.Snapshot{Identity: runtime.spec.Identity, State: state}
}

var _ RuntimeFactory = (*fakeRuntimeFactory)(nil)
var _ Runtime = (*fakeRuntime)(nil)
