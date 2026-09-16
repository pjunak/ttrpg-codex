package campaigndata

import (
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"time"
)

// PlanImport uses the interactive mutation planner without publishing. The
// caller retains its exact transaction and guards the supplied snapshot before
// publication. This is a host-only boundary, not add-on mutation authority.
func PlanImport(snapshot campaign.Snapshot, actorID string, requested []campaign.Mutation, at time.Time) (campaign.Transaction, campaign.Snapshot, error) {
	planner := newMutationPlanner(snapshot, func() time.Time { return at })
	for _, mutation := range requested {
		if err := planner.applyRequested(WriteDM, mutation); err != nil {
			return campaign.Transaction{}, campaign.Snapshot{}, err
		}
	}
	if err := planner.applyDerivedPolicies(); err != nil {
		return campaign.Transaction{}, campaign.Snapshot{}, err
	}
	transaction, err := planner.transaction(actorID)
	if err != nil {
		return transaction, campaign.Snapshot{}, err
	}
	candidate := campaign.Snapshot{States: append([]campaign.CollectionState(nil), snapshot.States...), Records: []campaign.Record{}}
	for _, key := range planner.recordOrder {
		if record, ok := planner.current[key]; ok {
			candidate.Records = append(candidate.Records, record)
		}
	}
	return transaction, candidate, nil
}

// ImportViews applies the same closed public projection used by campaign reads.
func ImportViews(snapshot campaign.Snapshot) (Dataset, Dataset, error) {
	public, err := projectPublic(snapshot)
	if err != nil {
		return Dataset{}, Dataset{}, err
	}
	return datasetView(snapshot), datasetView(public), nil
}

func ImportRelationshipTargets(snapshot campaign.Snapshot) (map[string]campaign.Collection, error) {
	return newMutationPlanner(snapshot, time.Now).relationshipTargetKinds()
}
