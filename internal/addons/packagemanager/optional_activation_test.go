package packagemanager

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReviewedProviderArrivalRebindsOptionalWorker(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	factory := &fakeRuntimeFactory{}
	manager, _ := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), factory)
	consumer, err := manager.Stage(ctx, writeAddonPackage(t, packageSpec{
		ID: "a-consumer", Version: "1.0.0", ConsumeContract: "dnd5e.rules-engine", OptionalConsume: true, Worker: true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: "a-consumer", GenerationID: consumer.GenerationID}); err != nil {
		t.Fatal(err)
	}
	provider := stageServicePackage(t, manager, "z-provider", "1.0.0", "3.1.0")
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: "z-provider", GenerationID: provider.GenerationID, GrantedPermissionIDs: []string{"core.data.read"}}); !errors.Is(err, ErrActivationCohort) {
		t.Fatalf("direct activation left optional consumer unbound: %v", err)
	}
	review, err := manager.PrepareActivationReview(ctx, "z-provider", provider.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(review.Proposal.AffectedAddonIDs, []string{"a-consumer"}) ||
		!reflect.DeepEqual(review.Proposal.RestartedAddonIDs, []string{"a-consumer"}) || len(review.Proposal.Blockers) != 0 {
		t.Fatalf("arrival review = %+v", review.Proposal)
	}
	if _, err := manager.ApproveActivationReview(ctx, review.ReviewID, []string{"core.data.read"}); err != nil {
		t.Fatal(err)
	}
	result, err := manager.ActivateReviewed(ctx, review.ReviewID)
	if err != nil || result.RecoveryError != "" {
		t.Fatalf("arrival activation = %+v, %v", result, err)
	}
	want := []string{"start:a-consumer:" + consumer.GenerationID, "stop:a-consumer:" + consumer.GenerationID,
		"start:z-provider:" + provider.GenerationID, "start:a-consumer:" + consumer.GenerationID}
	if got := factory.Log(); !reflect.DeepEqual(got, want) {
		t.Fatalf("provider-first restart = %v, want %v", got, want)
	}
	specs := factory.Specs()
	if len(specs[0].BoundServices) != 0 || len(specs[2].BoundServices) != 1 || specs[2].BoundServices[0].Generation != provider.GenerationID {
		t.Fatalf("optional consumer handles = %+v", specs)
	}
}
