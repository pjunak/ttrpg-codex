package httpapi

import (
	"context"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"net/http"
)

type AddonPackageCleaner interface {
	PrepareCleanup(context.Context, packagemanager.CleanupScope) (packagemanager.CleanupReview, error)
	Cleanup(context.Context, packagemanager.CleanupScope, string) (packagemanager.CleanupResult, error)
	RetryCleanups(context.Context) (packagemanager.CleanupResult, error)
}

var _ AddonPackageCleaner = (*packagemanager.Manager)(nil)

func (s *server) packageCleanup(w http.ResponseWriter, r *http.Request) {
	cleaner, ok := s.addonLifecycle.(AddonPackageCleaner)
	if !ok {
		writeAPIError(w, http.StatusServiceUnavailable, "UNAVAILABLE", "package cleanup is unavailable")
		return
	}
	var result any
	var err error
	switch r.PathValue("operation") {
	case "review":
		var scope packagemanager.CleanupScope
		if !decodeAdminJSON(w, r, &scope) {
			return
		}
		result, err = cleaner.PrepareCleanup(r.Context(), scope)
	case "apply":
		var request struct {
			Scope        packagemanager.CleanupScope `json:"scope"`
			ReviewSHA256 string                      `json:"reviewSha256"`
		}
		if !decodeAdminJSON(w, r, &request) {
			return
		}
		if !validAddonGeneration(request.ReviewSHA256) {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "the current package cleanup fingerprint is required")
			return
		}
		result, err = cleaner.Cleanup(r.Context(), request.Scope, request.ReviewSHA256)
	case "retry":
		var request struct{}
		if !decodeAdminJSON(w, r, &request) {
			return
		}
		result, err = cleaner.RetryCleanups(r.Context())
	default:
		writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "cleanup operation not found")
		return
	}
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
