package httpapi

import (
	"errors"
	"net/http"
	"time"

	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
)

func (s *server) passwordStatus(w http.ResponseWriter, r *http.Request) {
	if SessionAdminAuthorizer(s.authentication)(r) != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM authorization is required")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, s.authentication.CredentialStatus())
}

func (s *server) changePassword(w http.ResponseWriter, r *http.Request) {
	if SessionAdminAuthorizer(s.authentication)(r) != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM authorization is required")
		return
	}
	client, now := authClientKey(r), time.Now().UTC()
	if allowed, _ := s.loginLimiter.allow(client, now); !allowed {
		writeAPIError(w, http.StatusTooManyRequests, "LOGIN_RATE_LIMITED", "too many password attempts")
		return
	}
	var request struct {
		Role             sessionauth.Role `json:"role"`
		CurrentPassword  string           `json:"currentPassword"`
		NewPassword      string           `json:"newPassword"`
		ExpectedRevision int64            `json:"expectedRevision"`
	}
	if !decodeBoundedJSON(w, r, &request, 16<<10, "credentials") {
		return
	}
	status, err := s.authentication.ChangePassword(r.Context(), sessionToken(r), r.Header.Get(csrfHeaderName), request.CurrentPassword, request.Role, request.NewPassword, request.ExpectedRevision)
	if err != nil {
		switch {
		case errors.Is(err, sessionauth.ErrCredentialConflict):
			writeAPIError(w, http.StatusConflict, "CREDENTIAL_CONFLICT", "password settings changed; reload before trying again")
		case errors.Is(err, sessionauth.ErrInvalidCredentials):
			s.loginLimiter.failed(client, now)
			writeAPIError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "current DM password is incorrect")
		case errors.Is(err, sessionauth.ErrPasswordPolicy):
			writeAPIError(w, http.StatusBadRequest, "INVALID_PASSWORD", err.Error())
		case errors.Is(err, sessionauth.ErrRoleTransition):
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM authorization is required")
		default:
			writeAPIError(w, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "could not save password settings")
		}
		return
	}
	s.loginLimiter.succeeded(client)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, status)
}
