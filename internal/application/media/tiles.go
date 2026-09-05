package media

import (
	"context"
	"github.com/pjunak/ttrpg-codex/internal/storage/maptiles"
	"os"
)

func (service *Service) MapManifest(ctx context.Context, authority Authority, blobID string) (maptiles.Manifest, Asset, error) {
	// Cache hits are not authorization tokens: re-resolve the handle and its
	// current campaign owner even if another reader already built the pyramid.
	file, asset, err := service.Open(ctx, authority, blobID)
	if err != nil {
		return maptiles.Manifest{}, Asset{}, err
	}
	defer file.Close()
	if asset.Binding.Kind != string(WorldMap) && asset.Binding.Kind != string(LocationMap) {
		return maptiles.Manifest{}, Asset{}, ErrNotFound
	}
	if service.mapTiles == nil {
		return maptiles.Manifest{}, Asset{}, maptiles.ErrUnsupported
	}
	manifest, err := service.mapTiles.Ensure(ctx, asset.Blob.SHA256, file)
	if err != nil {
		return maptiles.Manifest{}, Asset{}, err
	}
	return manifest, asset, nil
}

func (service *Service) OpenMapTile(ctx context.Context, authority Authority, blobID string, level, x, y int) (*os.File, Asset, error) {
	if level < 0 || level > 7 || x < 0 || y < 0 || x >= 128 || y >= 128 {
		return nil, Asset{}, maptiles.ErrNotFound
	}
	manifest, asset, err := service.MapManifest(ctx, authority, blobID)
	if err != nil {
		return nil, Asset{}, err
	}
	file, err := service.mapTiles.Open(asset.Blob.SHA256, manifest, level, x, y)
	return file, asset, err
}
