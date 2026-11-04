package backupbundle

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/ctxio"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/recoverystore"
)

// Export makes every current part's newest recovery point match its current
// state (saving a "download" point where it differs) and writes those points,
// with the media files they use, as a bundle to w.
func (bundles Bundles) Export(ctx context.Context, w io.Writer) (Manifest, error) {
	snapshots, err := bundles.Points.Latest(ctx)
	if err != nil {
		return Manifest{}, err
	}
	now := time.Now
	if bundles.Now != nil {
		now = bundles.Now
	}
	created := now().UTC()
	manifest := Manifest{
		Format: Format, CreatedAt: created.Format(time.RFC3339Nano), HostVersion: bundles.HostVersion,
		Parts: make([]Part, 0, len(snapshots)), Blobs: []Blob{},
	}
	if err := bundles.DB.QueryRowContext(ctx, `SELECT COALESCE(max(version), 0) FROM schema_migrations`).Scan(&manifest.Migration); err != nil {
		return Manifest{}, err
	}
	keep := map[string]bool{}
	for _, snapshot := range snapshots {
		image := []byte(snapshot.Image)
		if err := recoverystore.ImageBlobs(image, keep); err != nil {
			return Manifest{}, fmt.Errorf("%s files: %w", partPath(snapshot.Scope), err)
		}
		manifest.Parts = append(manifest.Parts, Part{
			Scope: snapshot.Scope.Scope, AddonID: snapshot.Scope.AddonID,
			GenerationID: snapshot.GenerationID, AddonVersion: snapshot.AddonVersion,
			PointID: snapshot.PointID, CreatedAt: snapshot.CreatedAt, Reason: snapshot.Reason,
			Path: partPath(snapshot.Scope), Bytes: int64(len(image)), SHA256: digestOf(image),
		})
	}
	if manifest.Blobs, err = bundles.handles(ctx, keep); err != nil {
		return Manifest{}, err
	}
	archive := zip.NewWriter(w)
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return Manifest{}, err
	}
	if err := writeEntry(archive, manifestPath, created, body); err != nil {
		return Manifest{}, err
	}
	for index, snapshot := range snapshots {
		if err := writeEntry(archive, manifest.Parts[index].Path, created, []byte(snapshot.Image)); err != nil {
			return Manifest{}, err
		}
	}
	written := map[string]bool{}
	for _, blob := range manifest.Blobs {
		if written[blob.SHA256] {
			continue
		}
		written[blob.SHA256] = true
		if err := bundles.writeObject(ctx, archive, created, blob); err != nil {
			return Manifest{}, err
		}
	}
	return manifest, archive.Close()
}

// handles reads the metadata of every kept blob that exists. A mentioned ID
// with no handle is only text that looks like one.
func (bundles Bundles) handles(ctx context.Context, keep map[string]bool) ([]Blob, error) {
	rows, err := bundles.DB.QueryContext(ctx, `SELECT blob.blob_id, blob.object_sha256, object.bytes, blob.owner_kind, blob.owner_id,
 blob.purpose, blob.media_type, blob.original_name, blob.visibility, blob.created_at
 FROM blobs AS blob JOIN blob_objects AS object ON object.sha256 = blob.object_sha256 ORDER BY blob.blob_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	blobs := []Blob{}
	for rows.Next() {
		var blob Blob
		if err := rows.Scan(&blob.ID, &blob.SHA256, &blob.Bytes, &blob.OwnerKind, &blob.OwnerID, &blob.Purpose,
			&blob.MediaType, &blob.OriginalName, &blob.Visibility, &blob.CreatedAt); err != nil {
			return nil, err
		}
		if keep[blob.ID] {
			blobs = append(blobs, blob)
		}
	}
	return blobs, rows.Err()
}

func (bundles Bundles) writeObject(ctx context.Context, archive *zip.Writer, modified time.Time, blob Blob) error {
	file, err := bundles.Blobs.ObjectFile(blob.SHA256, blob.Bytes)
	if err != nil {
		return err
	}
	defer file.Close()
	// Media is already compressed; storing it keeps the download fast.
	entry, err := archive.CreateHeader(&zip.FileHeader{Name: objectPath(blob.SHA256), Method: zip.Store, Modified: modified})
	if err != nil {
		return err
	}
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(entry, hash), ctxio.Reader(ctx, file))
	if err != nil {
		return fmt.Errorf("copy file %s: %w", blob.ID, err)
	}
	if uint64(written) != blob.Bytes || hex.EncodeToString(hash.Sum(nil)) != blob.SHA256 {
		return fmt.Errorf("file %s does not match its stored digest", blob.ID)
	}
	return nil
}

func writeEntry(archive *zip.Writer, name string, modified time.Time, body []byte) error {
	entry, err := archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: modified})
	if err != nil {
		return err
	}
	_, err = entry.Write(body)
	return err
}
