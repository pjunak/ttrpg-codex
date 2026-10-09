package packagemanager

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/unitofwork"
)

var ErrUpdateRestored = errors.New("update failed; the previous package and saved data were restored; review the update again")

// Failed rollback must remain exclusive until maintenance/startup completes it.
// A second admin transition must not invalidate its saved state revision.
func (manager *Manager) requireSettledUpdate(ctx context.Context) error {
	var pending bool
	if err := manager.store.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM addon_update_attempts WHERE status='pending')").Scan(&pending); err != nil {
		return err
	}
	if pending {
		return ErrRecoveryRequired
	}
	return nil
}

type UpdateResolution struct {
	ProposalSHA256       string   `json:"proposalSha256"`
	SchemaReviewID       string   `json:"schemaReviewId"`
	SchemaReviewSHA256   string   `json:"schemaReviewSha256"`
	Action               string   `json:"action"`
	GrantedPermissionIDs []string `json:"grantedPermissionIds"`
}

func dataResolutionBlocker(code string) bool {
	return code == "DATA_MIGRATION_REQUIRED" || code == "INVALID_STORED_DOCUMENT" || code == "DATA_DEFINITION_REMOVED" || code == "UNIQUE_INDEX_CONFLICT"
}

func (manager *Manager) currentUpdateReview(ctx context.Context, id string) (ActivationReview, error) {
	if err := manager.requireSettledUpdate(ctx); err != nil {
		return ActivationReview{}, err
	}
	review, err := manager.store.review(ctx, id)
	if err != nil {
		return review, err
	}
	if review.Status != ReviewPrepared || manager.reviewExpired(review) {
		return review, ErrReviewStale
	}
	proposal, err := manager.buildReviewProposal(ctx, review.AddonID, review.GenerationID)
	if err != nil {
		return review, err
	}
	digest, err := hashReviewValue(proposal)
	if err != nil {
		return review, err
	}
	if digest != review.ProposalSHA256 {
		return review, ErrReviewStale
	}
	if len(proposal.Blockers) == 0 {
		return review, ErrReviewState
	}
	for _, blocker := range proposal.Blockers {
		if !dataResolutionBlocker(blocker.Code) {
			return review, ErrReviewBlocked
		}
	}
	return review, nil
}

func (manager *Manager) PrepareUpdateDataReview(ctx context.Context, id string) (datalifecycle.SchemaReview, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	coordinator, ok := manager.dataLifecycle.(datalifecycle.UpdateData)
	if !ok {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeUnavailable
	}
	review, err := manager.currentUpdateReview(ctx, id)
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	report, err := manager.loadPackage(ctx, review.AddonID, review.GenerationID)
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	schemaID, err := manager.generateID()
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	if !validStageID(schemaID) {
		return datalifecycle.SchemaReview{}, ErrInvalidConfig
	}
	return coordinator.PrepareSchemaReview(ctx, datalifecycle.SchemaReviewRequest{ReviewID: schemaID, AddonID: review.AddonID, GenerationID: review.GenerationID, ExpectedStateRevision: review.ExpectedStateRevision, ForActivation: true}, report.DataRegistry())
}

