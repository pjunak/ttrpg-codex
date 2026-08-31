// Package packagemanager owns immutable add-on generations and coordinates
// their reviewed activation with worker supervision and the service broker.
package packagemanager

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicecontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/workersupervisor"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

var (
	ErrInvalidConfig       = errors.New("invalid package manager configuration")
	ErrInvalidPackage      = errors.New("invalid installed package")
	ErrGenerationNotFound  = errors.New("add-on generation not found")
	ErrStaleActivationPlan = errors.New("stale add-on activation plan")
	ErrCompatibility       = errors.New("add-on compatibility check failed")
	ErrCapability          = errors.New("required add-on capability unavailable")
	ErrPermission          = errors.New("add-on permission approval invalid")
	ErrDependency          = errors.New("required add-on dependency unavailable")
	ErrServiceResolution   = errors.New("required add-on service unavailable")
	ErrRuntimeUnsupported  = errors.New("add-on runtime unsupported")
	ErrRecoveryRequired    = errors.New("active add-on generation requires recovery")
	ErrActivationCohort    = errors.New("dependent add-ons require coordinated activation")
	ErrActivationFailed    = errors.New("add-on activation failed")
	ErrNotActive           = errors.New("add-on is not active")
	ErrReviewNotFound      = errors.New("activation review not found")
	ErrReviewState         = errors.New("activation review is in the wrong state")
	ErrReviewStale         = errors.New("activation review no longer matches current state")
	ErrReviewBlocked       = errors.New("activation review has unresolved blockers")
)

type ReviewStatus string

const (
	ReviewPrepared ReviewStatus = "prepared"
	ReviewApproved ReviewStatus = "approved"
	ReviewConsumed ReviewStatus = "consumed"
)

type ChangeSet struct {
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
	Changed []string `json:"changed"`
}

type ReviewChanges struct {
	RuntimeChanged   bool      `json:"runtimeChanged"`
	Permissions      ChangeSet `json:"permissions"`
	Capabilities     ChangeSet `json:"capabilities"`
	Contributions    ChangeSet `json:"contributions"`
	Dependencies     ChangeSet `json:"dependencies"`
	ProvidedServices ChangeSet `json:"providedServices"`
	ConsumedServices ChangeSet `json:"consumedServices"`
	Collections      ChangeSet `json:"collections"`
	RecordExtensions ChangeSet `json:"recordExtensions"`
	Content          ChangeSet `json:"content"`
	Locales          ChangeSet `json:"locales"`
}

type ReviewBlocker struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ReviewProposal struct {
	AddonID                        string                   `json:"addonId"`
	GenerationID                   string                   `json:"generationId"`
	ExpectedStateRevision          int64                    `json:"expectedStateRevision"`
	CurrentGenerationID            string                   `json:"currentGenerationId,omitempty"`
	PreviouslyGrantedPermissionIDs []string                 `json:"previouslyGrantedPermissionIds"`
	SuggestedPermissionIDs         []string                 `json:"suggestedPermissionIds"`
	RequiredPermissionIDs          []string                 `json:"requiredPermissionIds"`
	AffectedAddonIDs               []string                 `json:"affectedAddonIds"`
	RestartedAddonIDs              []string                 `json:"restartedAddonIds"`
	CurrentManifest                *packageinspect.Manifest `json:"currentManifest,omitempty"`
	TargetManifest                 packageinspect.Manifest  `json:"targetManifest"`
	Changes                        ReviewChanges            `json:"changes"`
	Blockers                       []ReviewBlocker          `json:"blockers"`
}

type ActivationReview struct {
	ReviewID              string         `json:"reviewId"`
	AddonID               string         `json:"addonId"`
	GenerationID          string         `json:"generationId"`
	ExpectedStateRevision int64          `json:"expectedStateRevision"`
	Status                ReviewStatus   `json:"status"`
	ProposalSHA256        string         `json:"proposalSha256"`
	Proposal              ReviewProposal `json:"proposal"`
	GrantedPermissionIDs  []string       `json:"grantedPermissionIds"`
	ApprovalSHA256        string         `json:"approvalSha256,omitempty"`
	CreatedAt             time.Time      `json:"createdAt"`
	ApprovedAt            *time.Time     `json:"approvedAt,omitempty"`
	ConsumedAt            *time.Time     `json:"consumedAt,omitempty"`
}

