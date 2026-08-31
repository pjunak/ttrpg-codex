package packagemanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

func (manager *Manager) PrepareActivationReview(
	ctx context.Context,
	addonID string,
	generationID string,
) (ActivationReview, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	proposal, err := manager.buildReviewProposal(ctx, addonID, generationID)
	if err != nil {
		return ActivationReview{}, err
	}
	proposalHash, err := hashReviewValue(proposal)
	if err != nil {
		return ActivationReview{}, err
	}
	reviewID, err := manager.generateID()
	if err != nil {
		return ActivationReview{}, fmt.Errorf("generate activation review id: %w", err)
	}
	if !validStageID(reviewID) {
		return ActivationReview{}, fmt.Errorf("%w: generated activation review id is invalid", ErrInvalidConfig)
	}
	return manager.store.createReview(ctx, reviewID, proposal, proposalHash)
}

func (manager *Manager) GetActivationReview(ctx context.Context, reviewID string) (ActivationReview, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.store.review(ctx, reviewID)
}

func (manager *Manager) ApproveActivationReview(
	ctx context.Context,
	reviewID string,
	grantedPermissionIDs []string,
) (ActivationReview, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	review, err := manager.store.review(ctx, reviewID)
	if err != nil {
		return ActivationReview{}, err
	}
	if review.Status != ReviewPrepared && review.Status != ReviewApproved {
		return ActivationReview{}, ErrReviewState
	}
	if review.Status == ReviewApproved {
		_, normalizedGrants, err := approvedPermissions(
			review.Proposal.TargetManifest.Permissions, grantedPermissionIDs,
		)
		if err != nil {
			return ActivationReview{}, err
		}
		approvalHash, err := reviewApprovalHash(review.ProposalSHA256, normalizedGrants)
		if err != nil {
			return ActivationReview{}, err
		}
		if approvalHash == review.ApprovalSHA256 {
			return review, nil
		}
		return ActivationReview{}, ErrReviewState
	}
	proposal, err := manager.buildReviewProposal(ctx, review.AddonID, review.GenerationID)
	if err != nil {
		return ActivationReview{}, err
	}
	proposalHash, err := hashReviewValue(proposal)
	if err != nil {
		return ActivationReview{}, err
	}
	if proposalHash != review.ProposalSHA256 {
		return ActivationReview{}, ErrReviewStale
	}
	if len(proposal.Blockers) != 0 {
		return ActivationReview{}, fmt.Errorf("%w: %s", ErrReviewBlocked, proposal.Blockers[0].Message)
	}
	_, normalizedGrants, err := approvedPermissions(proposal.TargetManifest.Permissions, grantedPermissionIDs)
	if err != nil {
		return ActivationReview{}, err
	}
	if proposal.CurrentGenerationID == proposal.GenerationID &&
		!reflect.DeepEqual(normalizedGrants, proposal.PreviouslyGrantedPermissionIDs) &&
		len(proposal.AffectedAddonIDs) != 0 {
		return ActivationReview{}, fmt.Errorf("%w: %v", ErrReviewBlocked, proposal.AffectedAddonIDs)
	}
	approvalHash, err := reviewApprovalHash(proposalHash, normalizedGrants)
	if err != nil {
		return ActivationReview{}, err
	}
	return manager.store.approveReview(ctx, reviewID, proposalHash, normalizedGrants, approvalHash)
}

