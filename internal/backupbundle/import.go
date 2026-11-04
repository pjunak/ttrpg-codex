package backupbundle

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/pjunak/ttrpg-codex/internal/jsonexact"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/recoverystore"
)

// Import validates the bundle at path and adds each of its parts as an
// "imported" recovery point. Files the parts use are added as logically
// deleted handles, so restoring a part revives exactly those it lists.
// Current campaign and add-on data stay as they are.
func (bundles Bundles) Import(ctx context.Context, path string) (Manifest, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return Manifest{}, invalid("not a ZIP archive")
	}
	defer archive.Close()
	entries := map[string]*zip.File{}
	var expanded uint64
	for _, file := range archive.File {
		if entries[file.Name] != nil {
			return Manifest{}, invalid("%s appears twice", file.Name)
		}
		if !file.Mode().IsRegular() {
			return Manifest{}, invalid("%s is not a regular file", file.Name)
		}
		expanded += file.UncompressedSize64
		if expanded > maximumExpandedBytes || len(entries) >= 2+maximumParts+maximumBlobs {
			return Manifest{}, invalid("archive expands beyond the limits")
		}
		entries[file.Name] = file
	}
	body, err := readEntry(entries[manifestPath], maximumManifestBytes)
	if err != nil {
		return Manifest{}, fmt.Errorf("%w (manifest)", err)
	}
	var manifest Manifest
	if err := jsonexact.Decode(body, &manifest); err != nil {
		return Manifest{}, invalid("manifest: %v", err)
	}
	var hostMigration int64
	if err := bundles.DB.QueryRowContext(ctx, `SELECT COALESCE(max(version), 0) FROM schema_migrations`).Scan(&hostMigration); err != nil {
		return Manifest{}, err
	}
	if err := manifest.validate(hostMigration); err != nil {
		return Manifest{}, err
	}
	declared := map[string]uint64{manifestPath: uint64(len(body))}
	for _, part := range manifest.Parts {
		declared[part.Path] = uint64(part.Bytes)
	}
	blobs := make(map[string]Blob, len(manifest.Blobs))
	for _, blob := range manifest.Blobs {
		blobs[blob.ID] = blob
		declared[objectPath(blob.SHA256)] = blob.Bytes
	}
	for name, file := range entries {
		size, ok := declared[name]
		if !ok {
			return Manifest{}, invalid("undeclared file %s", name)
		}
		if file.UncompressedSize64 != size {
			return Manifest{}, invalid("%s has a different size than declared", name)
		}
	}
	if len(entries) != len(declared) {
		return Manifest{}, invalid("declared files are missing")
	}
	images := make([]string, len(manifest.Parts))
	for index, part := range manifest.Parts {
		image, err := readEntry(entries[part.Path], recoverystore.MaxImageBytes)
		if err != nil {
			return Manifest{}, err
		}
		if digestOf(image) != part.SHA256 {
			return Manifest{}, invalid("%s does not match its digest", part.Path)
		}
		if err := validateImage(part.scope(), image, blobs); err != nil {
			return Manifest{}, err
		}
		images[index] = string(image)
	}
	handles, err := bundles.missingHandles(ctx, manifest.Blobs)
	if err != nil {
		return Manifest{}, err
	}
	imported := map[string]bool{}
	for _, handle := range handles {
		if imported[handle.SHA256] {
			continue
		}
		imported[handle.SHA256] = true
		if err := bundles.importObject(ctx, entries[objectPath(handle.SHA256)], handle); err != nil {
			return Manifest{}, err
		}
	}
	tx, err := bundles.DB.BeginTx(ctx, nil)
	if err != nil {
		return Manifest{}, err
	}
	defer tx.Rollback()
	for _, handle := range handles {
		if err := bundles.Blobs.ImportHandle(ctx, tx, handle); err != nil {
			if errors.Is(err, blobstore.ErrInvalid) || errors.Is(err, blobstore.ErrConflict) {
				return Manifest{}, invalid("file %s: %v", handle.ID, err)
			}
			return Manifest{}, err
		}
	}
	for index, part := range manifest.Parts {
		if err := recoverystore.InsertImported(ctx, tx, part.scope(), part.CreatedAt, images[index]); err != nil {
			return Manifest{}, err
		}
	}
	return manifest, tx.Commit()
}

