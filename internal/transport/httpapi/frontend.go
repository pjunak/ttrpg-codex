package httpapi

import (
	"bytes"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"time"
)

func newFrontendHandler(files fs.FS) (http.Handler, error) {
	if files == nil {
		return nil, nil
	}
	index, err := fs.ReadFile(files, "index.html")
	if err != nil {
		return nil, fmt.Errorf("read frontend index: %w", err)
	}
	assets := http.FileServerFS(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(index))
		case strings.HasPrefix(r.URL.Path, "/assets/"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			assets.ServeHTTP(w, r)
		case strings.HasPrefix(r.URL.Path, "/icons-defaults/") && strings.HasSuffix(r.URL.Path, ".svg"):
			name := strings.TrimPrefix(r.URL.Path, "/")
			info, err := fs.Stat(files, name)
			if err != nil || !info.Mode().IsRegular() {
				http.NotFound(w, r)
				return
			}
			// Marker filenames are stable across builds, unlike hashed assets.
			w.Header().Set("Cache-Control", "no-cache")
			assets.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	}), nil
}