func (manager *Manager) ActivateReviewed(
	ctx context.Context,
	reviewID string,
) (ActivationResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	review, err := manager.store.review(ctx, reviewID)
	if err != nil {
		return ActivationResult{}, err
	}
	if review.Status == ReviewConsumed {
		state, err := manager.store.state(ctx, review.AddonID)
		if err != nil {
			return ActivationResult{}, err
		}
		if state.ActiveGenerationID != review.GenerationID ||
			state.Revision != review.ExpectedStateRevision+1 ||
			!reflect.DeepEqual(state.GrantedPermissionIDs, review.GrantedPermissionIDs) {
			return ActivationResult{}, ErrReviewState
		}
		generation, err := manager.store.generation(ctx, review.AddonID, review.GenerationID)
		if err != nil {
			return ActivationResult{}, err
		}
		return ActivationResult{
			ReviewID: reviewID, State: state, Generation: generation,
			PreviousGenerationID: review.Proposal.CurrentGenerationID,
		}, nil
	}
	if review.Status != ReviewApproved {
		return ActivationResult{}, ErrReviewState
	}
	proposal, err := manager.buildReviewProposal(ctx, review.AddonID, review.GenerationID)
	if err != nil {
		return ActivationResult{}, err
	}
	proposalHash, err := hashReviewValue(proposal)
	if err != nil {
		return ActivationResult{}, err
	}
	if proposalHash != review.ProposalSHA256 || proposal.ExpectedStateRevision != review.ExpectedStateRevision {
		return ActivationResult{}, ErrReviewStale
	}
	if len(proposal.Blockers) != 0 {
		return ActivationResult{}, fmt.Errorf("%w: %s", ErrReviewBlocked, proposal.Blockers[0].Message)
	}
	_, normalizedGrants, err := approvedPermissions(proposal.TargetManifest.Permissions, review.GrantedPermissionIDs)
	if err != nil {
		return ActivationResult{}, err
	}
	if proposal.CurrentGenerationID == proposal.GenerationID &&
		!reflect.DeepEqual(normalizedGrants, proposal.PreviouslyGrantedPermissionIDs) &&
		len(proposal.AffectedAddonIDs) != 0 {
		return ActivationResult{}, fmt.Errorf("%w: %v", ErrReviewBlocked, proposal.AffectedAddonIDs)
	}
	approvalHash, err := reviewApprovalHash(proposalHash, normalizedGrants)
	if err != nil {
		return ActivationResult{}, err
	}
	if approvalHash != review.ApprovalSHA256 {
		return ActivationResult{}, ErrReviewStale
	}
	return manager.activateLocked(ctx, ActivationPlan{
		AddonID: review.AddonID, GenerationID: review.GenerationID,
		ExpectedStateRevision: review.ExpectedStateRevision,
		GrantedPermissionIDs:  normalizedGrants,
	}, "activated", reviewID)
}

func (manager *Manager) buildReviewProposal(
	ctx context.Context,
	addonID string,
	generationID string,
) (ReviewProposal, error) {
	state, err := manager.store.state(ctx, addonID)
	if err != nil {
		return ReviewProposal{}, err
	}
	if _, err := manager.store.generation(ctx, addonID, generationID); err != nil {
		return ReviewProposal{}, err
	}
	report, err := manager.loadPackage(ctx, addonID, generationID)
	if err != nil {
		return ReviewProposal{}, err
	}
	var currentManifest *packageinspect.Manifest
	if state.ActiveGenerationID != "" {
		manifest, err := manager.store.manifest(ctx, addonID, state.ActiveGenerationID)
		if err != nil {
			return ReviewProposal{}, err
		}
		currentManifest = &manifest
	}
	proposal := ReviewProposal{
		AddonID: addonID, GenerationID: generationID, ExpectedStateRevision: state.Revision,
		CurrentGenerationID:            state.ActiveGenerationID,
		PreviouslyGrantedPermissionIDs: sortedStrings(state.GrantedPermissionIDs),
		CurrentManifest:                currentManifest, TargetManifest: report.Manifest,
		Blockers: make([]ReviewBlocker, 0),
	}
	proposal.SuggestedPermissionIDs, proposal.RequiredPermissionIDs = reviewPermissionIDs(
		state.GrantedPermissionIDs, report.Manifest.Permissions,
	)
	proposal.Changes = compareManifests(currentManifest, report.Manifest)
	if err := manager.validateCompatibility(report.Manifest); err != nil {
		proposal.Blockers = append(proposal.Blockers, reviewBlocker("COMPATIBILITY", err))
	}
	if err := manager.validateDependencies(ctx, report.Manifest, false); err != nil {
		proposal.Blockers = append(proposal.Blockers, reviewBlocker("DEPENDENCY", err))
	}
	if _, err := manager.resolveServices(ctx, report.Manifest); err != nil {
		proposal.Blockers = append(proposal.Blockers, reviewBlocker("SERVICE", err))
	}
	if state.ActiveGenerationID != "" {
		active, recovered := manager.runtimes[addonID]
		if !recovered || active.generation.GenerationID != state.ActiveGenerationID {
			proposal.Blockers = append(proposal.Blockers, reviewBlocker("RECOVERY_REQUIRED", ErrRecoveryRequired))
		} else {
			proposal.AffectedAddonIDs = manager.liveDependents(addonID)
			if state.ActiveGenerationID != generationID && len(proposal.AffectedAddonIDs) != 0 {
				proposal.Blockers = append(proposal.Blockers, ReviewBlocker{
					Code:    "ACTIVATION_COHORT_REQUIRED",
					Message: fmt.Sprintf("dependent add-ons require coordinated activation: %v", proposal.AffectedAddonIDs),
				})
			}
		}
	}
	return proposal, nil
}

func reviewBlocker(code string, err error) ReviewBlocker {
	return ReviewBlocker{Code: code, Message: err.Error()}
}