// missingHandles returns the bundle's handles this host lacks. A handle that
// exists must name the same content and owner.
func (bundles Bundles) missingHandles(ctx context.Context, blobs []Blob) ([]blobstore.Blob, error) {
	var missing []blobstore.Blob
	for _, blob := range blobs {
		var digest, kind, owner string
		err := bundles.DB.QueryRowContext(ctx, `SELECT object_sha256, owner_kind, owner_id FROM blobs WHERE blob_id = ?`, blob.ID).Scan(&digest, &kind, &owner)
		if err == nil {
			if digest != blob.SHA256 || kind != blob.OwnerKind || owner != blob.OwnerID {
				return nil, invalid("file %s exists here with other content or owner", blob.ID)
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		handle, err := blob.handle()
		if err != nil {
			return nil, err
		}
		missing = append(missing, handle)
	}
	return missing, nil
}

func (bundles Bundles) importObject(ctx context.Context, file *zip.File, handle blobstore.Blob) error {
	content, err := file.Open()
	if err != nil {
		return invalid("%s: %v", file.Name, err)
	}
	defer content.Close()
	if err := bundles.Blobs.ImportObject(ctx, handle.SHA256, handle.Bytes, content); err != nil {
		if errors.Is(err, blobstore.ErrInvalid) {
			return invalid("%s: %v", file.Name, err)
		}
		return err
	}
	return nil
}

func readEntry(file *zip.File, limit uint64) ([]byte, error) {
	if file == nil {
		return nil, invalid("missing file")
	}
	if file.UncompressedSize64 > limit {
		return nil, invalid("%s is too large", file.Name)
	}
	content, err := file.Open()
	if err != nil {
		return nil, invalid("%s: %v", file.Name, err)
	}
	defer content.Close()
	body, err := io.ReadAll(io.LimitReader(content, int64(limit)+1))
	if err != nil {
		return nil, invalid("%s: %v", file.Name, err)
	}
	if uint64(len(body)) != file.UncompressedSize64 {
		return nil, invalid("%s has a different size than declared", file.Name)
	}
	return body, nil
}

var imageKeys = []string{"version", "collections", "records", "sets", "documents", "blobs", "assets", "packages"}

// validateImage checks that an image has the recovery point shape, holds only
// its own part's data, and that every file it needs travels in the bundle.
func validateImage(scope recoverystore.Scope, image []byte, blobs map[string]Blob) error {
	where := partPath(scope)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(image, &fields); err != nil || len(fields) != len(imageKeys) {
		return invalid("%s is not a recovery point", where)
	}
	arrays := map[string][]json.RawMessage{}
	for _, key := range imageKeys {
		value, ok := fields[key]
		if !ok {
			return invalid("%s lacks %s", where, key)
		}
		if key == "version" {
			if !bytes.Equal(value, []byte("1")) {
				return invalid("%s has an unknown version", where)
			}
			continue
		}
		var items []json.RawMessage
		if err := json.Unmarshal(value, &items); err != nil || items == nil {
			return invalid("%s %s is not a list", where, key)
		}
		arrays[key] = items
	}
	foreign := []string{"sets", "documents", "packages"}
	if scope.Scope == "addon" {
		foreign = []string{"collections", "records", "assets"}
		for _, key := range []string{"sets", "documents", "packages"} {
			for _, item := range arrays[key] {
				var owned struct {
					AddonID string `json:"addon_id"`
				}
				if err := json.Unmarshal(item, &owned); err != nil || owned.AddonID != scope.AddonID {
					return invalid("%s %s holds another part's data", where, key)
				}
			}
		}
	}
	for _, key := range foreign {
		if len(arrays[key]) != 0 {
			return invalid("%s holds another part's %s", where, key)
		}
	}
	for _, item := range arrays["blobs"] {
		var handle struct {
			ID      string `json:"blob_id"`
			Deleted int    `json:"deleted"`
		}
		if err := json.Unmarshal(item, &handle); err != nil || handle.Deleted != 0 && handle.Deleted != 1 {
			return invalid("%s has an invalid file handle", where)
		}
		blob, ok := blobs[handle.ID]
		if ok && !blob.ownedBy(scope) {
			return invalid("%s lists another part's file %s", where, handle.ID)
		}
		// A deleted handle's file may be absent; a restore leaves it deleted.
		if !ok && handle.Deleted == 0 {
			return invalid("%s needs file %s, which is missing", where, handle.ID)
		}
	}
	for _, item := range arrays["assets"] {
		var asset struct {
			BlobID string `json:"blob_id"`
		}
		if err := json.Unmarshal(item, &asset); err != nil {
			return invalid("%s has an invalid media binding", where)
		}
		if _, ok := blobs[asset.BlobID]; !ok {
			return invalid("%s needs file %s, which is missing", where, asset.BlobID)
		}
	}
	return nil
}
