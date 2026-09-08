package httpapi

import (
	"context"
	"errors"
	"net/http"

	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/recoverystore"
)

type RecoveryPoints interface {
	List(context.Context) (recoverystore.Listing, error)
	Create(context.Context) error
	Delete(context.Context, int64, int64) error
	Restore(context.Context, recoverystore.RestoreRequest, string) error
}

func (s *server) registerRecoveryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/recovery", s.recoveryList)
	mux.HandleFunc("POST /api/recovery", s.recoveryCreate)
	mux.HandleFunc("POST /api/recovery/restore", s.recoveryRestore)
	mux.HandleFunc("POST /api/recovery/delete", s.recoveryDelete)
}

func (s *server) authorizeRecovery(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	if SessionAdminAuthorizer(s.authentication)(r) != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM authorization is required")
		return false
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_RECOVERY", "query parameters are not supported")
		return false
	}
	return true
}
func (s *server) recoveryList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeRecovery(w, r) {
		return
	}
	s.writeRecoveryList(w, r)
}
func (s *server) writeRecoveryList(w http.ResponseWriter, r *http.Request) {
	result, err := s.recoveryPoints.List(r.Context())
	if err != nil {
		s.recoveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *server) recoveryCreate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeRecovery(w, r) {
		return
	}
	var request struct{}
	if !decodeBoundedJSON(w, r, &request, 1024, "recovery") {
		return
	}
	if err := s.recoveryPoints.Create(r.Context()); err != nil {
		s.recoveryError(w, err)
		return
	}
	s.writeRecoveryList(w, r)
}
func (s *server) recoveryDelete(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeRecovery(w, r) {
		return
	}
	var request struct {
		ID               int64 `json:"id"`
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if !decodeBoundedJSON(w, r, &request, 1024, "recovery") {
		return
	}
	if err := s.recoveryPoints.Delete(r.Context(), request.ID, request.ExpectedRevision); err != nil {
		s.recoveryError(w, err)
		return
	}
	s.writeRecoveryList(w, r)
}
func (s *server) recoveryRestore(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeRecovery(w, r) {
		return
	}
	var request recoverystore.RestoreRequest
	if !decodeBoundedJSON(w, r, &request, 1024, "recovery") {
		return
	}
	actor, _ := sessionauth.ActorFromContext(r.Context())
	if err := s.recoveryPoints.Restore(r.Context(), request, "session:"+actor.SessionID); err != nil {
		s.recoveryError(w, err)
		return
	}
	s.writeRecoveryList(w, r)
}
func (s *server) recoveryError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, recoverystore.ErrConflict):
		writeAPIError(w, http.StatusConflict, "RECOVERY_CONFLICT", "campaign or recovery points changed; refresh and review again")
	case errors.Is(err, recoverystore.ErrCompatibility):
		writeAPIError(w, http.StatusConflict, "RECOVERY_COMPATIBILITY", "restore requires the same active add-on versions and data definitions")
	case errors.Is(err, recoverystore.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, "RECOVERY_NOT_FOUND", "recovery point is no longer available")
	case errors.Is(err, recoverystore.ErrInvalid):
		writeAPIError(w, http.StatusBadRequest, "INVALID_RECOVERY", "select a point or one to fifty edit groups")
	default:
		writeAPIError(w, http.StatusServiceUnavailable, "RECOVERY_UNAVAILABLE", "could not complete the recovery request")
	}
}
