package media

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func TestMapTilesAlwaysFollowCurrentHandleAndOwnerVisibility(t *testing.T) {
	t.Parallel()
	records := recordMap{"locations:town": {Value: []byte(`{"name":"Town","visibility":"public"}`), Visibility: campaign.VisibilityPublic}}
	service, database := newTestService(t, records)
	defer database.Close()
	var encoded bytes.Buffer
	png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 513, 300)))
	ctx := context.Background()
	dm := Authority{Role: RoleDM}
	public := Authority{Role: RoleAnonymous}
	asset, err := service.Upload(ctx, dm, UploadRequest{Kind: LocationMap, TargetKey: "town", Content: bytes.NewReader(encoded.Bytes()), Bytes: uint64(encoded.Len()), MediaType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	manifest, _, err := service.MapManifest(ctx, public, asset.Blob.ID)
	if err != nil || manifest.Width != 513 {
		t.Fatalf("manifest = %+v, %v", manifest, err)
	}
	file, _, err := service.OpenMapTile(ctx, public, asset.Blob.ID, manifest.Depth, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	records["locations:town"] = campaign.Record{Value: []byte(`{"visibility":"dm"}`), Visibility: campaign.VisibilityDM}
	if _, _, err := service.MapManifest(ctx, public, asset.Blob.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("hidden manifest = %v", err)
	}
	if _, _, err := service.OpenMapTile(ctx, public, asset.Blob.ID, manifest.Depth, 0, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cached hidden tile = %v", err)
	}
	file, current, err := service.OpenMapTile(ctx, dm, asset.Blob.ID, manifest.Depth, 0, 0)
	if err != nil || current.Blob.Visibility != "dm" {
		t.Fatalf("DM tile = %+v, %v", current, err)
	}
	file.Close()
	if _, err := service.Delete(ctx, dm, asset.Blob.ID, asset.Blob.Revision); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.OpenMapTile(ctx, dm, asset.Blob.ID, manifest.Depth, 0, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted cached tile = %v", err)
	}
}
