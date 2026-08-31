package httpapi

import (
	"bytes"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
)

func TestAuthenticationRoutesIssueResolveRotateAndRevokeSessions(t *testing.T) {
	t.Parallel()
	service := testAuthService(t)
	handler, err := New(Config{Version: "test", Logger: slog.New(slog.DiscardHandler), Authentication: service})
	if err != nil {
		t.Fatal(err)
	}

	anonymous := serveAuthRequest(handler, http.MethodGet, "/api/auth", "", "", "")
	if anonymous.Code != http.StatusOK || !strings.Contains(anonymous.Body.String(), `"role":null`) {
		t.Fatalf("anonymous auth = %d, %s", anonymous.Code, anonymous.Body.String())
	}
	bad := serveAuthRequest(handler, http.MethodPost, "/api/login", `{"password":"wrong"}`, "", "")
	if bad.Code != http.StatusUnauthorized || strings.Contains(bad.Body.String(), "dragon-master") {
		t.Fatalf("bad login = %d, %s", bad.Code, bad.Body.String())
	}
	login := serveAuthRequest(handler, http.MethodPost, "/api/login", `{"password":"dragon-master"}`, "", "")
	if login.Code != http.StatusOK || !strings.Contains(login.Body.String(), `"role":"dm"`) {
		t.Fatalf("login = %d, %s", login.Code, login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	csrf := jsonStringField(t, login.Body.Bytes(), "csrfToken")
	probe := serveAuthRequest(handler, http.MethodGet, "/api/auth", "", cookie.String(), "")
	if probe.Code != http.StatusOK || !strings.Contains(probe.Body.String(), `"realRole":"dm"`) ||
		jsonStringField(t, probe.Body.Bytes(), "csrfToken") != csrf {
		t.Fatalf("auth probe = %d, %s", probe.Code, probe.Body.String())
	}
	switched := serveAuthRequest(handler, http.MethodPost, "/api/view-as", `{"role":"player"}`, cookie.String(), csrf)
	if switched.Code != http.StatusOK || !strings.Contains(switched.Body.String(), `"role":"player"`) {
		t.Fatalf("view as player = %d, %s", switched.Code, switched.Body.String())
	}
	rotated := switched.Result().Cookies()[0]
	if rotated.Value == cookie.Value {
		t.Fatal("role transition did not rotate the session")
	}
	stale := serveAuthRequest(handler, http.MethodGet, "/api/auth", "", cookie.String(), "")
	if !strings.Contains(stale.Body.String(), `"role":null`) {
		t.Fatalf("stale session probe = %s", stale.Body.String())
	}
	logout := serveAuthRequest(handler, http.MethodPost, "/api/logout", `{}`, rotated.String(), "")
	if logout.Code != http.StatusOK || logout.Result().Cookies()[0].MaxAge != -1 {
		t.Fatalf("logout = %d, cookies %+v", logout.Code, logout.Result().Cookies())
	}
}

func TestSessionAuthorizersEnforceAuthenticationRoleAndCSRF(t *testing.T) {
	t.Parallel()
	service := testAuthService(t)
	lifecycle := &recordingLifecycle{}
	source := &recordingBrowserSource{}
	handler, err := New(Config{
		Version: "test", Logger: slog.New(slog.DiscardHandler), Authentication: service,
		AddonLifecycle: lifecycle, AdminAuthorizer: SessionAdminAuthorizer(service),
		BrowserAddons: source, BrowserAuthorizer: SessionBrowserAuthorizer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if response := serveAuthRequest(handler, http.MethodGet, "/api/addons/browser-graph", "", "", ""); response.Code != http.StatusForbidden {
		t.Fatalf("anonymous browser graph status = %d", response.Code)
	}
	login := serveAuthRequest(handler, http.MethodPost, "/api/login", `{"password":"dragon-master"}`, "", "")
	cookie := login.Result().Cookies()[0]
	csrf := jsonStringField(t, login.Body.Bytes(), "csrfToken")
	graph := serveAuthRequest(handler, http.MethodGet, "/api/addons/browser-graph", "", cookie.String(), "")
	if graph.Code != http.StatusOK {
		t.Fatalf("authenticated browser graph = %d, %s", graph.Code, graph.Body.String())
	}
	withoutCSRF := serveAuthRequest(handler, http.MethodPost, "/api/admin/addons/example.addon/reload", `{"expectedStateRevision":1}`, cookie.String(), "")
	if withoutCSRF.Code != http.StatusForbidden || lifecycle.reloadCalls != 0 {
		t.Fatalf("admin without CSRF = %d, calls %d", withoutCSRF.Code, lifecycle.reloadCalls)
	}
	withCSRF := serveAuthRequest(handler, http.MethodPost, "/api/admin/addons/example.addon/reload", `{"expectedStateRevision":1}`, cookie.String(), csrf)
	if withCSRF.Code != http.StatusOK || lifecycle.reloadCalls != 1 {
		t.Fatalf("admin with CSRF = %d, calls %d", withCSRF.Code, lifecycle.reloadCalls)
	}
}

func testAuthService(t *testing.T) *sessionauth.Service {
	t.Helper()
	sequence := 0
	service, err := sessionauth.New(sessionauth.Config{
		DMPassword: "dragon-master", PlayerPassword: "party-member",
		GenerateToken: func() (string, error) {
			sequence++
			return fmt.Sprintf("token_%026d", sequence), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func serveAuthRequest(handler http.Handler, method, path, body, cookie, csrf string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	if csrf != "" {
		request.Header.Set(csrfHeaderName, csrf)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func jsonStringField(t *testing.T, body []byte, name string) string {
	t.Helper()
	marker := `"` + name + `":"`
	start := bytes.Index(body, []byte(marker))
	if start < 0 {
		t.Fatalf("field %q missing from %s", name, body)
	}
	value := body[start+len(marker):]
	end := bytes.IndexByte(value, '"')
	if end < 0 {
		t.Fatalf("field %q is unterminated in %s", name, body)
	}
	return string(value[:end])
}
