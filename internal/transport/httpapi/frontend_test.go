package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestFrontendServesOnlyIndexAndImmutableBuildAssets(t *testing.T) {
	files := fstest.MapFS{
		"index.html":        &fstest.MapFile{Data: []byte("<title>Codex</title>")},
		"assets/app-123.js": &fstest.MapFile{Data: []byte("export default 1")},
	}
	handler, err := New(Config{Frontend: files})
	if err != nil {
		t.Fatal(err)
	}
	index := httptest.NewRecorder()
	handler.ServeHTTP(index, httptest.NewRequest(http.MethodGet, "/", nil))
	if index.Code != http.StatusOK || !strings.Contains(index.Body.String(), "Codex") ||
		index.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("index response = %d, %q, %q", index.Code, index.Body.String(), index.Header().Get("Cache-Control"))
	}
	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/assets/app-123.js", nil))
	if asset.Code != http.StatusOK || !strings.Contains(asset.Body.String(), "export default") ||
		asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset response = %d, %q, %q", asset.Code, asset.Body.String(), asset.Header().Get("Cache-Control"))
	}
	for _, path := range []string{"/missing", "/api/missing"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "Codex") {
			t.Fatalf("%s response = %d, %q", path, response.Code, response.Body.String())
		}
	}
}

func TestFrontendRequiresBuiltIndex(t *testing.T) {
	if _, err := New(Config{Frontend: fstest.MapFS{}}); err == nil {
		t.Fatal("server accepted a frontend without index.html")
	}
}
