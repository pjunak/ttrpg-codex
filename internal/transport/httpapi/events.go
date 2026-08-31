package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/events"
)

const defaultEventHeartbeat = 20 * time.Second

type EventSource interface {
	Latest(context.Context, events.Audience) (int64, error)
	Replay(context.Context, events.Audience, int64, int) (events.Replay, error)
	Subscribe(events.Audience) (*events.Subscription, error)
}

type EventAuthorizer func(*http.Request) (events.Audience, error)

var _ EventSource = (*events.Broker)(nil)

func SessionEventAuthorizer(r *http.Request) (events.Audience, error) {
	actor, ok := sessionauth.ActorFromContext(r.Context())
	if !ok {
		return "", errAuthorizationRequired
	}
	if actor.Role == sessionauth.RoleDM {
		return events.AudienceDM, nil
	}
	if actor.Role == sessionauth.RolePlayer {
		return events.AudiencePublic, nil
	}
	return "", errAuthorizationRequired
}

func (s *server) registerEventRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/events", http.HandlerFunc(s.eventStream))
}

func (s *server) eventStream(w http.ResponseWriter, r *http.Request) {
	audience, err := s.eventAuthorizer(r)
	if err != nil {
		s.logger.Warn("event stream access denied", "path", r.URL.Path)
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "event stream authorization is required")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	cursor, supplied, err := parseEventCursor(r.Header.Get("Last-Event-ID"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_EVENT_CURSOR", "Last-Event-ID must be a non-negative integer")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIError(w, http.StatusInternalServerError, "EVENT_STREAM_UNAVAILABLE", "event streaming is unavailable")
		return
	}
	subscription, err := s.events.Subscribe(audience)
	if err != nil {
		status := http.StatusServiceUnavailable
		if !errors.Is(err, events.ErrSubscriberCapacity) {
			status = http.StatusInternalServerError
			s.logger.Error("subscribe event stream", "error", err)
		}
		writeAPIError(w, status, "EVENT_STREAM_UNAVAILABLE", "event streaming is unavailable")
		return
	}
	defer subscription.Close()

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Vary", "Cookie, Authorization")
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
	heartbeat := s.eventHeartbeat
	if heartbeat == 0 {
		heartbeat = defaultEventHeartbeat
	}
	lastSent, err := s.startEventStream(r.Context(), w, flusher, audience, cursor, supplied)
	if err != nil {
		s.logger.Error("start event stream", "error", err)
		return
	}
	_ = controller.SetWriteDeadline(time.Now().Add(heartbeat + 10*time.Second))
	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, open := <-subscription.Events:
			if !open {
				return
			}
			if event.Sequence <= lastSent {
				continue
			}
			if err := writeSSE(w, flusher, event.Topic, event.Sequence, event); err != nil {
				return
			}
			lastSent = event.Sequence
			_ = controller.SetWriteDeadline(time.Now().Add(heartbeat + 10*time.Second))
		case at := <-ticker.C:
			if _, err := fmt.Fprintf(w, ": heartbeat %d\n\n", at.UTC().Unix()); err != nil {
				return
			}
			flusher.Flush()
			_ = controller.SetWriteDeadline(time.Now().Add(heartbeat + 10*time.Second))
		}
	}
}

func (s *server) startEventStream(
	ctx context.Context,
	w http.ResponseWriter,
	flusher http.Flusher,
	audience events.Audience,
	cursor int64,
	supplied bool,
) (int64, error) {
	if !supplied {
		latest, err := s.events.Latest(ctx, audience)
		if err != nil {
			return 0, err
		}
		if err := writeSSE(w, flusher, "hello", latest, map[string]any{
			"cursor": latest, "audience": audience,
		}); err != nil {
			return 0, err
		}
		return latest, nil
	}
	replay, err := s.events.Replay(ctx, audience, cursor, events.DefaultReplayLimit)
	if err != nil {
		return 0, err
	}
	if cursor > replay.Latest || replay.Truncated {
		if err := writeSSE(w, flusher, "reset", replay.Latest, map[string]any{
			"cursor": replay.Latest, "reason": "replay-unavailable",
		}); err != nil {
			return 0, err
		}
		return replay.Latest, nil
	}
	lastSent := cursor
	for _, event := range replay.Events {
		if err := writeSSE(w, flusher, event.Topic, event.Sequence, event); err != nil {
			return 0, err
		}
		lastSent = event.Sequence
	}
	return lastSent, nil
}

func parseEventCursor(value string) (int64, bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false, nil
	}
	cursor, err := strconv.ParseInt(value, 10, 64)
	if err != nil || cursor < 0 {
		return 0, true, errors.New("invalid event cursor")
	}
	return cursor, true, nil
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, eventName string, id int64, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", id, eventName, body); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}
