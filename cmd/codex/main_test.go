package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/application/campaigndata"
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
	dataDirectory := t.TempDir()
	runtime, err := composeHost(
		ctx, db, dataDirectory, "dragon-master", "party-member", false,
		slog.New(slog.DiscardHandler),
	)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.campaign == nil {
		t.Fatal("campaign data service was not composed")
	}
	t.Cleanup(func() { _ = runtime.addons.Shutdown(context.Background()) })

	anonymous := serve(runtime.handler, http.MethodGet, "/api/addons/browser-graph", "", nil)
	if anonymous.Code != http.StatusForbidden {
		t.Fatalf("anonymous graph status = %d", anonymous.Code)
	}
	publicCampaign := serve(runtime.handler, http.MethodGet, "/api/campaign", "", nil)
	if publicCampaign.Code != http.StatusOK ||
		!strings.Contains(publicCampaign.Body.String(), campaigndata.ContractVersion) {
		t.Fatalf("public campaign = %d, %s", publicCampaign.Code, publicCampaign.Body.String())
	}
	login := serve(runtime.handler, http.MethodPost, "/api/login", `{"password":"dragon-master"}`, nil)
	if login.Code != http.StatusOK || len(login.Result().Cookies()) != 1 {
		t.Fatalf("login = %d, %s", login.Code, login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	var loginBody struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &loginBody); err != nil || loginBody.CSRFToken == "" {
		t.Fatalf("login authority body = %+v, %v", loginBody, err)
	}
	mutationRequest := httptest.NewRequest(
		http.MethodPost,
		"/api/campaign/transactions",
		bytes.NewBufferString(`{
			"contractVersion":"campaign-mutation.v1",
			"mutations":[{
				"operation":"put","collection":"characters","key":"alice",
				"expectedRevision":0,"value":{"id":"alice","name":"Alice","visibility":"public"}
			}]
		}`),
	)
	mutationRequest.Header.Set("Content-Type", "application/json")
	mutationRequest.Header.Set("X-Codex-CSRF", loginBody.CSRFToken)
	mutationRequest.AddCookie(cookie)
	mutationResponse := httptest.NewRecorder()
	runtime.handler.ServeHTTP(mutationResponse, mutationRequest)
	if mutationResponse.Code != http.StatusOK {
		t.Fatalf("campaign mutation = %d, %s", mutationResponse.Code, mutationResponse.Body.String())
	}
	publicCampaign = serve(runtime.handler, http.MethodGet, "/api/campaign", "", nil)
	if publicCampaign.Code != http.StatusOK || !strings.Contains(publicCampaign.Body.String(), `"name":"Alice"`) {
		t.Fatalf("mutated public campaign = %d, %s", publicCampaign.Code, publicCampaign.Body.String())
	}
	mediaBody := []byte("\x89PNG\r\n\x1a\nportrait")
	mediaRequest := httptest.NewRequest(
		http.MethodPost, "/api/media/character-portrait/alice", bytes.NewReader(mediaBody),
	)
	mediaRequest.Header.Set("Content-Type", "image/png")
	mediaRequest.Header.Set("X-Codex-CSRF", loginBody.CSRFToken)
	mediaRequest.Header.Set("X-Codex-Filename", "alice.png")
	mediaRequest.AddCookie(cookie)
	mediaResponse := httptest.NewRecorder()
	runtime.handler.ServeHTTP(mediaResponse, mediaRequest)
	if mediaResponse.Code != http.StatusCreated {
		t.Fatalf("media upload = %d, %s", mediaResponse.Code, mediaResponse.Body.String())
	}
	var mediaResult struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(mediaResponse.Body.Bytes(), &mediaResult); err != nil || mediaResult.URL == "" {
		t.Fatalf("media response = %+v, %v", mediaResult, err)
	}
	publicMedia := serve(runtime.handler, http.MethodGet, mediaResult.URL, "", nil)
	if publicMedia.Code != http.StatusOK || !bytes.Equal(publicMedia.Body.Bytes(), mediaBody) {
		t.Fatalf("public media = %d, %q", publicMedia.Code, publicMedia.Body.Bytes())
	}
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
