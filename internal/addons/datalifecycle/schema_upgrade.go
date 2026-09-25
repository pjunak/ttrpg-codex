package datalifecycle

import (
	"context"
	"errors"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
)

var (
	ErrUpgradeUnavailable = errors.New("saved-data schema upgrades are unavailable")
	ErrUpgradeNotFound    = errors.New("saved-data review not found")
	ErrUpgradeStale       = errors.New("saved data or package state changed; prepare a new review")
	ErrUpgradeBlocked     = errors.New("saved data requires an explicit conversion; schema-only upgrade is blocked")
	ErrUpgradeActive      = errors.New("disable the add-on before reviewing or applying saved-data changes")
	ErrUpgradeLimit       = errors.New("saved data exceeds the bounded schema review limit")
)

type SchemaChange struct {
	Kind        datacontract.Kind `json:"kind"`
	DataID      string            `json:"dataId"`
	FromVersion string            `json:"fromVersion"`
	FromSHA256  string            `json:"fromSha256"`
	ToVersion   string            `json:"toVersion"`
	ToSHA256    string            `json:"toSha256"`
	Documents   int               `json:"documents"`
}
type SchemaReview struct {
	ContractVersion       string         `json:"contractVersion"`
	ReviewID              string         `json:"reviewId"`
	AddonID               string         `json:"addonId"`
	GenerationID          string         `json:"generationId"`
	ExpectedStateRevision int64          `json:"expectedStateRevision"`
	SnapshotSHA256        string         `json:"snapshotSha256"`
	ReviewSHA256          string         `json:"reviewSha256"`
	Status                string         `json:"status"`
	CreatedAt             time.Time      `json:"createdAt"`
	ExpiresAt             time.Time      `json:"expiresAt"`
	AppliedAt             *time.Time     `json:"appliedAt,omitempty"`
	Changes               []SchemaChange `json:"changes"`
	Blockers              []Issue        `json:"blockers"`
	Documents             int            `json:"documents"`
}
type SchemaReviewRequest struct {
	ReviewID, AddonID, GenerationID string
	ExpectedStateRevision           int64
}

// SchemaUpgrades only changes schema identity for values already accepted by
// the target registry. Worker-provided transformations require a separate contract.
type SchemaUpgrades interface {
	PrepareSchemaReview(context.Context, SchemaReviewRequest, *datacontract.Registry) (SchemaReview, error)
	GetSchemaReview(context.Context, string) (SchemaReview, error)
	ApplySchemaReview(context.Context, string, string) (SchemaReview, error)
	SchemaReviewRecovery(context.Context, string) ([]byte, error)
}