// ResolveAndActivate owns the complete confirmation: immutable data review,
// quiescing, atomic data/package switch, runtime recovery and exact retry receipt.
func (manager *Manager) ResolveAndActivate(ctx context.Context, id string, input UpdateResolution) (ActivationResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if input.Action != "heal" && input.Action != "remove" {
		return ActivationResult{}, ErrInvalidPackage
	}
	input.GrantedPermissionIDs = sortedStrings(input.GrantedPermissionIDs)
	requestHash, err := hashReviewValue(input)
	if err != nil {
		return ActivationResult{}, err
	}
	var previousHash, status string
	var resultJSON sql.NullString
	err = manager.store.db.QueryRowContext(ctx, "SELECT request_sha256,status,result_json FROM addon_update_attempts WHERE review_id=?", id).Scan(&previousHash, &status, &resultJSON)
	if err == nil {
		if requestHash != previousHash {
			return ActivationResult{}, ErrReviewStale
		}
		if status == "applied" {
			var result ActivationResult
			if !resultJSON.Valid {
				return result, ErrReviewState
			}
			err = json.Unmarshal([]byte(resultJSON.String), &result)
			return result, err
		}
		if status == "failed" {
			return ActivationResult{}, ErrUpdateRestored
		}
		return ActivationResult{}, ErrRecoveryRequired
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ActivationResult{}, err
	}
	coordinator, ok := manager.dataLifecycle.(datalifecycle.UpdateData)
	if !ok {
		return ActivationResult{}, datalifecycle.ErrUpgradeUnavailable
	}
	review, err := manager.currentUpdateReview(ctx, id)
	if err != nil {
		return ActivationResult{}, err
	}
	if review.ProposalSHA256 != input.ProposalSHA256 {
		return ActivationResult{}, ErrReviewStale
	}
	schema, err := coordinator.GetSchemaReview(ctx, input.SchemaReviewID)
	if err != nil {
		return ActivationResult{}, err
	}
	if !schema.ForActivation || schema.Status != "prepared" || schema.AddonID != review.AddonID || schema.GenerationID != review.GenerationID || schema.ExpectedStateRevision != review.ExpectedStateRevision || schema.ReviewSHA256 != input.SchemaReviewSHA256 {
		return ActivationResult{}, datalifecycle.ErrUpgradeStale
	}
	if input.Action == "heal" && (len(schema.Blockers) != 0 || len(schema.Changes) == 0) {
		return ActivationResult{}, datalifecycle.ErrUpgradeBlocked
	}
	_, grants, err := approvedPermissions(review.Proposal.TargetManifest.Permissions, input.GrantedPermissionIDs)
	if err != nil {
		return ActivationResult{}, err
	}
	approvalHash, err := reviewApprovalHash(review.ProposalSHA256, grants)
	if err != nil {
		return ActivationResult{}, err
	}
	previous, err := manager.store.state(ctx, review.AddonID)
	if err != nil {
		return ActivationResult{}, err
	}
	generation, err := manager.store.generation(ctx, review.AddonID, review.GenerationID)
	if err != nil {
		return ActivationResult{}, err
	}
	previousJSON, err := json.Marshal(previous)
	if err != nil {
		return ActivationResult{}, err
	}
	grantsJSON, err := json.Marshal(grants)
	if err != nil {
		return ActivationResult{}, err
	}
	configuration, err := manager.store.configuration(ctx)
	if err != nil {
		return ActivationResult{}, err
	}
	rulesJSON, err := json.Marshal(configuration.Ruleset)
	if err != nil {
		return ActivationResult{}, err
	}
	configurationChanged := review.Proposal.TargetManifest.Rules != nil && review.Proposal.TargetManifest.Rules.Defines != nil
	if err = ctx.Err(); err != nil {
		return ActivationResult{}, err
	}
	// Once confirmed, a lost HTTP connection must not strand disabled workers.
	operationCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	coordinator.BlockUpdateWrites(review.AddonID, true)
	defer func() {
		var pending bool
		if queryErr := manager.store.db.QueryRowContext(context.Background(), "SELECT EXISTS(SELECT 1 FROM addon_update_attempts WHERE addon_id=? AND status='pending')", review.AddonID).Scan(&pending); queryErr == nil && !pending {
			coordinator.BlockUpdateWrites(review.AddonID, false)
		}
	}()
	restarted := manager.liveAddonIDs()
	if err = manager.shutdownLocked(operationCtx); err != nil {
		_, recoveryErr := manager.recoverLocked(operationCtx)
		return ActivationResult{}, errors.Join(err, recoveryErr)
	}
	var next State
	err = unitofwork.Run(operationCtx, manager.store.db, func(txCtx context.Context, tx *sql.Tx) error {
		if _, err := coordinator.ApplySchemaResolution(txCtx, schema.ReviewID, schema.ReviewSHA256, input.Action); err != nil {
			return err
		}
		now := manager.store.now().UTC().Format(time.RFC3339Nano)
		approved, err := tx.ExecContext(txCtx, `UPDATE addon_activation_reviews SET status='approved',granted_permissions_json=?,approval_sha256=?,approved_at=? WHERE review_id=? AND status='prepared' AND proposal_sha256=?`, string(grantsJSON), approvalHash, now, id, review.ProposalSHA256)
		if err != nil {
			return err
		}
		if n, err := approved.RowsAffected(); err != nil || n != 1 {
			return ErrReviewStale
		}
		next, err = manager.store.setActiveTx(txCtx, tx, review.Proposal.TargetManifest, review.GenerationID, review.ExpectedStateRevision, grants, "updated", id)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(txCtx, `INSERT INTO addon_update_attempts(review_id,addon_id,schema_review_id,request_sha256,previous_state_json,previous_ruleset_json,configuration_revision,configuration_changed,status) VALUES(?,?,?,?,?,?,?,?,'pending')`, id, review.AddonID, schema.ReviewID, requestHash, string(previousJSON), string(rulesJSON), configuration.Revision, configurationChanged)
		return err
	})
	if err != nil {
		_, recoveryErr := manager.recoverLocked(operationCtx)
		return ActivationResult{}, errors.Join(err, recoveryErr)
	}
	result := ActivationResult{ReviewID: id, State: next, Generation: generation, PreviousGenerationID: previous.ActiveGenerationID, RestartedAddonIDs: restarted}
	result.RecoveryResults, err = manager.recoverLocked(operationCtx)
	// An unrelated add-on that was already unavailable is not part of this
	// update's restart contract. Every previously live runtime and the target are.
	expected := map[string]bool{review.AddonID: true}
	for _, addon := range restarted {
		expected[addon] = true
	}
	scoped := result.RecoveryResults[:0]
	for _, recovered := range result.RecoveryResults {
		if expected[recovered.AddonID] {
			scoped = append(scoped, recovered)
		}
	}
	result.RecoveryResults = scoped
	if err == nil {
		for _, recovered := range result.RecoveryResults {
			if !recovered.Recovered {
				err = fmt.Errorf("%s: %s", recovered.AddonID, recovered.Error)
				break
			}
		}
	}
	if err == nil {
		var encoded []byte
		encoded, err = json.Marshal(result)
		if err == nil {
			_, err = manager.store.db.ExecContext(operationCtx, "UPDATE addon_update_attempts SET status='applied',result_json=? WHERE review_id=? AND status='pending'", string(encoded), id)
		}
	}
	if err != nil {
		rollbackCtx, rollbackCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer rollbackCancel()
		if rollbackErr := manager.restorePendingUpdatesLocked(rollbackCtx); rollbackErr != nil {
			manager.logger.Error("update rollback pending", "addonId", review.AddonID, "error", errors.Join(err, rollbackErr))
			return ActivationResult{}, ErrRecoveryRequired
		}
		_, recoveryErr := manager.recoverLocked(rollbackCtx)
		manager.publishBrowserGraphChangeLocked(rollbackCtx, review.AddonID, "update-restored")
		return ActivationResult{}, errors.Join(ErrUpdateRestored, err, recoveryErr)
	}
	manager.publishBrowserGraphChangeLocked(operationCtx, review.AddonID, "updated")
	manager.cleanupAfterActivationLocked(operationCtx, &result)
	return result, nil
}

