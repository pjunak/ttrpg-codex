package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestFrontendServesIndexBuildAssetsAndMarkerArtwork(t *testing.T) {
	files := fstest.MapFS{
		"index.html":              &fstest.MapFile{Data: []byte("<title>Codex</title>")},
		"assets/app-123.js":       &fstest.MapFile{Data: []byte("export default 1")},
		"icons-defaults/city.svg": &fstest.MapFile{Data: []byte(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>`)},
		"private.txt":             &fstest.MapFile{Data: []byte("not a public asset")},
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
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		marker := httptest.NewRecorder()
		handler.ServeHTTP(marker, httptest.NewRequest(method, "/icons-defaults/city.svg", nil))
		if marker.Code != http.StatusOK || marker.Header().Get("Content-Type") != "image/svg+xml" ||
			marker.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("marker %s response = %d, %v", method, marker.Code, marker.Header())
		}
		if method == http.MethodGet && !strings.Contains(marker.Body.String(), "<svg") {
			t.Fatalf("marker body = %q", marker.Body.String())
		}
		if method == http.MethodHead && marker.Body.Len() != 0 {
			t.Fatal("HEAD returned a marker body")
		}
	}
	for _, path := range []string{"/missing", "/api/missing", "/private.txt", "/icons-defaults/", "/icons-defaults/missing.svg"} {
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
