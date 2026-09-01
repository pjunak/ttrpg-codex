// Package datalifecycle defines the narrow boundary between immutable package
// generations and the application service that owns their durable documents.
package datalifecycle

import (
	"context"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
)

type Issue struct {
	Code    string            `json:"code"`
	Kind    datacontract.Kind `json:"kind"`
	DataID  string            `json:"dataId"`
	Message string            `json:"message"`
}

// Transition quiesces data calls for one add-on while the package manager
// changes its durable active-generation pointer. Commit selects the target
// registry; Rollback retains the previous one. Exactly one must be called.
type Transition interface {
	Commit()
	Rollback()
}

type Coordinator interface {
	ReviewActivation(context.Context, string, *datacontract.Registry) ([]Issue, error)
	BeginActivation(context.Context, string, string, *datacontract.Registry) (Transition, error)
	BeginDeactivation(string, string) Transition
}
