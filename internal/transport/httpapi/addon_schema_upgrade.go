package httpapi

import (
	"context"
	"net/http"

	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type addonSchemaUpgrader interface {
	PrepareSchemaReview(context.Context, string, string) (datalifecycle.SchemaReview, error)
	GetSchemaReview(context.Context, string) (datalifecycle.SchemaReview, error)
	ApplySchemaReview(context.Context, string, string) (datalifecycle.SchemaReview, error)
	SchemaReviewRecovery(context.Context, string) ([]byte, error)
}

var _ addonSchemaUpgrader = (*packagemanager.Manager)(nil)

func (s *server) addonSchemaReview(w http.ResponseWriter, r *http.Request) {
	upgrader, ok := s.addonLifecycle.(addonSchemaUpgrader)
	if !ok {
		s.writeLifecycleError(w, r, datalifecycle.ErrUpgradeUnavailable)
		return
	}
	if r.PathValue("addonID") != "" {
		addon, ok := pathResourceID(w, r, "addonID")
		if !ok {
			return
		}
		var input struct {
			GenerationID string `json:"generationId"`
		}
		if !decodeAdminJSON(w, r, &input) {
			return
		}
		if !validAddonGeneration(input.GenerationID) {
			writeAPIError(w, 400, "INVALID_REQUEST", "a target generation is required")
			return
		}
		review, err := upgrader.PrepareSchemaReview(r.Context(), addon, input.GenerationID)
		if err != nil {
			s.writeLifecycleError(w, r, err)
			return
		}
		writeJSON(w, 200, review)
		return
	}
	if operation := r.PathValue("operation"); operation != "" && operation != "recovery" {
		http.NotFound(w, r)
		return
	}
	id, ok := pathResourceID(w, r, "reviewID")
	if !ok {
		return
	}
	if r.PathValue("operation") == "recovery" {
		raw, err := upgrader.SchemaReviewRecovery(r.Context(), id)
		if err != nil {
			s.writeLifecycleError(w, r, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", `attachment; filename="addon-schema-recovery.json"`)
		w.WriteHeader(200)
		_, _ = w.Write(raw)
		return
	}
	if r.Method == http.MethodPost {
		var input struct {
			ReviewSHA256 string `json:"reviewSha256"`
		}
		if !decodeAdminJSON(w, r, &input) {
			return
		}
		if !validAddonGeneration(input.ReviewSHA256) {
			writeAPIError(w, 400, "INVALID_REQUEST", "the reviewed fingerprint is required")
			return
		}
		review, err := upgrader.ApplySchemaReview(r.Context(), id, input.ReviewSHA256)
		if err != nil {
			s.writeLifecycleError(w, r, err)
			return
		}
		writeJSON(w, 200, review)
		return
	}
	review, err := upgrader.GetSchemaReview(r.Context(), id)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, 200, review)
}
