package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestComposeHostWiresAuthenticatedBrowserGraphAndEvents(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := storage.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	runtime, err := composeHost(
		ctx, db, t.TempDir(), "dragon-master", "party-member", false,
		slog.New(slog.DiscardHandler),
	)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.campaign == nil {
		t.Fatal("campaign record store was not composed")
	}
	t.Cleanup(func() { _ = runtime.addons.Shutdown(context.Background()) })

	anonymous := serve(runtime.handler, http.MethodGet, "/api/addons/browser-graph", "", nil)
	if anonymous.Code != http.StatusForbidden {
		t.Fatalf("anonymous graph status = %d", anonymous.Code)
	}
	login := serve(runtime.handler, http.MethodPost, "/api/login", `{"password":"dragon-master"}`, nil)
	if login.Code != http.StatusOK || len(login.Result().Cookies()) != 1 {
		t.Fatalf("login = %d, %s", login.Code, login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	graph := serve(runtime.handler, http.MethodGet, "/api/addons/browser-graph", "", cookie)
	if graph.Code != http.StatusOK {
		t.Fatalf("authenticated graph = %d, %s", graph.Code, graph.Body.String())
	}
	var body struct {
		ContractVersion int    `json:"contractVersion"`
		GraphRevision   string `json:"graphRevision"`
	}
	if err := json.Unmarshal(graph.Body.Bytes(), &body); err != nil ||
		body.ContractVersion != 2 || len(body.GraphRevision) != 64 {
		t.Fatalf("graph body = %+v, %v", body, err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/events?unsupported=true", nil)
	request.AddCookie(cookie)
	eventsResponse := httptest.NewRecorder()
	runtime.handler.ServeHTTP(eventsResponse, request)
	if eventsResponse.Code != http.StatusBadRequest {
		t.Fatalf("authenticated event route = %d, %s", eventsResponse.Code, eventsResponse.Body.String())
	}
}

func serve(handler http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
