// Package backupbundle writes and reads the backup Settings downloads: the
// newest recovery point of the campaign and of each add-on, with the media
// files those points use. Importing a bundle adds its parts as recovery points
// without changing current data; the DM then restores each part from its list.
//
// The full server archive (database, add-on packages, passwords) is a
// separate maintenance format; see package backuparchive.
package backupbundle

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pjunak/ttrpg-codex/contracts/addons/v3"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/recoverystore"
)

const Format = "codex-backup-bundle.v1"

// ErrInvalid wraps every reason a bundle is refused.
var ErrInvalid = errors.New("invalid backup bundle")

const (
	MaximumArchiveBytes  = 1 << 30
	maximumExpandedBytes = 4 << 30
	maximumManifestBytes = 16 << 20
	maximumParts         = 513
	maximumBlobs         = 100_000
	manifestPath         = "manifest.json"
)

type Manifest struct {
	Format      string `json:"format"`
	CreatedAt   string `json:"createdAt"`
	HostVersion string `json:"hostVersion"`
	// Migration is the newest database migration of the host that wrote the
	// bundle. A host that has not applied it refuses the bundle.
	Migration int64  `json:"migration"`
	Parts     []Part `json:"parts"`
	Blobs     []Blob `json:"blobs"`
}

// Part is one recovery point in the bundle.
type Part struct {
	Scope        string `json:"scope"`
	AddonID      string `json:"addonId,omitempty"`
	GenerationID string `json:"generationId,omitempty"`
	// AddonVersion names the release whose build a restore of this part needs.
	AddonVersion string `json:"addonVersion,omitempty"`
	PointID      int64  `json:"pointId"`
	CreatedAt    string `json:"createdAt"`
	Reason       string `json:"reason"`
	Path         string `json:"path"`
	Bytes        int64  `json:"bytes"`
	SHA256       string `json:"sha256"`
}

// Blob is one file handle a part uses. Handles that share content share one
// object in the bundle.
type Blob struct {
	ID           string `json:"id"`
	SHA256       string `json:"sha256"`
	Bytes        uint64 `json:"bytes"`
	OwnerKind    string `json:"ownerKind"`
	OwnerID      string `json:"ownerId"`
	Purpose      string `json:"purpose"`
	MediaType    string `json:"mediaType"`
	OriginalName string `json:"originalName"`
	Visibility   string `json:"visibility"`
	CreatedAt    string `json:"createdAt"`
}

// Bundles exports and imports backup bundles of one host.
type Bundles struct {
	DB     *sql.DB
	Points *recoverystore.Store
	Blobs  *blobstore.Store
	// HostVersion is recorded in exported manifests.
	HostVersion string
	// Now dates exported manifests; nil uses time.Now.
	Now func() time.Time
}

func (part Part) scope() recoverystore.Scope {
	return recoverystore.Scope{Scope: part.Scope, AddonID: part.AddonID}
}

func partPath(scope recoverystore.Scope) string {
	if scope.Scope == "addon" {
		return "parts/addons/" + scope.AddonID + ".json"
	}
	return "parts/campaign.json"
}

func objectPath(digest string) string {
	return "blobs/sha256/" + digest
}

func digestOf(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func validDigest(value string) bool {
	_, err := hex.DecodeString(value)
	return len(value) == 64 && err == nil && strings.ToLower(value) == value
}

func validTime(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && len(value) <= 64
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

var reasons = map[string]bool{"manual": true, "save": true, "pre-restore": true, "download": true, "imported": true}

// validate checks the manifest on its own, before any file is read.
func (manifest Manifest) validate(hostMigration int64) error {
	if manifest.Format != Format {
		return invalid("format %q is not %s", manifest.Format, Format)
	}
	if !validTime(manifest.CreatedAt) || manifest.HostVersion == "" || len(manifest.HostVersion) > 100 {
		return invalid("manifest date or host version")
	}
	if manifest.Migration < 1 || manifest.Migration > hostMigration {
		return invalid("written by a newer host (migration %d); update this site first", manifest.Migration)
	}
	if len(manifest.Parts) < 1 || len(manifest.Parts) > maximumParts {
		return invalid("%d parts", len(manifest.Parts))
	}
	seen := map[recoverystore.Scope]bool{}
	for _, part := range manifest.Parts {
		scope := part.scope()
		switch {
		case scope.Scope == "campaign" && scope.AddonID == "" && part.GenerationID == "" && part.AddonVersion == "":
		case scope.Scope == "addon" && addonv3.ValidAddonID(scope.AddonID) &&
			(part.GenerationID == "" || validDigest(part.GenerationID)) && len(part.AddonVersion) <= 100:
		default:
			return invalid("part %q %q", part.Scope, part.AddonID)
		}
		if seen[scope] {
			return invalid("part %s appears twice", partPath(scope))
		}
		seen[scope] = true
		if part.PointID < 1 || !validTime(part.CreatedAt) || !reasons[part.Reason] || part.Path != partPath(scope) ||
			part.Bytes < 1 || part.Bytes > recoverystore.MaxImageBytes || !validDigest(part.SHA256) {
			return invalid("part %s metadata", partPath(scope))
		}
	}
	if len(manifest.Blobs) > maximumBlobs {
		return invalid("%d files", len(manifest.Blobs))
	}
	ids, sizes := map[string]bool{}, map[string]uint64{}
	for _, blob := range manifest.Blobs {
		if ids[blob.ID] || !validDigest(blob.SHA256) || blob.Bytes > MaximumArchiveBytes || !validTime(blob.CreatedAt) {
			return invalid("file %q metadata", blob.ID)
		}
		if size, ok := sizes[blob.SHA256]; ok && size != blob.Bytes {
			return invalid("file content %s has two sizes", blob.SHA256)
		}
		ids[blob.ID], sizes[blob.SHA256] = true, blob.Bytes
	}
	return nil
}

func (blob Blob) handle() (blobstore.Blob, error) {
	createdAt, err := time.Parse(time.RFC3339Nano, blob.CreatedAt)
	if err != nil {
		return blobstore.Blob{}, invalid("file %q date", blob.ID)
	}
	return blobstore.Blob{
		ID: blob.ID, SHA256: blob.SHA256, Bytes: blob.Bytes,
		OwnerKind: blobstore.OwnerKind(blob.OwnerKind), OwnerID: blob.OwnerID, Purpose: blob.Purpose,
		MediaType: blob.MediaType, OriginalName: blob.OriginalName, Visibility: blobstore.Visibility(blob.Visibility),
		CreatedAt: createdAt,
	}, nil
}

// ownedBy reports whether the blob belongs to the part, as recovery decides it.
func (blob Blob) ownedBy(scope recoverystore.Scope) bool {
	if scope.Scope == "addon" {
		return blob.OwnerKind == string(blobstore.OwnerAddon) && blob.OwnerID == scope.AddonID
	}
	return blob.OwnerKind != string(blobstore.OwnerAddon)
}
