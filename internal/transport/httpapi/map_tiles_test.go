package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	applicationmedia "github.com/pjunak/ttrpg-codex/internal/application/media"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/maptiles"
)

type mapTileStub struct {
	mediaStub
	calls  int
	hidden bool
}

func (stub *mapTileStub) MapManifest(_ context.Context, authority applicationmedia.Authority, _ string) (maptiles.Manifest, applicationmedia.Asset, error) {
	stub.calls++
	if stub.hidden && authority.Role != applicationmedia.RoleDM {
		return maptiles.Manifest{}, applicationmedia.Asset{}, applicationmedia.ErrNotFound
	}
	asset := stubAsset(false)
	asset.Binding.Kind = string(applicationmedia.LocationMap)
	if stub.hidden {
		asset.Blob.Visibility = blobstore.VisibilityDM
	}
	return maptiles.Manifest{Width: 513, Height: 300, TileSize: 256, Depth: 2}, asset, nil
}
func (stub *mapTileStub) OpenMapTile(ctx context.Context, authority applicationmedia.Authority, id string, level, x, y int) (*os.File, applicationmedia.Asset, error) {
	_, asset, err := stub.MapManifest(ctx, authority, id)
	if err != nil {
		return nil, asset, err
	}
	if level != 2 || x != 0 || y != 0 {
		return nil, asset, maptiles.ErrNotFound
	}
	file, err := os.Open(stub.openPath)
	return file, asset, err
}

func TestMapTileHTTPReauthorizesConditionalReadsAndHidesHostPaths(t *testing.T) {
	t.Parallel()
	filename := filepath.Join(t.TempDir(), "tile.png")
	if err := os.WriteFile(filename, []byte("tile bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	stub := &mapTileStub{mediaStub: mediaStub{openPath: filename}}
	handler, err := New(Config{Media: stub, MediaAuthorizer: func(r *http.Request) (applicationmedia.Authority, error) {
		role := applicationmedia.RoleAnonymous
		if r.Header.Get("Test-Role") == "dm" {
			role = applicationmedia.RoleDM
		}
		return applicationmedia.Authority{Role: role}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/media/b_11111111111111111111111111111111/tiles/v1/"
	request := func(path, etag, role string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, base+path, nil)
		r.Header.Set("If-None-Match", etag)
		r.Header.Set("Test-Role", role)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	manifest := request("manifest", "", "")
	if manifest.Code != 200 || !strings.Contains(manifest.Body.String(), `"contractVersion":"map-tiles.v1"`) || strings.Contains(manifest.Body.String(), filename) {
		t.Fatalf("manifest = %d %s", manifest.Code, manifest.Body)
	}
	tile := request("2/0/0", "", "")
	if tile.Code != 200 || tile.Body.String() != "tile bytes" || tile.Header().Get("Content-Type") != "image/png" || tile.Header().Get("Cache-Control") != "public, no-cache" {
		t.Fatalf("tile = %d %v", tile.Code, tile.Header())
	}
	conditional := request("2/0/0", tile.Header().Get("ETag"), "")
	if conditional.Code != 304 || stub.calls != 3 {
		t.Fatalf("conditional = %d calls %d", conditional.Code, stub.calls)
	}
	stub.hidden = true
	for _, path := range []string{"manifest", "2/0/0"} {
		denied := request(path, tile.Header().Get("ETag"), "")
		if denied.Code != 404 || denied.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("hidden %s = %d %v", path, denied.Code, denied.Header())
		}
	}
	dm := request("2/0/0", "", "dm")
	if dm.Code != 200 || dm.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("DM tile = %d %v", dm.Code, dm.Header())
	}
	for _, path := range []string{"02/0/0", "2/-1/0", "2/999999999999999999999/0", "2/0/0?x=1"} {
		if response := request(path, "", "dm"); response.Code < 400 {
			t.Fatalf("invalid %s = %d", path, response.Code)
		}
	}
}
