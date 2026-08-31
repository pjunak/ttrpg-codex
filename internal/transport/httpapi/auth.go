package httpapi

import (
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
)

const (
	sessionCookieName = "edit_session"
	csrfHeaderName    = "X-Codex-CSRF"
	maxAuthBodyBytes  = 4 << 10
	loginWindow       = time.Minute
	maxLoginFailures  = 10
	maxLoginClients   = 4_096
)

var errAuthorizationRequired = errors.New("authorization required")

type loginAttempt struct {
	failures int
	started  time.Time
}

type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string]loginAttempt
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{attempts: make(map[string]loginAttempt)}
}

func (limiter *loginLimiter) allow(key string, now time.Time) (bool, time.Duration) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	attempt, exists := limiter.attempts[key]
	if !exists || !now.Before(attempt.started.Add(loginWindow)) {
		delete(limiter.attempts, key)
		return true, 0
	}
	if attempt.failures < maxLoginFailures {
		return true, 0
	}
	return false, attempt.started.Add(loginWindow).Sub(now)
}

func (limiter *loginLimiter) failed(key string, now time.Time) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	attempt, exists := limiter.attempts[key]
	if !exists || !now.Before(attempt.started.Add(loginWindow)) {
		if len(limiter.attempts) >= maxLoginClients {
			for candidate, value := range limiter.attempts {
				if !now.Before(value.started.Add(loginWindow)) {
					delete(limiter.attempts, candidate)
				}
			}
		}
		if len(limiter.attempts) >= maxLoginClients {
			return
		}
		limiter.attempts[key] = loginAttempt{failures: 1, started: now}
		return
	}
	attempt.failures++
	limiter.attempts[key] = attempt
}

func (limiter *loginLimiter) succeeded(key string) {
	limiter.mu.Lock()
	delete(limiter.attempts, key)
	limiter.mu.Unlock()
}

func (s *server) registerAuthenticationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth", s.authState)
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/logout", s.logout)
	mux.HandleFunc("POST /api/view-as", s.viewAs)
}

func (s *server) attachSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := sessionToken(r)
		if actor, ok := s.authentication.Resolve(token); ok {
			r = r.WithContext(sessionauth.WithActor(r.Context(), actor))
		}
		next.ServeHTTP(w, r)
	})
}

func SessionBrowserAuthorizer(r *http.Request) error {
	if actor, ok := sessionauth.ActorFromContext(r.Context()); ok &&
		(actor.Role == sessionauth.RoleDM || actor.Role == sessionauth.RolePlayer) {
		return nil
	}
	return errAuthorizationRequired
}

func SessionAdminAuthorizer(service *sessionauth.Service) AdminAuthorizer {
	return func(r *http.Request) error {
		actor, ok := sessionauth.ActorFromContext(r.Context())
		if !ok || actor.RealRole != sessionauth.RoleDM || actor.Role != sessionauth.RoleDM {
			return errAuthorizationRequired
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			return nil
		}
		if service == nil || !service.ValidateCSRF(sessionToken(r), r.Header.Get(csrfHeaderName)) {
			return errAuthorizationRequired
		}
		return nil
	}
}

func (s *server) authState(w http.ResponseWriter, r *http.Request) {
	session, ok := s.authentication.Inspect(sessionToken(r))
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"role": nil, "realRole": nil})
		return
	}
	writeJSON(w, http.StatusOK, authSessionResponse(session))
}

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	client := authClientKey(r)
	now := time.Now().UTC()
	if allowed, retryAfter := s.loginLimiter.allow(client, now); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retryAfter.Seconds()))))
		writeAPIError(w, http.StatusTooManyRequests, "LOGIN_RATE_LIMITED", "too many login attempts")
		return
	}
	var request struct {
		Password string `json:"password"`
	}
	if !decodeBoundedJSON(w, r, &request, maxAuthBodyBytes, "authentication") {
		return
	}
	session, err := s.authentication.Login(request.Password)
	if err != nil {
		if errors.Is(err, sessionauth.ErrInvalidCredentials) {
			s.loginLimiter.failed(client, now)
			writeAPIError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "the supplied credentials are invalid")
			return
		}
		s.logger.Error("create login session", "error", err)
		writeAPIError(w, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "authentication is unavailable")
		return
	}
	s.loginLimiter.succeeded(client)
	s.setSessionCookie(w, session)
	writeJSON(w, http.StatusOK, authSessionResponse(session))
}

func (s *server) logout(w http.ResponseWriter, r *http.Request) {
	s.authentication.Revoke(sessionToken(r))
	s.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) viewAs(w http.ResponseWriter, r *http.Request) {
	actor, ok := sessionauth.ActorFromContext(r.Context())
	if !ok || actor.RealRole != sessionauth.RoleDM ||
		!s.authentication.ValidateCSRF(sessionToken(r), r.Header.Get(csrfHeaderName)) {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM authorization is required")
		return
	}
	var request struct {
		Role sessionauth.Role `json:"role"`
	}
	if !decodeBoundedJSON(w, r, &request, maxAuthBodyBytes, "authentication") {
		return
	}
	if request.Role != sessionauth.RoleDM && request.Role != sessionauth.RolePlayer {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "role must be dm or player")
		return
	}
	session, err := s.authentication.SwitchRole(sessionToken(r), request.Role)
	if err != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM authorization is required")
		return
	}
	s.setSessionCookie(w, session)
	writeJSON(w, http.StatusOK, authSessionResponse(session))
}

func authSessionResponse(session sessionauth.Session) map[string]any {
	return map[string]any{
		"ok": true, "role": session.Actor.Role, "realRole": session.Actor.RealRole,
		"csrfToken": session.CSRFToken, "expiresAt": session.ExpiresAt.UTC().Format(time.RFC3339Nano),
	}
}

func (s *server) setSessionCookie(w http.ResponseWriter, session sessionauth.Session) {
	maximumAge := int(time.Until(session.ExpiresAt).Seconds())
	if maximumAge < 1 {
		maximumAge = 1
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: session.Token, Path: "/",
		Expires: session.ExpiresAt, MaxAge: maximumAge, HttpOnly: true,
		Secure: s.secureCookies, SameSite: http.SameSiteLaxMode,
	})
}

func (s *server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: "", Path: "/",
		Expires: time.Unix(1, 0), MaxAge: -1, HttpOnly: true,
		Secure: s.secureCookies, SameSite: http.SameSiteLaxMode,
	})
}

func sessionToken(r *http.Request) string {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func authClientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	if len(r.RemoteAddr) > 200 {
		return r.RemoteAddr[:200]
	}
	return r.RemoteAddr
}
