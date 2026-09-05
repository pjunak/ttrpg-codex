package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
)

const playerPreviewHeader = "X-Codex-Player-Preview"
const playerPreviewQuery = "playerPreviewToken"

func isPlayerPreview(r *http.Request) bool {
	_, supplied := r.Header[http.CanonicalHeaderKey(playerPreviewHeader)]
	return supplied
}

// Invalid explicit preview authority must never fall back to a shared DM cookie,
// including on otherwise-public campaign, media, and event routes.
func (s *server) attachPlayerPreview(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	values, querySupplied := query[playerPreviewQuery]
	headerSupplied := isPlayerPreview(r)
	if err != nil {
		for _, field := range strings.FieldsFunc(r.URL.RawQuery, func(r rune) bool { return r == '&' || r == ';' }) {
			key, _, _ := strings.Cut(field, "=")
			decoded, _ := url.QueryUnescape(key)
			querySupplied = querySupplied || decoded == playerPreviewQuery
		}
	}
	if !querySupplied && !headerSupplied {
		return r, true
	}
	validQueryRoute := r.Method == http.MethodGet && (r.URL.Path == "/api/events" || strings.HasPrefix(r.URL.Path, "/api/media/"))
	if err != nil || querySupplied && (!validQueryRoute || len(values) != 1 || headerSupplied) ||
		headerSupplied && len(r.Header.Values(playerPreviewHeader)) != 1 {
		writeAPIError(w, http.StatusUnauthorized, "PREVIEW_UNAVAILABLE", "player preview is invalid or expired")
		return r, false
	}
	if querySupplied {
		r = r.Clone(r.Context())
		r.Header.Set(playerPreviewHeader, values[0])
		query.Del(playerPreviewQuery)
		r.URL.RawQuery = query.Encode()
	}
	if _, ok := s.authentication.InspectPlayerPreview(r.Header.Get(playerPreviewHeader)); !ok {
		writeAPIError(w, http.StatusUnauthorized, "PREVIEW_UNAVAILABLE", "player preview is invalid or expired")
		return r, false
	}
	return r, true
}

func (s *server) createPlayerPreview(w http.ResponseWriter, r *http.Request) {
	if err := SessionAdminAuthorizer(s.authentication)(r); err != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM authorization is required")
		return
	}
	if r.URL.RawQuery != "" || r.ContentLength != 0 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "player preview creation has no request body or query")
		return
	}
	session, err := s.authentication.CreatePlayerPreview(sessionToken(r))
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, sessionauth.ErrRoleTransition) {
			status = http.StatusForbidden
		}
		writeAPIError(w, status, "PREVIEW_UNAVAILABLE", "player preview is unavailable; close an existing preview and try again")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"contractVersion": "player-preview.v1", "token": session.Token,
		"expiresAt": session.ExpiresAt.UTC().Format(time.RFC3339Nano)})
}
