package servicebroker

import (
	"errors"
	"regexp"
	"time"
)

var (
	ErrInvalidDeclaration = errors.New("invalid service declaration")
	ErrExclusiveConflict  = errors.New("exclusive service provider conflict")
	ErrProviderNotFound   = errors.New("service provider not found")
	ErrBindingConflict    = errors.New("service binding revision conflict")
	ErrInvalidSelection   = errors.New("invalid service provider selection")
	ErrAmbiguousProvider  = errors.New("multiple compatible service providers require a binding")
	ErrServiceUnavailable = errors.New("compatible service provider unavailable")
	ErrStaleBinding       = errors.New("service binding is stale")
	ErrRuntimeUnavailable = errors.New("service provider runtime unavailable")
	ErrMethodNotFound     = errors.New("service method not found")
	ErrInvalidCall        = errors.New("invalid service call")
	ErrCallDeadline       = errors.New("service call deadline is invalid or expired")
)

var (
	addonIDPattern   = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
	contractPattern  = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$`)
	scopeKindPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`)
	methodPattern    = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`)
)

type Transport string

const (
	TransportUI      Transport = "ui"
	TransportWorker  Transport = "worker"
	TransportContent Transport = "content"
)

type Cardinality string

const (
	CardinalityOne  Cardinality = "one"
	CardinalityMany Cardinality = "many"
)

type Selection string

const (
	SelectionOperator      Selection = "operator"
	SelectionAllCompatible Selection = "all-compatible"
)

type ResolutionStatus string

const (
	ResolutionResolved    ResolutionStatus = "resolved"
	ResolutionUnavailable ResolutionStatus = "unavailable"
	ResolutionAmbiguous   ResolutionStatus = "ambiguous"
	ResolutionUnbound     ResolutionStatus = "unbound"
	ResolutionStale       ResolutionStatus = "stale"
)

type Scope struct {
	Kind string `json:"kind"`
	ID   string `json:"id,omitempty"`
}

func GlobalScope() Scope {
	return Scope{Kind: "global"}
}

type ProviderDeclaration struct {
	Contract  string
	Version   string
	Transport Transport
	Schema    string
	Exclusive bool
}

type Provider struct {
	AddonID          string    `json:"addonId"`
	AddonVersion     string    `json:"addonVersion"`
	Contract         string    `json:"contract"`
	ContractVersion  string    `json:"contractVersion"`
	Transport        Transport `json:"transport"`
	Schema           string    `json:"schema"`
	Exclusive        bool      `json:"exclusive"`
	ActiveGeneration string    `json:"activeGeneration,omitempty"`
	CatalogRevision  int64     `json:"catalogRevision"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

type Requirement struct {
	ConsumerAddonID string      `json:"consumerAddonId"`
	Contract        string      `json:"contract"`
	Range           string      `json:"range"`
	Cardinality     Cardinality `json:"cardinality"`
	Required        bool        `json:"required"`
	Selection       Selection   `json:"selection"`
	Scope           Scope       `json:"scope"`
}

type Binding struct {
	ConsumerAddonID  string    `json:"consumerAddonId"`
	Contract         string    `json:"contract"`
	Scope            Scope     `json:"scope"`
	ProviderAddonIDs []string  `json:"providerAddonIds"`
	Revision         int64     `json:"revision"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

type Resolution struct {
	Status       ResolutionStatus `json:"status"`
	Providers    []Provider       `json:"providers"`
	Binding      *Binding         `json:"binding,omitempty"`
	StaleTargets []string         `json:"staleTargets,omitempty"`
}

type Handle struct {
	ConsumerAddonID string      `json:"consumerAddonId"`
	Contract        string      `json:"contract"`
	Range           string      `json:"range"`
	Cardinality     Cardinality `json:"cardinality"`
	Selection       Selection   `json:"selection"`
	Scope           Scope       `json:"scope"`
	ProviderAddonID string      `json:"providerAddonId"`
	ContractVersion string      `json:"contractVersion"`
	Transport       Transport   `json:"transport"`
	Generation      string      `json:"generation"`
	BindingRevision int64       `json:"bindingRevision"`
}
