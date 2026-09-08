package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/events"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestEventConfigurationFailsClosed(t *testing.T) {
	t.Parallel()
	broker := testEventBroker(t)
	allow := EventAuthorizer(func(*http.Request) (events.Audience, error) { return events.AudiencePublic, nil })
	if _, err := New(Config{Events: broker}); err != ErrInvalidConfig {
		t.Fatalf("source without authorizer error = %v", err)
	}
	if _, err := New(Config{EventAuthorizer: allow}); err != ErrInvalidConfig {
		t.Fatalf("authorizer without source error = %v", err)
	}
}

func TestSessionEventAuthorizerUsesEffectiveAudience(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(http.MethodGet, "/api/events", nil)
	audience, err := SessionEventAuthorizer(request)
	if err != nil || audience != events.AudiencePublic {
		t.Fatalf("anonymous audience = %q, %v", audience, err)
	}
	request = request.WithContext(sessionauth.WithActor(request.Context(), sessionauth.Actor{
		SessionID: "dm-session", RealRole: sessionauth.RoleDM, Role: sessionauth.RolePlayer,
	}))
	audience, err = SessionEventAuthorizer(request)
	if err != nil || audience != events.AudiencePublic {
		t.Fatalf("DM-as-player audience = %q, %v", audience, err)
	}
	request = request.WithContext(sessionauth.WithActor(request.Context(), sessionauth.Actor{
		SessionID: "dm-session", RealRole: sessionauth.RoleDM, Role: sessionauth.RoleDM,
	}))
	audience, err = SessionEventAuthorizer(request)
	if err != nil || audience != events.AudienceDM {
		t.Fatalf("DM audience = %q, %v", audience, err)
	}
}

func TestEventAuthorizationRunsBeforeCursorParsing(t *testing.T) {
	t.Parallel()
	broker := testEventBroker(t)
	handler, err := New(Config{
		Logger: slog.New(slog.DiscardHandler), Events: broker,
		EventAuthorizer: func(*http.Request) (events.Audience, error) { return "", errAuthorizationRequired },
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/events?bad=true", nil)
	request.Header.Set("Last-Event-ID", "private-invalid-cursor")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "cursor") {
		t.Fatalf("response = %d, %s", response.Code, response.Body.String())
	}
}

func TestEventStreamSendsHelloAndRoleScopedReplay(t *testing.T) {
	t.Parallel()
	broker := testEventBroker(t)
	public, err := broker.Publish(context.Background(), events.Publication{
		Audience: events.AudiencePublic, Topic: "browser-addons-changed", Revision: "graph-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.Publish(context.Background(), events.Publication{
		Audience: events.AudienceDM, Topic: "admin-diagnostic", Revision: "diagnostic-1",
	}); err != nil {
		t.Fatal(err)
	}
	handler, err := New(Config{
		Logger: slog.New(slog.DiscardHandler), Events: broker,
		EventAuthorizer: func(*http.Request) (events.Audience, error) { return events.AudiencePublic, nil },
	})
	if err != nil {
		t.Fatal(err)
	}

	hello := serveOneFlush(handler, "")
	if hello.Code != http.StatusOK || !strings.Contains(hello.Body.String(), "event: hello") ||
		!strings.Contains(hello.Body.String(), `"cursor":`+stringInteger(public.Sequence)) ||
		strings.Contains(hello.Body.String(), "admin-diagnostic") {
		t.Fatalf("hello stream = %d, %q", hello.Code, hello.Body.String())
	}

	second, err := broker.Publish(context.Background(), events.Publication{
		Audience: events.AudiencePublic, Topic: "data-changed", Revision: "data-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	replay := serveOneFlush(handler, stringInteger(public.Sequence))
	if !strings.Contains(replay.Body.String(), "event: data-changed") ||
		!strings.Contains(replay.Body.String(), "id: "+stringInteger(second.Sequence)) ||
		strings.Contains(replay.Body.String(), "admin-diagnostic") {
		t.Fatalf("replay stream = %q", replay.Body.String())
	}
}

func serveOneFlush(handler http.Handler, cursor string) *cancelOnFlushRecorder {
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
	if cursor != "" {
		request.Header.Set("Last-Event-ID", cursor)
	}
	response := &cancelOnFlushRecorder{ResponseRecorder: httptest.NewRecorder(), cancel: cancel}
	handler.ServeHTTP(response, request)
	return response
}

func TestPasswordRotationClosesExistingDMLiveStream(t *testing.T) {
	t.Parallel()
	for _, publish := range []bool{false, true} {
		service := testAuthService(t)
		dm, _ := service.Login("dragon-master")
		old, _ := service.Login("dragon-master")
		broker := testEventBroker(t)
		handler, err := New(Config{Authentication: service, Events: broker, EventAuthorizer: SessionEventAuthorizer, EventHeartbeat: time.Second})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		request := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
		request.Header.Set("Cookie", "edit_session="+old.Token)
		response := &credentialFlushRecorder{ResponseRecorder: httptest.NewRecorder()}
		response.first = func() {
			if _, err := service.ChangePassword(ctx, dm.Token, dm.CSRFToken, "dragon-master", sessionauth.RoleDM, "rotated-master", 1); err != nil {
				t.Fatal(err)
			}
			if publish {
				if _, err := broker.Publish(ctx, events.Publication{Audience: events.AudienceDM, Topic: "admin-diagnostic", ResourceID: "private-after-rotation", Revision: "1"}); err != nil {
					t.Fatal(err)
				}
			}
		}
		handler.ServeHTTP(response, request)
		if ctx.Err() != nil {
			t.Fatal("revoked stream waited for request cancellation")
		}
		cancel()
		if !strings.Contains(response.Body.String(), "hello") || strings.Contains(response.Body.String(), "private-after-rotation") || strings.Contains(response.Body.String(), "heartbeat") {
			t.Fatalf("revoked stream output = %q", response.Body.String())
		}
	}
}

type credentialFlushRecorder struct {
	*httptest.ResponseRecorder
	first func()
}

func (recorder *credentialFlushRecorder) Flush() {
	recorder.ResponseRecorder.Flush()
	if recorder.first != nil {
		callback := recorder.first
		recorder.first = nil
		callback()
	}
}

type cancelOnFlushRecorder struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
}

func (response *cancelOnFlushRecorder) Flush() {
	response.ResponseRecorder.Flush()
	response.cancel()
}

func testEventBroker(t *testing.T) *events.Broker {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := storage.Migrate(context.Background(), db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	broker, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	return broker
}

func stringInteger(value int64) string {
	return strconv.FormatInt(value, 10)
}
