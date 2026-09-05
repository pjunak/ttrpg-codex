package media

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/maptiles"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/mediastore"
)

const maximumInspectionBytes = 64 << 10

var (
	ErrInvalid   = errors.New("invalid media request")
	ErrForbidden = errors.New("media operation is forbidden")
	ErrNotFound  = errors.New("media asset not found")
	ErrConflict  = errors.New("media asset revision conflict")
)

type Kind string

const (
	CharacterPortrait Kind = "character-portrait"
	PetPortrait       Kind = "pet-portrait"
	LocationMap       Kind = "location-map"
	WorldMap          Kind = "world-map"
	MarkerIcon        Kind = "marker-icon"
	BrandingLogo      Kind = "branding-logo"
)

type Role string

const (
	RoleAnonymous Role = "anonymous"
	RolePlayer    Role = "player"
	RoleDM        Role = "dm"
)

type Authority struct {
	Role Role
}

type UploadRequest struct {
	Kind         Kind
	TargetKey    string
	Content      io.Reader
	Bytes        uint64
	MediaType    string
	OriginalName string
}

type Asset struct {
	Binding mediastore.Asset
	Blob    blobstore.Blob
}

type BlobStore interface {
	Create(context.Context, blobstore.CreateRequest) (blobstore.Blob, error)
	Metadata(context.Context, string) (blobstore.Blob, error)
	Open(context.Context, string) (*os.File, blobstore.Blob, error)
	Delete(context.Context, string, int64) (blobstore.Blob, error)
}

type AssetStore interface {
	Bind(context.Context, mediastore.Asset) (mediastore.Asset, error)
	Get(context.Context, string) (mediastore.Asset, error)
	Latest(context.Context, string, string) (mediastore.Asset, error)
}

type RecordReader interface {
	Get(context.Context, campaign.Collection, string) (campaign.Record, error)
}

type Config struct {
	Blobs            BlobStore
	Assets           AssetStore
	Records          RecordReader
	MapTileDirectory string
}

type Service struct {
	blobs    BlobStore
	assets   AssetStore
	records  RecordReader
	mapTiles *maptiles.Cache
}

func New(config Config) (*Service, error) {
	if config.Blobs == nil || config.Assets == nil || config.Records == nil {
		return nil, fmt.Errorf("%w: blob, asset, and campaign stores are required", ErrInvalid)
	}
	service := &Service{blobs: config.Blobs, assets: config.Assets, records: config.Records}
	if config.MapTileDirectory != "" {
		var err error
		service.mapTiles, err = maptiles.New(config.MapTileDirectory)
		if err != nil {
			return nil, fmt.Errorf("configure map tile cache: %w", err)
		}
	}
	return service, nil
}

func (service *Service) Upload(
	ctx context.Context,
	authority Authority,
	request UploadRequest,
) (Asset, error) {
	if authority.Role != RolePlayer && authority.Role != RoleDM {
		return Asset{}, ErrForbidden
	}
	visibility, privileged, err := service.target(ctx, request.Kind, request.TargetKey)
	if err != nil {
		return Asset{}, err
	}
	if privileged && authority.Role != RoleDM ||
		visibility == blobstore.VisibilityDM && authority.Role != RoleDM {
		return Asset{}, ErrForbidden
	}
	maximum, err := maximumBytes(request.Kind)
	if err != nil || request.Content == nil || request.Bytes == 0 || request.Bytes > maximum {
		return Asset{}, ErrInvalid
	}
	content, normalizedMediaType, err := inspectImage(request.Content, request.Bytes, request.MediaType)
	if err != nil {
		return Asset{}, err
	}
	blob, err := service.blobs.Create(ctx, blobstore.CreateRequest{
		Content: content, Bytes: request.Bytes,
		OwnerKind: blobstore.OwnerCore, OwnerID: "campaign", Purpose: "media",
		MediaType: normalizedMediaType, OriginalName: request.OriginalName,
		Visibility: visibility,
	})
	if err != nil {
		return Asset{}, fmt.Errorf("create media blob: %w", err)
	}
	binding, bindErr := service.assets.Bind(ctx, mediastore.Asset{
		BlobID: blob.ID, Kind: string(request.Kind), TargetKey: request.TargetKey,
		CreatedAt: blob.CreatedAt,
	})
	if bindErr != nil {
		_, cleanupErr := service.blobs.Delete(context.WithoutCancel(ctx), blob.ID, blob.Revision)
		return Asset{}, errors.Join(fmt.Errorf("bind media asset: %w", bindErr), cleanupErr)
	}
	return Asset{Binding: binding, Blob: blob}, nil
}

