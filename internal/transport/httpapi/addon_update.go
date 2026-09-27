package httpapi

import (
	"context"
	"net/http"

	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type addonUpdateResolver interface {
	PrepareUpdateDataReview(context.Context, string) (datalifecycle.SchemaReview, error)
	ResolveAndActivate(context.Context, string, packagemanager.UpdateResolution) (packagemanager.ActivationResult, error)
	CancelActivationReview(context.Context, string) error
}

func (s *server) resolveAddonUpdate(w http.ResponseWriter, r *http.Request) {
	resolver, ok := s.addonLifecycle.(addonUpdateResolver)
	if !ok {
		s.writeLifecycleError(w, r, datalifecycle.ErrUpgradeUnavailable)
		return
	}
	id, ok := pathResourceID(w, r, "reviewID")
	if !ok {
		return
	}
	switch r.PathValue("updateOperation") {
	case "saved-data":
		var input struct{}
		if !decodeAdminJSON(w, r, &input) {
			return
		}
		review, err := resolver.PrepareUpdateDataReview(r.Context(), id)
		if err != nil {
			s.writeLifecycleError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, review)
	case "resolve":
		var input packagemanager.UpdateResolution
		if !decodeAdminJSON(w, r, &input) {
			return
		}
		if !validAddonGeneration(input.ProposalSHA256) || !validAddonGeneration(input.SchemaReviewSHA256) || input.SchemaReviewID == "" || len(input.SchemaReviewID) > 128 || (input.Action != "heal" && input.Action != "remove") {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "the exact update review and a saved-data action are required")
			return
		}
		result, err := resolver.ResolveAndActivate(r.Context(), id, input)
		if err != nil {
			s.writeLifecycleError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case "cancel":
		var input struct{}
		if !decodeAdminJSON(w, r, &input) {
			return
		}
		if err := resolver.CancelActivationReview(r.Context(), id); err != nil {
			s.writeLifecycleError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
	default:
		http.NotFound(w, r)
	}
}
