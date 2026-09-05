package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strconv"

	applicationmedia "github.com/pjunak/ttrpg-codex/internal/application/media"
	"github.com/pjunak/ttrpg-codex/internal/storage/maptiles"
)

type MapTileAssets interface {
	MapManifest(context.Context, applicationmedia.Authority, string) (maptiles.Manifest, applicationmedia.Asset, error)
	OpenMapTile(context.Context, applicationmedia.Authority, string, int, int, int) (*os.File, applicationmedia.Asset, error)
}

func (s *server) mapTileRequest(w http.ResponseWriter, r *http.Request) (MapTileAssets, applicationmedia.Authority, bool) {
	// Errors must never cache a now-hidden map or a temporary generation failure.
	w.Header().Set("Cache-Control", "private, no-store")
	authority, err := s.mediaAuthorizer(r)
	if err != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "media read authorization is required")
		return nil, authority, false
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "map tile query parameters are not supported")
		return nil, authority, false
	}
	tiles, ok := s.media.(MapTileAssets)
	if !ok {
		writeAPIError(w, http.StatusServiceUnavailable, "MAP_TILES_UNAVAILABLE", "map tiles are unavailable")
	}
	return tiles, authority, ok
}

func (s *server) mapManifest(w http.ResponseWriter, r *http.Request) {
	tiles, authority, ok := s.mapTileRequest(w, r)
	if !ok {
		return
	}
	manifest, asset, err := tiles.MapManifest(r.Context(), authority, r.PathValue("blobID"))
	if err != nil {
		s.writeMediaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"contractVersion": "map-tiles.v1", "id": asset.Blob.ID,
		"width": manifest.Width, "height": manifest.Height, "tileSize": manifest.TileSize, "depth": manifest.Depth,
	})
}

func (s *server) readMapTile(w http.ResponseWriter, r *http.Request) {
	tiles, authority, ok := s.mapTileRequest(w, r)
	if !ok {
		return
	}
	coordinates := [3]int{}
	for index, key := range []string{"level", "x", "y"} {
		value := r.PathValue(key)
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 || strconv.Itoa(parsed) != value {
			writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "map tile was not found")
			return
		}
		coordinates[index] = parsed
	}
	file, asset, err := tiles.OpenMapTile(r.Context(), authority, r.PathValue("blobID"), coordinates[0], coordinates[1], coordinates[2])
	if err != nil {
		s.writeMediaError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("ETag", fmt.Sprintf(`"map-v1-%s-%d-%d-%d"`, asset.Blob.SHA256, coordinates[0], coordinates[1], coordinates[2]))
	setMediaCacheHeaders(w, asset)
	http.ServeContent(w, r, "tile.png", asset.Blob.CreatedAt, file)
}
