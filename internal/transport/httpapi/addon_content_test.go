package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

func TestAddonContentConfigurationFailsClosed(t *testing.T) {
	t.Parallel()
	source := &addonContentStub{}
	allow := BrowserAuthorizer(func(*http.Request) error { return nil })
	if _, err := New(Config{AddonContent: source}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("source-only error = %v", err)
	}
	if _, err := New(Config{ContentAuthorizer: allow}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("authorizer-only error = %v", err)
	}
}

func TestAddonContentCatalogRecordAndBoundedQuery(t *testing.T) {
	t.Parallel()
	registry := contentHTTPRegistry(t)
	handler := addonContentHandler(t, &addonContentStub{registry: registry}, func(*http.Request) error { return nil })
	base := addonContentURL("")

	catalog := httptest.NewRecorder()
	handler.ServeHTTP(catalog, httptest.NewRequest(http.MethodGet, base, nil))
	if catalog.Code != http.StatusOK ||
		!strings.Contains(catalog.Body.String(), `"contractVersion":"addon-content-catalog.v1"`) ||
		!strings.Contains(catalog.Body.String(), `"recordCount":3`) ||
		catalog.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("catalog = %d, %s, headers=%v", catalog.Code, catalog.Body.String(), catalog.Header())
	}

	record := httptest.NewRecorder()
	handler.ServeHTTP(record, httptest.NewRequest(
		http.MethodGet, base+"/records?set=rules&kind=spell&id=shield", nil,
	))
	if record.Code != http.StatusOK ||
		!strings.Contains(record.Body.String(), `"contractVersion":"addon-content-record.v1"`) ||
		!strings.Contains(record.Body.String(), `"name":"Shield"`) {
		t.Fatalf("record = %d, %s", record.Code, record.Body.String())
	}

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(
		http.MethodGet, base+"/query?set=rules&kind=spell&limit=1", nil,
	))
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), `"id":"magic-missile"`) ||
		!strings.Contains(first.Body.String(), `"nextCursor":`) {
		t.Fatalf("first page = %d, %s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	var page struct {
		NextCursor string `json:"nextCursor"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	handler.ServeHTTP(second, httptest.NewRequest(
		http.MethodGet, base+"/query?set=rules&kind=spell&limit=1&cursor="+page.NextCursor, nil,
	))
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), `"id":"shield"`) ||
		strings.Contains(second.Body.String(), "nextCursor") {
		t.Fatalf("second page = %d, %s", second.Code, second.Body.String())
	}
}

func TestAddonContentRejectsUnauthorizedMalformedAndStaleRequests(t *testing.T) {
	t.Parallel()
	registry := contentHTTPRegistry(t)
	denied := addonContentHandler(t, &addonContentStub{registry: registry}, func(*http.Request) error {
		return errAuthorizationRequired
	})
	response := httptest.NewRecorder()
	denied.ServeHTTP(response, httptest.NewRequest(http.MethodGet, addonContentURL(""), nil))
	if response.Code != http.StatusForbidden {
		t.Fatalf("denied status = %d", response.Code)
	}

	allowed := addonContentHandler(t, &addonContentStub{registry: registry}, func(*http.Request) error { return nil })
	for _, target := range []string{
		addonContentURL("/records?set=rules&kind=spell"),
		addonContentURL("/query?set=rules&limit=201"),
		addonContentURL("/query?set=rules&cursor=not-canonical"),
		addonContentURL("/query?set=rules&extra=true"),
	} {
		response = httptest.NewRecorder()
		allowed.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body = %s", target, response.Code, response.Body.String())
		}
	}

	stale := addonContentHandler(t, &addonContentStub{err: packagemanager.ErrNotActive}, func(*http.Request) error { return nil })
	response = httptest.NewRecorder()
	stale.ServeHTTP(response, httptest.NewRequest(http.MethodGet, addonContentURL(""), nil))
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"kind":"STALE_GENERATION"`) {
		t.Fatalf("stale = %d, %s", response.Code, response.Body.String())
	}
}

type addonContentStub struct {
	registry *contentcontract.Registry
	err      error
}

func (stub *addonContentStub) ContentRegistry(_, _ string) (*contentcontract.Registry, error) {
	return stub.registry, stub.err
}

func addonContentHandler(t *testing.T, source AddonContent, authorize BrowserAuthorizer) http.Handler {
	t.Helper()
	handler, err := New(Config{
		Logger: slog.New(slog.DiscardHandler), AddonContent: source, ContentAuthorizer: authorize,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func addonContentURL(suffix string) string {
	return "/api/addons/compendium/generations/" + strings.Repeat("a", 64) + "/content" + suffix
}

func contentHTTPRegistry(t *testing.T) *contentcontract.Registry {
	t.Helper()
	schemas, err := datacontract.Compile([]datacontract.Declaration{{
		Kind: datacontract.Collection, ID: "rules", Keyed: true,
		Visibility: datacontract.VisibilityPublic,
		Schema:     "contracts/rule.json", SchemaVersion: "fixture-1",
	}}, map[string][]byte{"contracts/rule.json": []byte(`{
		"type":"object","required":["kind","id","name"],
		"properties":{"kind":{"type":"string"},"id":{"type":"string"},"name":{"type":"string"}}
	}`)})
	if err != nil {
		t.Fatal(err)
	}
	registry, err := contentcontract.Compile([]contentcontract.Declaration{{
		ID: "rules", Root: "content/rules", Schema: "contracts/rule.json", Revision: "fixture-1",
		Groups: &contentcontract.Groups{Field: "source", Label: "Source"},
	}}, []contentcontract.File{
		{Path: "content/rules/class/wizard.json", Body: []byte(`{"kind":"class","id":"wizard","name":"Wizard"}`)},
		{Path: "content/rules/spell/magic-missile.json", Body: []byte(`{"kind":"spell","id":"magic-missile","name":"Magic Missile"}`)},
		{Path: "content/rules/spell/shield.json", Body: []byte(`{"kind":"spell","id":"shield","name":"Shield"}`)},
	}, schemas)
	if err != nil {
		t.Fatal(err)
	}
	return registry
}