func (service *Service) Open(
	ctx context.Context,
	authority Authority,
	blobID string,
) (*os.File, Asset, error) {
	binding, err := service.assets.Get(ctx, blobID)
	if err != nil {
		return nil, Asset{}, mapAssetError(err)
	}
	file, blob, err := service.blobs.Open(ctx, blobID)
	if err != nil {
		return nil, Asset{}, mapBlobError(err)
	}
	if blob.OwnerKind != blobstore.OwnerCore || blob.OwnerID != "campaign" || blob.Purpose != "media" {
		_ = file.Close()
		return nil, Asset{}, fmt.Errorf("%w: core media ownership differs", blobstore.ErrCorrupt)
	}
	currentVisibility, _, err := service.target(ctx, Kind(binding.Kind), binding.TargetKey)
	if err != nil {
		_ = file.Close()
		if errors.Is(err, ErrNotFound) {
			return nil, Asset{}, ErrNotFound
		}
		return nil, Asset{}, err
	}
	if blob.Visibility == blobstore.VisibilityDM || currentVisibility == blobstore.VisibilityDM {
		blob.Visibility = blobstore.VisibilityDM
		if authority.Role != RoleDM {
			_ = file.Close()
			return nil, Asset{}, ErrNotFound
		}
	}
	return file, Asset{Binding: binding, Blob: blob}, nil
}

func (service *Service) Latest(
	ctx context.Context,
	authority Authority,
	kind Kind,
	targetKey string,
) (Asset, error) {
	visibility, _, err := service.target(ctx, kind, targetKey)
	if err != nil {
		return Asset{}, err
	}
	if visibility == blobstore.VisibilityDM && authority.Role != RoleDM {
		return Asset{}, ErrNotFound
	}
	binding, err := service.assets.Latest(ctx, string(kind), targetKey)
	if err != nil {
		return Asset{}, mapAssetError(err)
	}
	blob, err := service.blobs.Metadata(ctx, binding.BlobID)
	if err != nil {
		return Asset{}, mapBlobError(err)
	}
	if blob.Deleted {
		return Asset{}, ErrNotFound
	}
	if blob.Visibility == blobstore.VisibilityDM || visibility == blobstore.VisibilityDM {
		blob.Visibility = blobstore.VisibilityDM
	}
	return Asset{Binding: binding, Blob: blob}, nil
}

func (service *Service) Delete(
	ctx context.Context,
	authority Authority,
	blobID string,
	expectedRevision int64,
) (Asset, error) {
	if authority.Role != RolePlayer && authority.Role != RoleDM {
		return Asset{}, ErrForbidden
	}
	binding, err := service.assets.Get(ctx, blobID)
	if err != nil {
		return Asset{}, mapAssetError(err)
	}
	if authority.Role != RoleDM {
		visibility, privileged, targetErr := service.target(ctx, Kind(binding.Kind), binding.TargetKey)
		if targetErr != nil || privileged || visibility != blobstore.VisibilityPublic {
			return Asset{}, ErrForbidden
		}
	}
	blob, err := service.blobs.Metadata(ctx, blobID)
	if err != nil {
		return Asset{}, mapBlobError(err)
	}
	if blob.OwnerKind != blobstore.OwnerCore || blob.OwnerID != "campaign" || blob.Purpose != "media" {
		return Asset{}, fmt.Errorf("%w: core media ownership differs", blobstore.ErrCorrupt)
	}
	deleted, err := service.blobs.Delete(ctx, blobID, expectedRevision)
	if err != nil {
		return Asset{}, mapBlobError(err)
	}
	return Asset{Binding: binding, Blob: deleted}, nil
}

func (service *Service) target(
	ctx context.Context,
	kind Kind,
	targetKey string,
) (blobstore.Visibility, bool, error) {
	switch kind {
	case CharacterPortrait:
		return service.recordVisibility(ctx, campaign.Characters, targetKey)
	case PetPortrait:
		return service.recordVisibility(ctx, campaign.Pets, targetKey)
	case LocationMap:
		return service.recordVisibility(ctx, campaign.Locations, targetKey)
	case WorldMap, BrandingLogo:
		if targetKey != "main" {
			return "", false, ErrInvalid
		}
		return blobstore.VisibilityPublic, true, nil
	case MarkerIcon:
		if err := service.requirePinType(ctx, targetKey); err != nil {
			return "", false, err
		}
		return blobstore.VisibilityPublic, true, nil
	default:
		return "", false, ErrInvalid
	}
}

