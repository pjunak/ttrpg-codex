package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/githubsource"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type AddonGitHub interface {
	Status(context.Context) (githubsource.Status, error)
	SaveToken(context.Context, string, string) error
	SaveSource(context.Context, githubsource.LinkedSource, bool) error
	Discover(context.Context, githubsource.Source, string) (githubsource.Discovery, error)
	Stage(context.Context, githubsource.Source, string, string) (packagemanager.Generation, error)
}

func (s *server) registerAddonGitHubRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/admin/addon-github", s.requireAdmin(http.HandlerFunc(s.githubStatus)))
	mux.Handle("POST /api/admin/addon-github/token", s.requireAdmin(http.HandlerFunc(s.githubToken)))
	mux.Handle("POST /api/admin/addon-github/source", s.requireAdmin(http.HandlerFunc(s.githubSource)))
	mux.Handle("POST /api/admin/addon-github/discover", s.requireAdmin(http.HandlerFunc(s.githubDiscover)))
	mux.Handle("POST /api/admin/addon-github/stage", s.requireAdmin(http.HandlerFunc(s.githubStage)))
}
func (s *server) githubStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.RawQuery != "" {
		writeAPIError(w, 400, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	result, err := s.addonGitHub.Status(r.Context())
	if err != nil {
		s.writeGitHubError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
func (s *server) githubToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var request struct {
		Repo  string `json:"repo"`
		Token string `json:"token"`
	}
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	if err := s.addonGitHub.SaveToken(r.Context(), request.Repo, request.Token); err != nil {
		s.writeGitHubError(w, err)
		return
	}
	s.githubStatus(w, r)
}
func (s *server) githubSource(w http.ResponseWriter, r *http.Request) {
	var request struct {
		githubsource.LinkedSource
		Remove bool `json:"remove"`
	}
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	if err := s.addonGitHub.SaveSource(r.Context(), request.LinkedSource, request.Remove); err != nil {
		s.writeGitHubError(w, err)
		return
	}
	s.githubStatus(w, r)
}

type githubPackageRequest struct {
	Source      githubsource.Source `json:"source"`
	AddonID     string              `json:"addonId"`
	CandidateID string              `json:"candidateId"`
}

func (s *server) githubDiscover(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Source  githubsource.Source `json:"source"`
		AddonID string              `json:"addonId"`
	}
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	ctx, cancel := githubRequestContext(w, r)
	defer cancel()
	result, err := s.addonGitHub.Discover(ctx, request.Source, request.AddonID)
	if err != nil {
		s.writeGitHubError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
func (s *server) githubStage(w http.ResponseWriter, r *http.Request) {
	var request githubPackageRequest
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	ctx, cancel := githubRequestContext(w, r)
	defer cancel()
	result, err := s.addonGitHub.Stage(ctx, request.Source, request.AddonID, request.CandidateID)
	if err != nil {
		s.writeGitHubError(w, err)
		return
	}
	writeJSON(w, 201, result)
}
func githubRequestContext(w http.ResponseWriter, r *http.Request) (context.Context, context.CancelFunc) {
	w.Header().Set("Cache-Control", "no-store")
	// A bounded remote lookup/download can exceed the ordinary API write deadline.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(95 * time.Second))
	return context.WithTimeout(r.Context(), 90*time.Second)
}
func (s *server) writeGitHubError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, githubsource.ErrInvalid):
		writeAPIError(w, 400, "GITHUB_INVALID", githubsource.ErrInvalid.Error())
	case errors.Is(err, githubsource.ErrConflict):
		writeAPIError(w, 409, "GITHUB_CONFLICT", githubsource.ErrConflict.Error())
	case errors.Is(err, githubsource.ErrIdentity):
		writeAPIError(w, 422, "GITHUB_IDENTITY", githubsource.ErrIdentity.Error())
	case errors.Is(err, githubsource.ErrPackage):
		writeAPIError(w, 422, "GITHUB_PACKAGE", githubsource.ErrPackage.Error())
	case errors.Is(err, githubsource.ErrNoPackage):
		writeAPIError(w, 422, "GITHUB_NO_PACKAGE", githubsource.ErrNoPackage.Error())
	case errors.Is(err, githubsource.ErrSourceMissing):
		writeAPIError(w, 409, "GITHUB_SOURCE_MISSING", githubsource.ErrSourceMissing.Error())
	default:
		writeAPIError(w, 502, "GITHUB_UNAVAILABLE", githubsource.ErrUnavailable.Error())
	}
}
