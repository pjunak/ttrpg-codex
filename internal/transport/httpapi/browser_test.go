package httpapi

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

func TestBrowserAddonConfigurationFailsClosed(t *testing.T) {
	t.Parallel()

	source := &recordingBrowserSource{}
	allow := BrowserAuthorizer(func(*http.Request) error { return nil })
	if _, err := New(Config{BrowserAddons: source}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("source without authorizer error = %v", err)
	}
	if _, err := New(Config{BrowserAuthorizer: allow}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("authorizer without source error = %v", err)
	}
	handler, err := New(Config{Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	response := serveBrowserRequest(handler, http.MethodGet, "/api/addons/browser-graph", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("unconfigured browser route status = %d", response.Code)
	}
}

func TestBrowserAuthorizationRunsBeforeGraphOrPathParsing(t *testing.T) {
	t.Parallel()

	source := &recordingBrowserSource{}
	handler := newBrowserHandler(t, source, func(*http.Request) error {
		return errors.New("private session detail")
	})
	for _, requestPath := range []string{
		"/api/addons/browser-graph?unsupported=true",
		"/api/addons/bad:id/generations/bad/assets/content/private.json",
	} {
		response := serveBrowserRequest(handler, http.MethodGet, requestPath, "")
		if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "private session") {
			t.Fatalf("path %q response = %d, %s", requestPath, response.Code, response.Body.String())
		}
	}
	if source.graphCalls != 0 || source.assetCalls != 0 {
		t.Fatalf("unauthorized source calls = graph %d, asset %d", source.graphCalls, source.assetCalls)
	}
}

func TestBrowserGraphUsesPrivateRevalidationContract(t *testing.T) {
	t.Parallel()

	revision := strings.Repeat("a", 64)
	source := &recordingBrowserSource{graph: packagemanager.BrowserGraph{
		ContractVersion: packagemanager.BrowserGraphContractVersion,
		GraphRevision:   revision,
		Addons:          []packagemanager.BrowserGeneration{},
	}}
	handler := newBrowserHandler(t, source, func(*http.Request) error { return nil })
	response := serveBrowserRequest(handler, http.MethodGet, "/api/addons/browser-graph", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), revision) {
		t.Fatalf("graph response = %d, %s", response.Code, response.Body.String())
	}
	assertHeader(t, response, "Cache-Control", "private, no-cache")
	assertHeader(t, response, "Content-Type", "application/json; charset=utf-8")
	assertHeader(t, response, "ETag", `"`+revision+`"`)
	assertHeader(t, response, "Vary", "Cookie, Authorization")
	assertHeader(t, response, "X-Content-Type-Options", "nosniff")

	notModified := serveBrowserRequest(
		handler, http.MethodGet, "/api/addons/browser-graph", `W/"`+revision+`"`,
	)
	if notModified.Code != http.StatusNotModified || notModified.Body.Len() != 0 {
		t.Fatalf("conditional graph response = %d, %q", notModified.Code, notModified.Body.String())
	}
	if source.graphCalls != 2 {
		t.Fatalf("graph calls = %d", source.graphCalls)
	}

	invalid := serveBrowserRequest(
		handler, http.MethodGet, "/api/addons/browser-graph?revision=old", "",
	)
	if invalid.Code != http.StatusBadRequest || source.graphCalls != 2 {
		t.Fatalf("query response/calls = %d, %d", invalid.Code, source.graphCalls)
	}
}