func (service *Service) recordVisibility(
	ctx context.Context,
	collection campaign.Collection,
	key string,
) (blobstore.Visibility, bool, error) {
	descriptor, _ := campaign.Describe(collection)
	if err := campaign.ValidateKey(descriptor, key); err != nil {
		return "", false, ErrInvalid
	}
	record, err := service.records.Get(ctx, collection, key)
	if err != nil {
		if errors.Is(err, campaign.ErrNotFound) {
			return "", false, ErrNotFound
		}
		return "", false, fmt.Errorf("read media owner: %w", err)
	}
	if record.Visibility == campaign.VisibilityDM {
		return blobstore.VisibilityDM, false, nil
	}
	return blobstore.VisibilityPublic, false, nil
}

func (service *Service) requirePinType(ctx context.Context, targetKey string) error {
	descriptor, _ := campaign.Describe(campaign.Settings)
	if len(targetKey) > 200 || campaign.ValidateKey(descriptor, targetKey) != nil {
		return ErrInvalid
	}
	record, err := service.records.Get(ctx, campaign.Settings, "pinTypes")
	if err != nil {
		if errors.Is(err, campaign.ErrNotFound) {
			return ErrNotFound
		}
		return fmt.Errorf("read pin types: %w", err)
	}
	var values []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(record.Value, &values); err != nil {
		return fmt.Errorf("invalid pin type settings: %w", err)
	}
	for _, value := range values {
		if value.ID == targetKey {
			return nil
		}
	}
	return ErrNotFound
}

func maximumBytes(kind Kind) (uint64, error) {
	switch kind {
	case CharacterPortrait, PetPortrait:
		return 20 << 20, nil
	case LocationMap, WorldMap:
		return 40 << 20, nil
	case MarkerIcon:
		return 2 << 20, nil
	case BrandingLogo:
		return 5 << 20, nil
	default:
		return 0, ErrInvalid
	}
}

func inspectImage(content io.Reader, size uint64, suppliedMediaType string) (io.Reader, string, error) {
	mediaType, parameters, err := mime.ParseMediaType(suppliedMediaType)
	if err != nil {
		return nil, "", ErrInvalid
	}
	mediaType = strings.ToLower(mediaType)
	if len(parameters) != 0 && mediaType != "image/svg+xml" {
		return nil, "", ErrInvalid
	}
	prefixSize := min(size, maximumInspectionBytes)
	prefix := make([]byte, prefixSize)
	if _, err := io.ReadFull(content, prefix); err != nil {
		return nil, "", fmt.Errorf("%w: image ended before its declared size", ErrInvalid)
	}
	detected := http.DetectContentType(prefix[:min(len(prefix), 512)])
	switch mediaType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		if detected != mediaType {
			return nil, "", fmt.Errorf("%w: image content does not match %s", ErrInvalid, mediaType)
		}
	case "image/svg+xml":
		if !validSVG(prefix) {
			return nil, "", fmt.Errorf("%w: SVG root was not found", ErrInvalid)
		}
	default:
		return nil, "", fmt.Errorf("%w: unsupported image media type", ErrInvalid)
	}
	return io.MultiReader(bytes.NewReader(prefix), content),
		mime.FormatMediaType(mediaType, parameters), nil
}

func validSVG(prefix []byte) bool {
	decoder := xml.NewDecoder(bufio.NewReader(bytes.NewReader(prefix)))
	for {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		switch value := token.(type) {
		case xml.StartElement:
			return strings.EqualFold(value.Name.Local, "svg")
		case xml.CharData:
			if len(bytes.TrimSpace(value)) != 0 {
				return false
			}
		case xml.Directive:
			return false
		}
	}
}

func mapBlobError(err error) error {
	switch {
	case errors.Is(err, blobstore.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, blobstore.ErrConflict):
		return ErrConflict
	default:
		return err
	}
}

func mapAssetError(err error) error {
	if errors.Is(err, mediastore.ErrNotFound) {
		return ErrNotFound
	}
	return err
}
