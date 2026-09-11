package httpapi

import (
	"context"
	"net/http"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type AddonConfiguration interface {
	RulesPolicy(context.Context) (packagemanager.RulesPolicy, error)
	SetSourcePolicy(context.Context, packagemanager.SourcePolicyPlan) (packagemanager.ConfigurationResult, error)
	ServiceSelections(context.Context) (packagemanager.ServiceSelections, error)
	SetServiceSelection(context.Context, packagemanager.ServiceSelectionPlan) (packagemanager.ConfigurationResult, error)
}

var _ AddonConfiguration = (*packagemanager.Manager)(nil)

func (s *server) addonConfiguration(w http.ResponseWriter) (AddonConfiguration, bool) {
	configuration, ok := s.addonLifecycle.(AddonConfiguration)
	if !ok {
		writeAPIError(w, http.StatusServiceUnavailable, "UNAVAILABLE", "add-on configuration is unavailable")
	}
	return configuration, ok
}

func (s *server) rulesPolicy(w http.ResponseWriter, r *http.Request) {
	configuration, ok := s.addonConfiguration(w)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	result, err := configuration.RulesPolicy(r.Context())
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) setSourcePolicy(w http.ResponseWriter, r *http.Request) {
	configuration, ok := s.addonConfiguration(w)
	if !ok {
		return
	}
	var plan packagemanager.SourcePolicyPlan
	if !decodeAdminJSON(w, r, &plan) {
		return
	}
	if plan.ExpectedRevision < 1 || !validAddonGeneration(plan.ExpectedGraphRevision) || plan.Enabled == nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "revision, graph revision and enabled sources are required")
		return
	}
	result, err := configuration.SetSourcePolicy(r.Context(), plan)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) serviceSelections(w http.ResponseWriter, r *http.Request) {
	configuration, ok := s.addonConfiguration(w)
	if !ok {
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	result, err := configuration.ServiceSelections(r.Context())
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) setServiceSelection(w http.ResponseWriter, r *http.Request) {
	configuration, ok := s.addonConfiguration(w)
	if !ok {
		return
	}
	var plan packagemanager.ServiceSelectionPlan
	if !decodeAdminJSON(w, r, &plan) {
		return
	}
	if plan.ExpectedRevision < 1 || !validAddonGeneration(plan.ExpectedGraphRevision) || !validAddonGeneration(plan.GenerationID) || plan.ExpectedBindingRevision < 0 || plan.ProviderAddonIDs == nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "current revisions, generation and provider selections are required")
		return
	}
	result, err := configuration.SetServiceSelection(r.Context(), plan)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