func reviewPermissionIDs(previous []string, requested []packageinspect.Permission) ([]string, []string) {
	requestedByID := make(map[string]packageinspect.Permission, len(requested))
	required := make([]string, 0)
	for _, permission := range requested {
		requestedByID[permission.ID] = permission
		if !permission.Optional {
			required = append(required, permission.ID)
		}
	}
	suggested := make([]string, 0)
	for _, id := range previous {
		if _, retained := requestedByID[id]; retained {
			suggested = append(suggested, id)
		}
	}
	return sortedStrings(suggested), sortedStrings(required)
}

func compareManifests(current *packageinspect.Manifest, target packageinspect.Manifest) ReviewChanges {
	var before packageinspect.Manifest
	if current != nil {
		before = *current
	}
	return ReviewChanges{
		RuntimeChanged:   !reflect.DeepEqual(before.Runtime, target.Runtime),
		Permissions:      changeSet(keyed(before.Permissions, func(value packageinspect.Permission) string { return value.ID }), keyed(target.Permissions, func(value packageinspect.Permission) string { return value.ID })),
		Capabilities:     changeSet(capabilityItems(before), capabilityItems(target)),
		Contributions:    changeSet(keyed(before.Contributions, func(value packageinspect.Contribution) string { return value.ID }), keyed(target.Contributions, func(value packageinspect.Contribution) string { return value.ID })),
		Dependencies:     changeSet(keyed(before.Dependencies, func(value packageinspect.Dependency) string { return value.ID }), keyed(target.Dependencies, func(value packageinspect.Dependency) string { return value.ID })),
		ProvidedServices: changeSet(keyed(before.Services.Provides, func(value packageinspect.ProvidedService) string { return value.Contract }), keyed(target.Services.Provides, func(value packageinspect.ProvidedService) string { return value.Contract })),
		ConsumedServices: changeSet(keyed(before.Services.Consumes, func(value packageinspect.ConsumedService) string { return value.Contract }), keyed(target.Services.Consumes, func(value packageinspect.ConsumedService) string { return value.Contract })),
		Collections:      changeSet(keyed(before.Collections, func(value packageinspect.Collection) string { return value.ID }), keyed(target.Collections, func(value packageinspect.Collection) string { return value.ID })),
		RecordExtensions: changeSet(keyed(before.RecordExtensions, func(value packageinspect.RecordExtension) string { return value.ID }), keyed(target.RecordExtensions, func(value packageinspect.RecordExtension) string { return value.ID })),
		Content:          changeSet(keyed(before.Content, func(value packageinspect.ContentSet) string { return value.ID }), keyed(target.Content, func(value packageinspect.ContentSet) string { return value.ID })),
		Locales:          changeSet(stringItems(before.Locales), stringItems(target.Locales)),
	}
}

func keyed[T any](values []T, key func(T) string) map[string]any {
	result := make(map[string]any, len(values))
	for _, value := range values {
		result[key(value)] = value
	}
	return result
}

func capabilityItems(manifest packageinspect.Manifest) map[string]any {
	result := make(map[string]any, len(manifest.Capabilities.Required)+len(manifest.Capabilities.Optional))
	for _, value := range manifest.Capabilities.Required {
		result["required:"+value] = value
	}
	for _, value := range manifest.Capabilities.Optional {
		result["optional:"+value] = value
	}
	return result
}

func stringItems(values map[string]string) map[string]any {
	result := make(map[string]any, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func changeSet(before, after map[string]any) ChangeSet {
	result := ChangeSet{Added: []string{}, Removed: []string{}, Changed: []string{}}
	for key, afterValue := range after {
		beforeValue, existed := before[key]
		if !existed {
			result.Added = append(result.Added, key)
		} else if !reflect.DeepEqual(beforeValue, afterValue) {
			result.Changed = append(result.Changed, key)
		}
	}
	for key := range before {
		if _, retained := after[key]; !retained {
			result.Removed = append(result.Removed, key)
		}
	}
	sort.Strings(result.Added)
	sort.Strings(result.Removed)
	sort.Strings(result.Changed)
	return result
}

func sortedStrings(values []string) []string {
	result := append([]string(nil), values...)
	sort.Strings(result)
	return result
}

func hashReviewValue(value any) (string, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode activation review hash input: %w", err)
	}
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:]), nil
}

func reviewApprovalHash(proposalSHA256 string, grantedPermissionIDs []string) (string, error) {
	return hashReviewValue(struct {
		ProposalSHA256       string   `json:"proposalSha256"`
		GrantedPermissionIDs []string `json:"grantedPermissionIds"`
	}{proposalSHA256, grantedPermissionIDs})
}
