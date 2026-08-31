package packagemanager

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

func (store *store) manifest(ctx context.Context, addonID, generationID string) (packageinspect.Manifest, error) {
	row := store.db.QueryRowContext(ctx, `
		SELECT manifest_json
		FROM addon_package_generations
		WHERE addon_id = ? AND generation_id = ?`, addonID, generationID)
	var body string
	if err := row.Scan(&body); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return packageinspect.Manifest{}, ErrGenerationNotFound
		}
		return packageinspect.Manifest{}, fmt.Errorf("read installed manifest: %w", err)
	}
	var manifest packageinspect.Manifest
	if err := json.Unmarshal([]byte(body), &manifest); err != nil {
		return packageinspect.Manifest{}, fmt.Errorf("decode installed manifest: %w", err)
	}
	return manifest, nil
}

func (store *store) createReview(
	ctx context.Context,
	reviewID string,
	proposal ReviewProposal,
	proposalSHA256 string,
) (ActivationReview, error) {
	body, err := json.Marshal(proposal)
	if err != nil {
		return ActivationReview{}, fmt.Errorf("encode activation proposal: %w", err)
	}
	now := store.now().UTC()
	if _, err := store.db.ExecContext(ctx, `
		INSERT INTO addon_activation_reviews(
			review_id, addon_id, generation_id, expected_state_revision,
			status, proposal_sha256, proposal_json, created_at
		) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?)`,
		reviewID, proposal.AddonID, proposal.GenerationID, proposal.ExpectedStateRevision,
		proposalSHA256, string(body), now.Format(time.RFC3339Nano),
	); err != nil {
		return ActivationReview{}, fmt.Errorf("record activation review: %w", err)
	}
	return store.review(ctx, reviewID)
}

func (store *store) review(ctx context.Context, reviewID string) (ActivationReview, error) {
	row := store.db.QueryRowContext(ctx, `
		SELECT review_id, addon_id, generation_id, expected_state_revision,
		       status, proposal_sha256, proposal_json,
		       granted_permissions_json, COALESCE(approval_sha256, ''),
		       created_at, approved_at, consumed_at
		FROM addon_activation_reviews
		WHERE review_id = ?`, reviewID)
	return scanReview(row)
}

func (store *store) approveReview(
	ctx context.Context,
	reviewID string,
	proposalSHA256 string,
	grantedPermissionIDs []string,
	approvalSHA256 string,
) (ActivationReview, error) {
	grantsJSON, err := json.Marshal(grantedPermissionIDs)
	if err != nil {
		return ActivationReview{}, fmt.Errorf("encode reviewed permissions: %w", err)
	}
	now := store.now().UTC()
	result, err := store.db.ExecContext(ctx, `
		UPDATE addon_activation_reviews
		SET status = 'approved', granted_permissions_json = ?,
		    approval_sha256 = ?, approved_at = ?
		WHERE review_id = ? AND proposal_sha256 = ? AND status = 'prepared'`,
		string(grantsJSON), approvalSHA256, now.Format(time.RFC3339Nano),
		reviewID, proposalSHA256,
	)
	if err != nil {
		return ActivationReview{}, fmt.Errorf("approve activation review: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return ActivationReview{}, fmt.Errorf("read activation review approval: %w", err)
	}
	if changed != 1 {
		return ActivationReview{}, ErrReviewState
	}
	return store.review(ctx, reviewID)
}

type reviewRow interface {
	Scan(...any) error
}

func scanReview(row reviewRow) (ActivationReview, error) {
	var review ActivationReview
	var status, proposalJSON, grantsJSON, createdAt string
	var approvedAt, consumedAt sql.NullString
	if err := row.Scan(
		&review.ReviewID, &review.AddonID, &review.GenerationID,
		&review.ExpectedStateRevision, &status, &review.ProposalSHA256,
		&proposalJSON, &grantsJSON, &review.ApprovalSHA256,
		&createdAt, &approvedAt, &consumedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ActivationReview{}, ErrReviewNotFound
		}
		return ActivationReview{}, fmt.Errorf("scan activation review: %w", err)
	}
	review.Status = ReviewStatus(status)
	if err := json.Unmarshal([]byte(proposalJSON), &review.Proposal); err != nil {
		return ActivationReview{}, fmt.Errorf("decode activation proposal: %w", err)
	}
	if err := json.Unmarshal([]byte(grantsJSON), &review.GrantedPermissionIDs); err != nil {
		return ActivationReview{}, fmt.Errorf("decode reviewed permissions: %w", err)
	}
	var err error
	review.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return ActivationReview{}, fmt.Errorf("parse activation review creation time: %w", err)
	}
	if approvedAt.Valid {
		value, err := time.Parse(time.RFC3339Nano, approvedAt.String)
		if err != nil {
			return ActivationReview{}, fmt.Errorf("parse activation review approval time: %w", err)
		}
		review.ApprovedAt = &value
	}
	if consumedAt.Valid {
		value, err := time.Parse(time.RFC3339Nano, consumedAt.String)
		if err != nil {
			return ActivationReview{}, fmt.Errorf("parse activation review consumption time: %w", err)
		}
		review.ConsumedAt = &value
	}
	return review, nil
}
