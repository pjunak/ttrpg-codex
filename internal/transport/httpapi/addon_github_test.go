package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/githubsource"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type githubStub struct {
	calls       int
	err         error
	repo, token string
}

func (s *githubStub) Status(context.Context) (githubsource.Status, error) {
	s.calls++
	return githubsource.Status{ContractVersion: "addon-github.v1", Sources: []githubsource.LinkedSource{}, Credentials: githubsource.TokenStatus{DefaultSource: "stored", Repositories: []string{}}}, s.err
}
func (s *githubStub) SaveToken(_ context.Context, repo, token string) error {
	s.calls++
	s.repo = repo
	s.token = token
	return s.err
}
func (s *githubStub) SaveSource(context.Context, githubsource.LinkedSource, bool) error {
	s.calls++
	return s.err
}
func (s *githubStub) Discover(context.Context, githubsource.Source, string) (githubsource.Discovery, error) {
	s.calls++
	return githubsource.Discovery{}, s.err
}
func (s *githubStub) Stage(context.Context, githubsource.Source, string, string) (packagemanager.Generation, error) {
	s.calls++
	return packagemanager.Generation{}, s.err
}

func TestGitHubRoutesRequireRealDMAndCSRFBeforeParsing(t *testing.T) {
	auth := testAuthService(t)
	github := &githubStub{}
	if _, err := New(Config{AddonGitHub: github}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal("unprotected GitHub configuration accepted")
	}
	handler, err := New(Config{Authentication: auth, AddonLifecycle: &recordingLifecycle{}, AddonGitHub: github, AdminAuthorizer: SessionAdminAuthorizer(auth)})
	if err != nil {
		t.Fatal(err)
	}
	login := serveAuthRequest(handler, "POST", "/api/login", `{"password":"dragon-master"}`, "", "")
	cookie := login.Result().Cookies()[0].String()
	csrf := jsonStringField(t, login.Body.Bytes(), "csrfToken")
	player := serveAuthRequest(handler, "POST", "/api/login", `{"password":"party-member"}`, "", "")
	playerCookie := player.Result().Cookies()[0].String()
	playerCSRF := jsonStringField(t, player.Body.Bytes(), "csrfToken")
	for _, suffix := range []string{"", "/token", "/source", "/discover", "/stage"} {
		method := "POST"
		if suffix == "" {
			method = "GET"
		}
		for _, credentials := range [][2]string{{"", ""}, {playerCookie, playerCSRF}, {cookie, "wrong-csrf"}} {
			if method == "GET" && credentials[0] == cookie {
				continue
			}
			result := serveAuthRequest(handler, method, "/api/admin/addon-github"+suffix, "not-json", credentials[0], credentials[1])
			if result.Code != http.StatusForbidden {
				t.Fatalf("%s denied status %d", suffix, result.Code)
			}
		}
	}
	if github.calls != 0 {
		t.Fatal("GitHub service called without authority")
	}
	result := serveAuthRequest(handler, "POST", "/api/admin/addon-github/token", `{"repo":"owner/repo","token":"secret-token"}`, cookie, csrf)
	if result.Code != 200 || github.repo != "owner/repo" || github.token != "secret-token" || result.Header().Get("Cache-Control") != "no-store" || strings.Contains(result.Body.String(), "secret-token") {
		t.Fatalf("token boundary: %d %s", result.Code, result.Body.String())
	}
	before := github.calls
	for _, body := range []string{`{"repo":"owner/repo","token":"secret","unexpected":true}`, `{} {}`, strings.Repeat("a", maxAdminRequestBytes+1)} {
		result := serveAuthRequest(handler, "POST", "/api/admin/addon-github/token", body, cookie, csrf)
		if result.Code < 400 || github.calls != before {
			t.Fatal("invalid body reached credential store")
		}
	}
	github.err = errors.New("request failed at https://example.test?token=secret-token")
	result = serveAuthRequest(handler, "POST", "/api/admin/addon-github/discover", `{"source":{"repo":"owner/repo","channel":"release"}}`, cookie, csrf)
	if result.Code != 502 || strings.Contains(result.Body.String(), "secret-token") {
		t.Fatal("private upstream diagnostics exposed")
	}
	github.err = githubsource.ErrTLS
	result = serveAuthRequest(handler, "POST", "/api/admin/addon-github/discover", `{"source":{"repo":"owner/repo","channel":"release"}}`, cookie, csrf)
	if result.Code != 502 || !strings.Contains(result.Body.String(), "GITHUB_TLS") {
		t.Fatal("server TLS failure was not distinguished from repository access")
	}
	switched := serveAuthRequest(handler, "POST", "/api/view-as", `{"role":"player"}`, cookie, csrf)
	result = serveAuthRequest(handler, "GET", "/api/admin/addon-github", "", switched.Result().Cookies()[0].String(), "")
	if result.Code != 403 {
		t.Fatal("DM in player view could read GitHub settings")
	}
}
