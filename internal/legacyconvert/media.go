package legacyconvert

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	applicationmedia "github.com/pjunak/ttrpg-codex/internal/application/media"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/mediastore"
)

const mediaMigrationActor = "migration:v1-media"

type legacyMediaMigrator struct {
	service  *applicationmedia.Service
	files    map[string]*zip.File
	consumed map[string]struct{}
	report   MediaReport
}

func importLegacyMedia(
	ctx context.Context,
	database *sql.DB,
	dataDirectory string,
	files map[string]*zip.File,
	now time.Time,
) (MediaReport, InventoryGroup, error) {
	eventBroker, err := events.New(events.Config{DB: database, Now: func() time.Time { return now }})
	if err != nil {
		return MediaReport{}, InventoryGroup{}, fmt.Errorf("create conversion event journal: %w", err)
	}
	records, err := campaignstore.New(campaignstore.Config{
		DB: database, Events: eventBroker, Now: func() time.Time { return now },
	})
	if err != nil {
		return MediaReport{}, InventoryGroup{}, fmt.Errorf("open converted campaign records: %w", err)
	}
	blobs, err := blobstore.New(database, filepath.Join(dataDirectory, "blobs"), blobstore.Options{
		Now: func() time.Time { return now },
	})
	if err != nil {
		return MediaReport{}, InventoryGroup{}, fmt.Errorf("open conversion blob store: %w", err)
	}
	assets, err := mediastore.New(database)
	if err != nil {
		return MediaReport{}, InventoryGroup{}, fmt.Errorf("open conversion media bindings: %w", err)
	}
	service, err := applicationmedia.New(applicationmedia.Config{
		Blobs: blobs, Assets: assets, Records: records,
	})
	if err != nil {
		return MediaReport{}, InventoryGroup{}, fmt.Errorf("create conversion media service: %w", err)
	}
	migrator := &legacyMediaMigrator{
		service: service, files: files, consumed: make(map[string]struct{}),
	}

	mutations := make([]campaign.Mutation, 0)
	for _, specification := range []struct {
		collection campaign.Collection
		kind       applicationmedia.Kind
		field      string
		prefix     string
	}{
		{campaign.Characters, applicationmedia.CharacterPortrait, "portrait", "/portraits/"},
		{campaign.Pets, applicationmedia.PetPortrait, "portrait", "/portraits/"},
		{campaign.Locations, applicationmedia.LocationMap, "localMap", "/maps/local/"},
	} {
		rewrites, err := migrator.rewriteRecordField(
			ctx, records, specification.collection, specification.kind,
			specification.field, specification.prefix,
		)
		if err != nil {
			return MediaReport{}, InventoryGroup{}, err
		}
		mutations = append(mutations, rewrites...)
	}
	settings, err := migrator.rewriteSettings(ctx, records)
	if err != nil {
		return MediaReport{}, InventoryGroup{}, err
	}
	mutations = append(mutations, settings...)
	if err := migrator.importWorldMap(ctx); err != nil {
		return MediaReport{}, InventoryGroup{}, err
	}
	if err := applyMediaRewrites(ctx, records, mutations); err != nil {
		return MediaReport{}, InventoryGroup{}, err
	}
	migrator.report.RewrittenRecords = len(mutations)

	var unreferenced InventoryGroup
	for name, file := range files {
		if deferredGroup(name) != "media" {
			continue
		}
		if _, imported := migrator.consumed[name]; imported {
			continue
		}
		if strings.HasPrefix(name, "data/maps/tiles/") {
			migrator.report.DiscardedDerived.Files++
			migrator.report.DiscardedDerived.Bytes += file.UncompressedSize64
			continue
		}
		unreferenced.Files++
		unreferenced.Bytes += file.UncompressedSize64
	}
	return migrator.report, unreferenced, nil
}

func validateConvertedBlobs(ctx context.Context, database *sql.DB, dataDirectory string) error {
	blobs, err := blobstore.New(database, filepath.Join(dataDirectory, "blobs"), blobstore.Options{})
	if err != nil {
		return fmt.Errorf("open converted blobs for validation: %w", err)
	}
	if err := blobs.Validate(ctx); err != nil {
		return fmt.Errorf("validate converted blobs: %w", err)
	}
	return nil
}

