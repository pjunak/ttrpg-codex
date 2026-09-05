package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/events"
)

func TestPreviewEventStreamStopsAfterRevocationOrExpiry(t *testing.T) {
	t.Parallel()
	for _, transition := range []string{"revoke", "expire"} {
		t.Run(transition, func(t *testing.T) {
			now := time.Now().UTC()
			service, _ := sessionauth.New(sessionauth.Config{DMPassword: "dragon-master", Now: func() time.Time { return now }})
			dm, _ := service.Login("dragon-master")
			preview, err := service.CreatePlayerPreview(dm.Token)
			if err != nil {
				t.Fatal(err)
			}
			broker := testEventBroker(t)
			handler, err := New(Config{Authentication: service, Events: broker, EventAuthorizer: SessionEventAuthorizer})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			r := httptest.NewRequest("GET", "/api/events?playerPreviewToken="+preview.Token, nil).WithContext(ctx)
			r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: dm.Token})
			var first sync.Once
			w := &cancelOnFlushRecorder{ResponseRecorder: httptest.NewRecorder(), cancel: func() {
				first.Do(func() {
					if transition == "revoke" {
						service.Revoke(dm.Token)
					} else {
						now = now.Add(time.Hour)
					}
					if _, err := broker.Publish(ctx, events.Publication{Audience: events.AudiencePublic, Topic: "after-preview-ended", Revision: "1"}); err != nil {
						t.Error(err)
					}
				})
			}}
			handler.ServeHTTP(w, r)
			if ctx.Err() != nil || w.Code != 200 || !strings.Contains(w.Body.String(), `"audience":"public"`) ||
				strings.Contains(w.Body.String(), "after-preview-ended") {
				t.Fatal("preview stream retained access after ending")
			}
		})
	}
}

func TestPlayerPreviewRoutesNeverReplaceOrFallBackToDMCookie(t *testing.T) {
	t.Parallel()
	service := testAuthService(t)
	handler, err := New(Config{Authentication: service})
	if err != nil {
		t.Fatal(err)
	}
	dm, _ := service.Login("dragon-master")
	cookie := (&http.Cookie{Name: sessionCookieName, Value: dm.Token}).String()
	call := func(method, path, body, token, csrf string, explicit bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Cookie", cookie)
		r.Header.Set(csrfHeaderName, csrf)
		if explicit {
			r.Header.Set(playerPreviewHeader, token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if response := call("POST", "/api/player-preview", "", "", "", false); response.Code != 403 {
		t.Fatal("missing CSRF accepted")
	}
	created := call("POST", "/api/player-preview", "", "", dm.CSRFToken, false)
	if created.Code != 201 || len(created.Result().Cookies()) != 0 {
		t.Fatalf("preview creation = %d, cookies %d", created.Code, len(created.Result().Cookies()))
	}
	token := jsonStringField(t, created.Body.Bytes(), "token")
	probe := call("GET", "/api/auth", "", token, "", true)
	if probe.Code != 200 || strings.Contains(probe.Body.String(), `"dm"`) || !strings.Contains(probe.Body.String(), `"realRole":"player"`) {
		t.Fatal("preview did not receive player authority")
	}
	csrf := jsonStringField(t, probe.Body.Bytes(), "csrfToken")
	if response := call("GET", "/api/events?playerPreviewToken="+token, "", token, "", true); response.Code != 401 {
		t.Fatal("conflicting header and query credentials were accepted")
	}
	duplicate := httptest.NewRequest("GET", "/api/auth", nil)
	duplicate.Header.Set("Cookie", cookie)
	duplicate.Header.Add(playerPreviewHeader, token)
	duplicate.Header.Add(playerPreviewHeader, token)
	duplicateResponse := httptest.NewRecorder()
	handler.ServeHTTP(duplicateResponse, duplicate)
	if duplicateResponse.Code != 401 {
		t.Fatal("duplicate preview headers were accepted")
	}
	for _, path := range []string{"/api/view-as", "/api/login", "/api/player-preview"} {
		response := call("POST", path, `{"role":"dm","password":"dragon-master"}`, token, csrf, true)
		if response.Code != 403 || len(response.Result().Cookies()) != 0 {
			t.Fatalf("preview changed auth through %s", path)
		}
	}
	for _, invalid := range []string{"", "invalid", dm.Token} {
		for _, path := range []string{"/api/auth", "/api/campaign", "/api/events", "/api/media/b_00000000000000000000000000000000"} {
			if response := call("GET", path, "", invalid, "", true); response.Code != 401 {
				t.Fatalf("invalid preview fell back at %s", path)
			}
		}
	}
	for _, query := range []string{"playerPreviewToken=", "playerPreviewToken=bad", "playerPreviewToken=" + token + "&playerPreviewToken=" + token} {
		if response := call("GET", "/api/events?"+query, "", "", "", false); response.Code != 401 {
			t.Fatal("invalid query preview fell back")
		}
	}
	if response := call("GET", "/api/events?playerPreviewToken="+token+";ignored", "", "", "", false); response.Code != 401 {
		t.Fatal("malformed query fell back")
	}
	if response := call("GET", "/api/auth?playerPreviewToken="+token, "", "", "", false); response.Code != 401 {
		t.Fatal("preview query accepted on non-resource route")
	}
	closed := call("POST", "/api/logout", "", token, "", true)
	if closed.Code != 200 || len(closed.Result().Cookies()) != 0 {
		t.Fatal("preview logout touched shared cookie")
	}
	if response := call("GET", "/api/auth", "", token, "", true); response.Code != 401 {
		t.Fatal("closed preview retained authority")
	}
	if current, ok := service.Inspect(dm.Token); !ok || current.CSRFToken != dm.CSRFToken {
		t.Fatal("DM session changed")
	}
}