func (manager *Manager) restorePendingUpdatesLocked(ctx context.Context) error {
	rows, err := manager.store.db.QueryContext(ctx, "SELECT review_id,addon_id,schema_review_id,previous_state_json,previous_ruleset_json,configuration_revision,configuration_changed FROM addon_update_attempts WHERE status='pending' ORDER BY review_id")
	if err != nil {
		return err
	}
	type pendingUpdate struct {
		id, addon, schema, previous, rules string
		configurationRevision              int64
		configurationChanged               bool
	}
	var updates []pendingUpdate
	for rows.Next() {
		var update pendingUpdate
		if err = rows.Scan(&update.id, &update.addon, &update.schema, &update.previous, &update.rules, &update.configurationRevision, &update.configurationChanged); err != nil {
			rows.Close()
			return err
		}
		updates = append(updates, update)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(updates) == 0 {
		return err
	}
	coordinator, ok := manager.dataLifecycle.(datalifecycle.UpdateData)
	if !ok {
		return datalifecycle.ErrUpgradeUnavailable
	}
	if err = manager.shutdownLocked(ctx); err != nil {
		return err
	}
	for _, update := range updates {
		var previous State
		if err = json.Unmarshal([]byte(update.previous), &previous); err != nil {
			return err
		}
		if previous.AddonID != update.addon {
			return ErrInvalidPackage
		}
		grants, err := json.Marshal(previous.GrantedPermissionIDs)
		if err != nil {
			return err
		}
		err = unitofwork.Run(ctx, manager.store.db, func(txCtx context.Context, tx *sql.Tx) error {
			if err := coordinator.RestoreSchemaSnapshot(txCtx, update.schema); err != nil {
				return err
			}
			result, err := tx.ExecContext(txCtx, `UPDATE addon_package_states SET active_generation_id=NULLIF(?,''),granted_permissions_json=?,revision=revision+1,updated_at=? WHERE addon_id=? AND revision=?`, previous.ActiveGenerationID, string(grants), manager.store.now().UTC().Format(time.RFC3339Nano), previous.AddonID, previous.Revision+1)
			if err != nil {
				return err
			}
			if n, err := result.RowsAffected(); err != nil || n != 1 {
				return ErrReviewStale
			}
			if update.configurationChanged {
				changed, err := tx.ExecContext(txCtx, "UPDATE addon_instance_configuration SET ruleset_json=?,revision=revision+1 WHERE id=1 AND revision=?", update.rules, update.configurationRevision+1)
				if err != nil {
					return err
				}
				if n, err := changed.RowsAffected(); err != nil || n != 1 {
					return ErrConfigurationConflict
				}
			}
			if err := insertEvent(txCtx, tx, previous.AddonID, previous.ActiveGenerationID, "update-restored", "review="+update.id, manager.store.now().UTC()); err != nil {
				return err
			}
			_, err = tx.ExecContext(txCtx, "UPDATE addon_update_attempts SET status='failed' WHERE review_id=?", update.id)
			return err
		})
		if err != nil {
			return err
		}
		coordinator.BlockUpdateWrites(update.addon, false)
	}
	return nil
}
