package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"strings"
	"time"
	"unicode"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type BrowserAddonSource interface {
	BrowserGraph(context.Context) (packagemanager.BrowserGraph, error)
	OpenBrowserAsset(context.Context, string, string, string) (packagemanager.BrowserAsset, error)
}

type BrowserAuthorizer func(*http.Request) error

var _ BrowserAddonSource = (*packagemanager.Manager)(nil)

func (s *server) registerBrowserAddonRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/addons/browser-graph", s.requireBrowserAccess(http.HandlerFunc(s.browserGraph)))
	mux.Handle(
		"GET /api/addons/{addonID}/generations/{generationID}/assets/{assetPath...}",
		s.requireBrowserAccess(http.HandlerFunc(s.browserAsset)),
	)
}

func (s *server) requireBrowserAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.browserAuthorizer(r); err != nil {
			s.logger.Warn("browser add-on access denied", "method", r.Method, "path", r.URL.Path)
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "browser add-on authorization is required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) browserGraph(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return
	}
	graph, err := s.browserAddons.BrowserGraph(r.Context())
	if err != nil {
		s.logger.Error("browser add-on graph failed", "error", err)
		writeAPIError(w, http.StatusInternalServerError, "BROWSER_GRAPH_UNAVAILABLE", "the browser add-on graph is unavailable")
		return
	}
	etag := quotedETag(graph.GraphRevision)
	setPrivateBrowserHeaders(w)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("ETag", etag)
	if requestETagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(graph)
}

func (s *server) browserAsset(w http.ResponseWriter, r *http.Request) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return
	}
	generationID, ok := pathResourceID(w, r, "generationID")
	if !ok {
		return
	}
	assetPath := r.PathValue("assetPath")
	if r.URL.RawQuery != "" || !validBrowserAssetRequestPath(assetPath) {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "browser asset path is invalid")
		return
	}
	asset, err := s.browserAddons.OpenBrowserAsset(
		r.Context(), addonID, generationID, assetPath,
	)
	if err != nil {
		s.writeBrowserAssetError(w, r, err)
		return
	}
	defer asset.Content.Close()

	setPrivateBrowserHeaders(w)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Content-Type", browserAssetContentType(asset.Path))
	w.Header().Set("ETag", quotedETag(asset.SHA256))
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	http.ServeContent(w, r, asset.Path, time.Time{}, asset.Content)
}

func (s *server) writeBrowserAssetError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	kind := "INTERNAL"
	message := "the browser add-on asset request failed"
	switch {
	case errors.Is(err, packagemanager.ErrBrowserAssetNotFound):
		status = http.StatusNotFound
		kind = "ADDON_ASSET_NOT_FOUND"
		message = packagemanager.ErrBrowserAssetNotFound.Error()
	case errors.Is(err, packagemanager.ErrInvalidPackage):
		status = http.StatusServiceUnavailable
		kind = "ADDON_ASSET_UNAVAILABLE"
		message = "the browser add-on asset is unavailable"
	}
	s.logger.Error(
		"browser add-on asset failed",
		"method", r.Method, "path", r.URL.Path, "kind", kind, "error", err,
	)
	writeAPIError(w, status, kind, message)
}

func setPrivateBrowserHeaders(w http.ResponseWriter) {
	w.Header().Set("Vary", "Cookie, Authorization")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func quotedETag(digest string) string {
	return `"` + digest + `"`
}

func requestETagMatches(header string, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || candidate == etag || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}

func validBrowserAssetRequestPath(value string) bool {
	if value == "" || len(value) > 2_000 || strings.Contains(value, "\\") ||
		strings.HasPrefix(value, "/") || path.Clean(value) != value ||
		!strings.HasPrefix(value, "web/") || value == "web/" {
		return false
	}
	for _, character := range value {
		if character == 0 || unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func browserAssetContentType(filename string) string {
	extension := strings.ToLower(path.Ext(filename))
	if contentType, exists := browserContentTypes[extension]; exists {
		return contentType
	}
	return "application/octet-stream"
}

var browserContentTypes = map[string]string{
	".avif":  "image/avif",
	".css":   "text/css; charset=utf-8",
	".gif":   "image/gif",
	".html":  "text/html; charset=utf-8",
	".ico":   "image/x-icon",
	".jpeg":  "image/jpeg",
	".jpg":   "image/jpeg",
	".js":    "text/javascript; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".mp3":   "audio/mpeg",
	".mp4":   "video/mp4",
	".ogg":   "audio/ogg",
	".otf":   "font/otf",
	".png":   "image/png",
	".svg":   "image/svg+xml",
	".ttf":   "font/ttf",
	".txt":   "text/plain; charset=utf-8",
	".wasm":  "application/wasm",
	".wav":   "audio/wav",
	".webm":  "video/webm",
	".webp":  "image/webp",
	".woff":  "font/woff",
	".woff2": "font/woff2",
}