func (migrator *legacyMediaMigrator) rewriteRecordField(
	ctx context.Context,
	records *campaignstore.Store,
	collection campaign.Collection,
	kind applicationmedia.Kind,
	field string,
	prefix string,
) ([]campaign.Mutation, error) {
	values, err := records.List(ctx, collection, true)
	if err != nil {
		return nil, fmt.Errorf("list legacy %s media owners: %w", collection, err)
	}
	mutations := make([]campaign.Mutation, 0)
	for _, record := range values {
		object := make(map[string]json.RawMessage)
		if err := json.Unmarshal(record.Value, &object); err != nil {
			return nil, fmt.Errorf("decode legacy %s %q: %w", collection, record.Key, err)
		}
		var legacyURL string
		if raw, present := object[field]; !present || json.Unmarshal(raw, &legacyURL) != nil || legacyURL == "" {
			continue
		}
		entryName, applicable, err := legacyMediaEntry(legacyURL, prefix)
		if err != nil {
			return nil, fmt.Errorf("resolve legacy %s %q media: %w", collection, record.Key, err)
		}
		if !applicable {
			continue
		}
		mediaURL, err := migrator.upload(ctx, kind, record.Key, entryName)
		if err != nil {
			return nil, fmt.Errorf("migrate legacy %s %q media: %w", collection, record.Key, err)
		}
		object[field], _ = json.Marshal(mediaURL)
		body, err := json.Marshal(object)
		if err != nil {
			return nil, fmt.Errorf("rewrite legacy %s %q media: %w", collection, record.Key, err)
		}
		mutations = append(mutations, campaign.Mutation{
			Kind: campaign.Put, Collection: collection, Key: record.Key,
			Value: body, ExpectedRevision: record.Revision,
		})
	}
	return mutations, nil
}

func (migrator *legacyMediaMigrator) rewriteSettings(
	ctx context.Context,
	records *campaignstore.Store,
) ([]campaign.Mutation, error) {
	mutations := make([]campaign.Mutation, 0, 2)
	branding, err := records.Get(ctx, campaign.Settings, "branding")
	if err == nil {
		object := make(map[string]json.RawMessage)
		if decodeErr := json.Unmarshal(branding.Value, &object); decodeErr != nil {
			return nil, fmt.Errorf("decode legacy branding: %w", decodeErr)
		}
		var legacyURL string
		if raw, present := object["logoUrl"]; present && json.Unmarshal(raw, &legacyURL) == nil && legacyURL != "" {
			entryName, applicable, resolveErr := legacyMediaEntry(legacyURL, "/branding/")
			if resolveErr != nil {
				return nil, fmt.Errorf("resolve legacy branding media: %w", resolveErr)
			}
			if applicable {
				mediaURL, uploadErr := migrator.upload(
					ctx, applicationmedia.BrandingLogo, "main", entryName,
				)
				if uploadErr != nil {
					return nil, fmt.Errorf("migrate legacy branding media: %w", uploadErr)
				}
				object["logoUrl"], _ = json.Marshal(mediaURL)
				body, marshalErr := json.Marshal(object)
				if marshalErr != nil {
					return nil, fmt.Errorf("rewrite legacy branding media: %w", marshalErr)
				}
				mutations = append(mutations, campaign.Mutation{
					Kind: campaign.Put, Collection: campaign.Settings, Key: branding.Key,
					Value: body, ExpectedRevision: branding.Revision,
				})
			}
		}
	} else if !errors.Is(err, campaign.ErrNotFound) {
		return nil, fmt.Errorf("read legacy branding: %w", err)
	}

	pinTypes, err := records.Get(ctx, campaign.Settings, "pinTypes")
	if errors.Is(err, campaign.ErrNotFound) {
		return mutations, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read legacy pin types: %w", err)
	}
	var pins []map[string]json.RawMessage
	if err := json.Unmarshal(pinTypes.Value, &pins); err != nil {
		return nil, fmt.Errorf("decode legacy pin types: %w", err)
	}
	changed := false
	for _, pin := range pins {
		var pinID string
		if json.Unmarshal(pin["id"], &pinID) != nil || pinID == "" {
			continue
		}
		var configuration map[string]json.RawMessage
		if json.Unmarshal(pin["iconConfig"], &configuration) != nil {
			continue
		}
		var iconFiles []map[string]json.RawMessage
		if json.Unmarshal(configuration["files"], &iconFiles) != nil {
			continue
		}
		pinChanged := false
		for _, icon := range iconFiles {
			var legacyURL string
			if json.Unmarshal(icon["url"], &legacyURL) != nil || legacyURL == "" {
				continue
			}
			entryName, applicable, resolveErr := legacyMediaEntry(legacyURL, "/icons/")
			if resolveErr != nil {
				return nil, fmt.Errorf("resolve legacy marker icon %q: %w", pinID, resolveErr)
			}
			if !applicable {
				continue
			}
			mediaURL, uploadErr := migrator.upload(
				ctx, applicationmedia.MarkerIcon, pinID, entryName,
			)
			if uploadErr != nil {
				return nil, fmt.Errorf("migrate legacy marker icon %q: %w", pinID, uploadErr)
			}
			icon["url"], _ = json.Marshal(mediaURL)
			pinChanged = true
			changed = true
		}
		if pinChanged {
			configuration["files"], _ = json.Marshal(iconFiles)
			pin["iconConfig"], _ = json.Marshal(configuration)
		}
	}
	if changed {
		body, err := json.Marshal(pins)
		if err != nil {
			return nil, fmt.Errorf("rewrite legacy marker icons: %w", err)
		}
		mutations = append(mutations, campaign.Mutation{
			Kind: campaign.Put, Collection: campaign.Settings, Key: pinTypes.Key,
			Value: body, ExpectedRevision: pinTypes.Revision,
		})
	}
	return mutations, nil
}