type Generation struct {
	AddonID         string     `json:"addonId"`
	GenerationID    string     `json:"generationId"`
	Version         string     `json:"version"`
	ArchiveSHA256   string     `json:"archiveSha256"`
	InstalledAt     time.Time  `json:"installedAt"`
	LastAttemptAt   *time.Time `json:"lastAttemptAt,omitempty"`
	LastActivatedAt *time.Time `json:"lastActivatedAt,omitempty"`
	LastError       string     `json:"lastError,omitempty"`
}

type State struct {
	AddonID              string    `json:"addonId"`
	ActiveGenerationID   string    `json:"activeGenerationId,omitempty"`
	Revision             int64     `json:"revision"`
	GrantedPermissionIDs []string  `json:"grantedPermissionIds"`
	UpdatedAt            time.Time `json:"updatedAt"`
}

type Event struct {
	Sequence     int64     `json:"sequence"`
	AddonID      string    `json:"addonId"`
	GenerationID string    `json:"generationId"`
	Kind         string    `json:"kind"`
	Message      string    `json:"message,omitempty"`
	OccurredAt   time.Time `json:"occurredAt"`
}

type Snapshot struct {
	State       State                      `json:"state"`
	Generations []Generation               `json:"generations"`
	Events      []Event                    `json:"events"`
	Runtime     *workersupervisor.Snapshot `json:"runtime,omitempty"`
}

// ActivationPlan is the exact review token consumed by activation. Staging a
// package never creates this authority and never enables a generation.
type ActivationPlan struct {
	AddonID               string   `json:"addonId"`
	GenerationID          string   `json:"generationId"`
	ExpectedStateRevision int64    `json:"expectedStateRevision"`
	GrantedPermissionIDs  []string `json:"grantedPermissionIds"`
}

type ActivationResult struct {
	ReviewID             string           `json:"reviewId,omitempty"`
	State                State            `json:"state"`
	Generation           Generation       `json:"generation"`
	PreviousGenerationID string           `json:"previousGenerationId,omitempty"`
	CleanupError         string           `json:"cleanupError,omitempty"`
	RestartedAddonIDs    []string         `json:"restartedAddonIds,omitempty"`
	RecoveryResults      []RecoveryResult `json:"recoveryResults,omitempty"`
	RecoveryError        string           `json:"recoveryError,omitempty"`
}

type DisablePlan struct {
	AddonID               string `json:"addonId"`
	ExpectedStateRevision int64  `json:"expectedStateRevision"`
}

type DisableResult struct {
	State                State  `json:"state"`
	PreviousGenerationID string `json:"previousGenerationId,omitempty"`
	CleanupError         string `json:"cleanupError,omitempty"`
}

type RecoveryResult struct {
	AddonID      string `json:"addonId"`
	GenerationID string `json:"generationId"`
	Recovered    bool   `json:"recovered"`
	Error        string `json:"error,omitempty"`
}

type RuntimeSpec struct {
	Identity           workersupervisor.Identity
	RootDirectory      string
	Manifest           packageinspect.Manifest
	GrantedPermissions []packageinspect.Permission
	BoundServices      []servicebroker.Handle
	ServiceContracts   []servicecontract.Description
}

type Runtime interface {
	Start(context.Context) error
	Shutdown(context.Context) error
	Call(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error)
	Snapshot() workersupervisor.Snapshot
}

type RuntimeFactory interface {
	New(RuntimeSpec) (Runtime, error)
}

type RuntimeFactoryFunc func(RuntimeSpec) (Runtime, error)

func (factory RuntimeFactoryFunc) New(spec RuntimeSpec) (Runtime, error) {
	return factory(spec)
}
