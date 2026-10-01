package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/events"
)

type sessionChangingEventSource struct {
	EventSource
	afterLatest func()
	afterReplay func()
}

func (source sessionChangingEventSource) Latest(ctx context.Context, audience events.Audience) (int64, error) {
	latest, err := source.EventSource.Latest(ctx, audience)
	if source.afterLatest != nil {
		source.afterLatest()
	}
	return latest, err
}

func (source sessionChangingEventSource) Replay(ctx context.Context, audience events.Audience, cursor int64, limit int) (events.Replay, error) {
	replay, err := source.EventSource.Replay(ctx, audience, cursor, limit)
	if source.afterReplay != nil {
		source.afterReplay()
	}
	return replay, err
}

func TestEventStreamRechecksSessionDuringInitialOutput(t *testing.T) {
	t.Parallel()
	for _, scenario := range []string{"hello", "replay", "reset", "between-replayed-events", "after-hello"} {
		t.Run(scenario, func(t *testing.T) {
			t.Parallel()
			service := testAuthService(t)
			session, err := service.Login("dragon-master")
			if err != nil {
				t.Fatal(err)
			}
			broker := testEventBroker(t)
			for _, key := range []string{"before-revocation", "after-revocation"} {
				if _, err := broker.Publish(t.Context(), events.Publication{
					Audience: events.AudienceDM, Topic: "admin-diagnostic", ResourceID: key, Revision: "1",
				}); err != nil {
					t.Fatal(err)
				}
			}
			var source EventSource = broker
			if scenario == "reset" {
				source = expiredEventSource{broker}
			}
			revoked := false
			revoke := func() {
				revoked = true
				service.Revoke(session.Token)
			}
			hooks := sessionChangingEventSource{EventSource: source}
			if scenario == "hello" {
				hooks.afterLatest = revoke
			} else if scenario == "replay" || scenario == "reset" {
				hooks.afterReplay = revoke
			}
			handler, err := New(Config{
				Logger: slog.New(slog.DiscardHandler), Authentication: service, Events: hooks,
				EventAuthorizer: SessionEventAuthorizer, EventHeartbeat: 20 * time.Second,
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			request := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
			request.Header.Set("Cookie", "edit_session="+session.Token)
			if scenario != "hello" && scenario != "after-hello" {
				request.Header.Set("Last-Event-ID", "0")
			}
			response := &credentialFlushRecorder{ResponseRecorder: httptest.NewRecorder()}
			if scenario == "between-replayed-events" || scenario == "after-hello" {
				response.first = revoke
			}
			handler.ServeHTTP(response, request)
			if !revoked {
				t.Fatal("the controlled revocation did not run")
			}
			body := response.Body.String()
			if strings.Contains(body, "after-revocation") || strings.Contains(body, "heartbeat") {
				t.Fatalf("output continued after revocation: %q", body)
			}
			if scenario == "between-replayed-events" {
				if !strings.Contains(body, "before-revocation") {
					t.Fatal("the authorized first replay event was lost")
				}
			} else if scenario == "after-hello" {
				if !strings.Contains(body, "event: hello") {
					t.Fatal("the authorized hello was lost")
				}
			} else if body != "" {
				t.Fatalf("revoked session received initial output: %q", body)
			}
			if ctx.Err() != nil {
				t.Fatal("initial revocation waited for request cancellation or the next heartbeat")
			}
		})
	}
}