func TestBrowserAssetUsesImmutableChecksumContract(t *testing.T) {
	t.Parallel()

	digest := strings.Repeat("b", 64)
	source := &recordingBrowserSource{
		assetPath: "web/chunk.js",
		assetBody: []byte("export const answer = 42;\n"),
		assetSHA:  digest,
	}
	handler := newBrowserHandler(t, source, func(*http.Request) error { return nil })
	assetURL := "/api/addons/example-addon/generations/" + strings.Repeat("c", 64) + "/assets/web/chunk.js"
	response := serveBrowserRequest(handler, http.MethodGet, assetURL, "")
	if response.Code != http.StatusOK || response.Body.String() != string(source.assetBody) {
		t.Fatalf("asset response = %d, %q", response.Code, response.Body.String())
	}
	if source.assetAddonID != "example-addon" || source.assetGenerationID != strings.Repeat("c", 64) ||
		source.requestedAssetPath != "web/chunk.js" {
		t.Fatalf("asset request = %q, %q, %q", source.assetAddonID, source.assetGenerationID, source.requestedAssetPath)
	}
	assertHeader(t, response, "Cache-Control", "private, max-age=31536000, immutable")
	assertHeader(t, response, "Content-Type", "text/javascript; charset=utf-8")
	assertHeader(t, response, "ETag", `"`+digest+`"`)
	assertHeader(t, response, "Cross-Origin-Resource-Policy", "same-origin")
	assertHeader(t, response, "X-Content-Type-Options", "nosniff")

	notModified := serveBrowserRequest(handler, http.MethodGet, assetURL, `"`+digest+`"`)
	if notModified.Code != http.StatusNotModified || notModified.Body.Len() != 0 {
		t.Fatalf("conditional asset response = %d, %q", notModified.Code, notModified.Body.String())
	}
	head := serveBrowserRequest(handler, http.MethodHead, assetURL, "")
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") == "" {
		t.Fatalf("HEAD asset response = %d, length %q, body %q", head.Code, head.Header().Get("Content-Length"), head.Body.String())
	}

	previousCalls := source.assetCalls
	for _, invalidPath := range []string{
		"/api/addons/example-addon/generations/generation/assets/content/private.json",
		"/api/addons/example-addon/generations/generation/assets/web/index.js?cache=false",
	} {
		invalid := serveBrowserRequest(handler, http.MethodGet, invalidPath, "")
		if invalid.Code != http.StatusBadRequest {
			t.Fatalf("invalid path %q status = %d", invalidPath, invalid.Code)
		}
	}
	if source.assetCalls != previousCalls {
		t.Fatalf("invalid asset reached source: %d -> %d", previousCalls, source.assetCalls)
	}
}

func TestBrowserAssetErrorsAreStableAndRedacted(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    error
		status int
		kind   string
	}{
		{"missing", packagemanager.ErrBrowserAssetNotFound, http.StatusNotFound, "ADDON_ASSET_NOT_FOUND"},
		{"corrupt", errors.Join(packagemanager.ErrInvalidPackage, errors.New("private path")), http.StatusServiceUnavailable, "ADDON_ASSET_UNAVAILABLE"},
		{"internal", errors.New("private database path"), http.StatusInternalServerError, "INTERNAL"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			source := &recordingBrowserSource{assetError: test.err}
			handler := newBrowserHandler(t, source, func(*http.Request) error { return nil })
			response := serveBrowserRequest(
				handler,
				http.MethodGet,
				"/api/addons/example-addon/generations/generation/assets/web/index.js",
				"",
			)
			if response.Code != test.status || !strings.Contains(response.Body.String(), test.kind) ||
				strings.Contains(response.Body.String(), "private") {
				t.Fatalf("response = %d, %s", response.Code, response.Body.String())
			}
		})
	}
}

func newBrowserHandler(
	t *testing.T,
	source BrowserAddonSource,
	authorize func(*http.Request) error,
) http.Handler {
	t.Helper()
	handler, err := New(Config{
		Version: "test-version", Logger: slog.New(slog.DiscardHandler),
		BrowserAddons: source, BrowserAuthorizer: BrowserAuthorizer(authorize),
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func serveBrowserRequest(
	handler http.Handler,
	method string,
	requestPath string,
	ifNoneMatch string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, requestPath, nil)
	if ifNoneMatch != "" {
		request.Header.Set("If-None-Match", ifNoneMatch)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertHeader(t *testing.T, response *httptest.ResponseRecorder, name string, want string) {
	t.Helper()
	if got := response.Header().Get(name); got != want {
		t.Fatalf("%s = %q, want %q", name, got, want)
	}
}

type recordingBrowserSource struct {
	graph              packagemanager.BrowserGraph
	graphError         error
	graphCalls         int
	assetPath          string
	assetBody          []byte
	assetSHA           string
	assetError         error
	assetCalls         int
	assetAddonID       string
	assetGenerationID  string
	requestedAssetPath string
}

func (source *recordingBrowserSource) BrowserGraph(
	context.Context,
) (packagemanager.BrowserGraph, error) {
	source.graphCalls++
	return source.graph, source.graphError
}

func (source *recordingBrowserSource) OpenBrowserAsset(
	_ context.Context,
	addonID string,
	generationID string,
	assetPath string,
) (packagemanager.BrowserAsset, error) {
	source.assetCalls++
	source.assetAddonID = addonID
	source.assetGenerationID = generationID
	source.requestedAssetPath = assetPath
	if source.assetError != nil {
		return packagemanager.BrowserAsset{}, source.assetError
	}
	return packagemanager.BrowserAsset{
		Path: source.assetPath, SHA256: source.assetSHA, Bytes: uint64(len(source.assetBody)),
		Content: &readSeekCloser{Reader: bytes.NewReader(source.assetBody)},
	}, nil
}

type readSeekCloser struct {
	*bytes.Reader
}

func (*readSeekCloser) Close() error { return nil }

var _ BrowserAddonSource = (*recordingBrowserSource)(nil)