func (migrator *legacyMediaMigrator) importWorldMap(ctx context.Context) error {
	candidates := make([]string, 0, 1)
	for name := range migrator.files {
		if strings.HasPrefix(name, "data/maps/swordcoast/sword_coast.") &&
			mediaTypeForLegacyName(name) != "" {
			candidates = append(candidates, name)
		}
	}
	sort.Strings(candidates)
	if len(candidates) > 1 {
		return fmt.Errorf("%w: multiple canonical world maps found: %s", ErrInvalidLegacyBackup, strings.Join(candidates, ", "))
	}
	if len(candidates) == 1 {
		if _, err := migrator.upload(ctx, applicationmedia.WorldMap, "main", candidates[0]); err != nil {
			return fmt.Errorf("migrate legacy world map: %w", err)
		}
	}
	return nil
}

func (migrator *legacyMediaMigrator) upload(
	ctx context.Context,
	kind applicationmedia.Kind,
	targetKey string,
	entryName string,
) (string, error) {
	file := migrator.files[entryName]
	if file == nil {
		return "", fmt.Errorf("%w: referenced media %q is missing", ErrInvalidLegacyBackup, entryName)
	}
	mediaType := mediaTypeForLegacyName(entryName)
	if mediaType == "" {
		return "", fmt.Errorf("%w: referenced media %q has an unsupported type", ErrInvalidLegacyBackup, entryName)
	}
	reader, err := file.Open()
	if err != nil {
		return "", fmt.Errorf("open %q: %w", entryName, err)
	}
	asset, uploadErr := migrator.service.Upload(ctx, applicationmedia.Authority{Role: applicationmedia.RoleDM}, applicationmedia.UploadRequest{
		Kind: kind, TargetKey: targetKey, Content: reader,
		Bytes: file.UncompressedSize64, MediaType: mediaType, OriginalName: path.Base(entryName),
	})
	closeErr := reader.Close()
	if err := errors.Join(uploadErr, closeErr); err != nil {
		return "", err
	}
	if _, seen := migrator.consumed[entryName]; !seen {
		migrator.consumed[entryName] = struct{}{}
		migrator.report.Imported.Files++
		migrator.report.Imported.Bytes += file.UncompressedSize64
	}
	migrator.report.Bindings++
	return "/api/media/" + asset.Blob.ID, nil
}

func applyMediaRewrites(
	ctx context.Context,
	records *campaignstore.Store,
	mutations []campaign.Mutation,
) error {
	for start := 0; start < len(mutations); start += campaignstore.MaximumMutations {
		end := min(start+campaignstore.MaximumMutations, len(mutations))
		if _, err := records.Transact(ctx, campaign.Transaction{
			ActorID: mediaMigrationActor, Mutations: mutations[start:end],
		}); err != nil {
			return fmt.Errorf("commit legacy media URLs: %w", err)
		}
	}
	return nil
}

func legacyMediaEntry(value, expectedPrefix string) (string, bool, error) {
	clean := value
	if index := strings.IndexAny(clean, "?#"); index >= 0 {
		clean = clean[:index]
	}
	if !strings.HasPrefix(clean, expectedPrefix) {
		return "", false, nil
	}
	unescaped, err := url.PathUnescape(clean)
	if err != nil || strings.Contains(unescaped, "\\") {
		return "", false, ErrInvalidLegacyBackup
	}
	entryName := "data" + unescaped
	if !safeZipPath(entryName) {
		return "", false, ErrInvalidLegacyBackup
	}
	return entryName, true, nil
}

func mediaTypeForLegacyName(filename string) string {
	switch strings.ToLower(path.Ext(filename)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	default:
		return ""
	}
}
