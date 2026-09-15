package httpapi

import (
	"context"
	"net/http"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type AddonReviewedDisabler interface {
	PrepareDisable(context.Context, string) (packagemanager.DisableReview, error)
	DisableReviewed(context.Context, string, string) (packagemanager.ReviewedDisableResult, error)
}

var _ AddonReviewedDisabler = (*packagemanager.Manager)(nil)

func (s *server) reviewAddonDisable(w http.ResponseWriter, r *http.Request) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return
	}
	disabler, ok := s.addonLifecycle.(AddonReviewedDisabler)
	if !ok {
		writeAPIError(w, 503, "UNAVAILABLE", "reviewed add-on disable is unavailable")
		return
	}
	var request struct{}
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	result, err := disabler.PrepareDisable(r.Context(), addonID)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *server) disableAddonReviewed(w http.ResponseWriter, r *http.Request) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return
	}
	disabler, ok := s.addonLifecycle.(AddonReviewedDisabler)
	if !ok {
		writeAPIError(w, 503, "UNAVAILABLE", "reviewed add-on disable is unavailable")
		return
	}
	var request struct {
		ReviewSHA256 string `json:"reviewSha256"`
	}
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	if !validAddonGeneration(request.ReviewSHA256) {
		writeAPIError(w, 400, "INVALID_REQUEST", "the current disable review fingerprint is required")
		return
	}
	result, err := disabler.DisableReviewed(r.Context(), addonID, request.ReviewSHA256)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
