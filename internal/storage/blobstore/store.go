package blobstore

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const DefaultMaximumBytes = uint64(1 << 30)

var (
	ErrInvalid     = errors.New("invalid blob request")
	ErrNotFound    = errors.New("blob not found")
	ErrConflict    = errors.New("blob revision conflict")
	ErrCorrupt     = errors.New("blob storage is corrupt")
	ErrUnavailable = errors.New("blob storage is unavailable")
)

type OwnerKind string

const (
	OwnerCore   OwnerKind = "core"
	OwnerAddon  OwnerKind = "addon"
	OwnerSystem OwnerKind = "system"
)

type Visibility string

const (
	VisibilityPublic Visibility = "public"
	VisibilityDM     Visibility = "dm"
)

type Blob struct {
	ID           string
	SHA256       string
	Bytes        uint64
	OwnerKind    OwnerKind
	OwnerID      string
	Purpose      string
	MediaType    string
	OriginalName string
	Visibility   Visibility
	Revision     int64
	Deleted      bool
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type CreateRequest struct {
	Content      io.Reader
	Bytes        uint64
	OwnerKind    OwnerKind
	OwnerID      string
	Purpose      string
	MediaType    string
	OriginalName string
	Visibility   Visibility
}

type Options struct {
	MaximumBytes uint64
	Now          func() time.Time
	Random       io.Reader
}

type Store struct {
	database     *sql.DB
	root         string
	maximumBytes uint64
	now          func() time.Time
	random       io.Reader
}

func New(database *sql.DB, root string, options Options) (*Store, error) {
	if database == nil || root == "" {
		return nil, fmt.Errorf("%w: database and blob root are required", ErrInvalid)
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve blob root: %w", err)
	}
	if filepath.Dir(absolute) == absolute {
		return nil, fmt.Errorf("%w: blob root cannot be a filesystem root", ErrInvalid)
	}
	if options.MaximumBytes == 0 {
		options.MaximumBytes = DefaultMaximumBytes
	}
	if options.MaximumBytes > math.MaxInt64-1 {
		return nil, fmt.Errorf("%w: maximum blob size is too large", ErrInvalid)
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	if err := ensureRealDirectory(absolute); err != nil {
		return nil, err
	}
	if err := ensureRealDirectory(filepath.Join(absolute, ".staging")); err != nil {
		return nil, err
	}
	if _, err := database.Exec(`SELECT blob_id FROM blobs LIMIT 0`); err != nil {
		return nil, fmt.Errorf("%w: blob schema is unavailable: %v", ErrUnavailable, err)
	}
	return &Store{
		database: database, root: absolute, maximumBytes: options.MaximumBytes,
		now: options.Now, random: options.Random,
	}, nil
}

func (store *Store) Create(ctx context.Context, request CreateRequest) (Blob, error) {
	mediaType, err := validateCreateRequest(request, store.maximumBytes)
	if err != nil {
		return Blob{}, err
	}
	stagingDirectory := filepath.Join(store.root, ".staging")
	if err := ensureRealDirectory(stagingDirectory); err != nil {
		return Blob{}, err
	}
	stage, err := os.CreateTemp(stagingDirectory, "blob-*.partial")
	if err != nil {
		return Blob{}, fmt.Errorf("create blob stage: %w", err)
	}
	stagePath := stage.Name()
	stageKept := false
	defer func() {
		_ = stage.Close()
		if !stageKept {
			_ = os.Remove(stagePath)
		}
	}()

	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(stage, hash), &contextReader{
		ctx: ctx, reader: io.LimitReader(request.Content, int64(request.Bytes)+1),
	})
	if copyErr == nil && uint64(written) != request.Bytes {
		copyErr = fmt.Errorf("declared %d bytes but received %d", request.Bytes, written)
	}
	if copyErr == nil {
		copyErr = stage.Sync()
	}
	closeErr := stage.Close()
	if copyErr != nil || closeErr != nil {
		return Blob{}, fmt.Errorf("write blob stage: %w", errors.Join(copyErr, closeErr))
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	objectPath := store.objectPath(digest)
	if err := ensureRealDirectory(filepath.Join(store.root, "sha256")); err != nil {
		return Blob{}, err
	}
	if err := ensureRealDirectory(filepath.Dir(objectPath)); err != nil {
		return Blob{}, err
	}
	if err := publishObject(stagePath, objectPath, request.Bytes, digest); err != nil {
		return Blob{}, err
	}
	stageKept = true

	now := store.now().UTC()
	for attempt := 0; attempt < 4; attempt++ {
		blobID, err := store.newID()
		if err != nil {
			return Blob{}, err
		}
		result, err := store.insertMetadata(ctx, Blob{
			ID: blobID, SHA256: digest, Bytes: request.Bytes,
			OwnerKind: request.OwnerKind, OwnerID: request.OwnerID,
			Purpose: request.Purpose, MediaType: mediaType,
			OriginalName: request.OriginalName, Visibility: request.Visibility,
			Revision: 1, CreatedAt: now, UpdatedAt: now,
		})
		if !errors.Is(err, errIDCollision) {
			return result, err
		}
	}
	return Blob{}, fmt.Errorf("allocate blob id: %w", ErrUnavailable)
}

func (store *Store) Metadata(ctx context.Context, id string) (Blob, error) {
	if !validID(id) {
		return Blob{}, ErrNotFound
	}
	return scanBlob(store.database.QueryRowContext(ctx, `
		SELECT blob.blob_id, blob.object_sha256, object.bytes,
		       blob.owner_kind, blob.owner_id, blob.purpose, blob.media_type,
		       blob.original_name, blob.visibility, blob.revision, blob.deleted,
		       blob.created_at, blob.updated_at
		FROM blobs AS blob
		JOIN blob_objects AS object ON object.sha256 = blob.object_sha256
		WHERE blob.blob_id = ?`, id))
}

func (store *Store) Open(ctx context.Context, id string) (*os.File, Blob, error) {
	metadata, err := store.Metadata(ctx, id)
	if err != nil {
		return nil, Blob{}, err
	}
	if metadata.Deleted {
		return nil, Blob{}, ErrNotFound
	}
	filename := store.objectPath(metadata.SHA256)
	file, err := os.Open(filename)
	if err != nil {
		return nil, Blob{}, fmt.Errorf("%w: open object for %s: %v", ErrCorrupt, id, err)
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 0 || uint64(info.Size()) != metadata.Bytes {
		_ = file.Close()
		return nil, Blob{}, fmt.Errorf("%w: object for %s has invalid size or type", ErrCorrupt, id)
	}
	return file, metadata, nil
}

func (store *Store) Delete(ctx context.Context, id string, expectedRevision int64) (Blob, error) {
	if !validID(id) || expectedRevision < 1 {
		return Blob{}, ErrInvalid
	}
	now := store.now().UTC().Format(time.RFC3339Nano)
	result, err := store.database.ExecContext(ctx, `
		UPDATE blobs
		SET deleted = 1, revision = revision + 1, updated_at = ?
		WHERE blob_id = ? AND revision = ? AND deleted = 0`, now, id, expectedRevision)
	if err != nil {
		return Blob{}, fmt.Errorf("delete blob: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return Blob{}, fmt.Errorf("read blob deletion: %w", err)
	}
	if changed != 1 {
		if _, metadataErr := store.Metadata(ctx, id); errors.Is(metadataErr, ErrNotFound) {
			return Blob{}, ErrNotFound
		}
		return Blob{}, ErrConflict
	}
	return store.Metadata(ctx, id)
}

var errIDCollision = errors.New("blob id collision")

func (store *Store) insertMetadata(ctx context.Context, blob Blob) (Blob, error) {
	transaction, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return Blob{}, fmt.Errorf("begin blob metadata write: %w", err)
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO blob_objects(sha256, bytes, created_at)
		VALUES (?, ?, ?)
		ON CONFLICT(sha256) DO NOTHING`,
		blob.SHA256, blob.Bytes, blob.CreatedAt.Format(time.RFC3339Nano)); err != nil {
		return Blob{}, fmt.Errorf("record blob object: %w", err)
	}
	var objectBytes uint64
	if err := transaction.QueryRowContext(ctx,
		`SELECT bytes FROM blob_objects WHERE sha256 = ?`, blob.SHA256,
	).Scan(&objectBytes); err != nil || objectBytes != blob.Bytes {
		return Blob{}, fmt.Errorf("%w: object metadata differs for %s", ErrCorrupt, blob.SHA256)
	}
	result, err := transaction.ExecContext(ctx, `
		INSERT INTO blobs(
			blob_id, object_sha256, owner_kind, owner_id, purpose, media_type,
			original_name, visibility, revision, deleted, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
		ON CONFLICT(blob_id) DO NOTHING`,
		blob.ID, blob.SHA256, blob.OwnerKind, blob.OwnerID, blob.Purpose,
		blob.MediaType, blob.OriginalName, blob.Visibility,
		blob.CreatedAt.Format(time.RFC3339Nano), blob.UpdatedAt.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Blob{}, fmt.Errorf("record blob handle: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return Blob{}, fmt.Errorf("read blob handle insert: %w", err)
	}
	if changed != 1 {
		return Blob{}, errIDCollision
	}
	if err := transaction.Commit(); err != nil {
		return Blob{}, fmt.Errorf("commit blob metadata: %w", err)
	}
	return blob, nil
}

func (store *Store) newID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := io.ReadFull(store.random, buffer); err != nil {
		return "", fmt.Errorf("generate blob id: %w", err)
	}
	return "b_" + hex.EncodeToString(buffer), nil
}

func (store *Store) objectPath(digest string) string {
	return filepath.Join(store.root, "sha256", digest[:2], digest)
}

func validateCreateRequest(request CreateRequest, maximum uint64) (string, error) {
	if request.Content == nil || request.Bytes > maximum ||
		(request.OwnerKind != OwnerCore && request.OwnerKind != OwnerAddon && request.OwnerKind != OwnerSystem) ||
		!validLabel(request.OwnerID, 200) || !validLabel(request.Purpose, 200) ||
		(request.Visibility != VisibilityPublic && request.Visibility != VisibilityDM) ||
		!validOriginalName(request.OriginalName) {
		return "", ErrInvalid
	}
	mediaType, parameters, err := mime.ParseMediaType(request.MediaType)
	if err != nil || len(mediaType) == 0 || len(request.MediaType) > 200 {
		return "", ErrInvalid
	}
	return mime.FormatMediaType(strings.ToLower(mediaType), parameters), nil
}

func validID(value string) bool {
	if len(value) != 34 || !strings.HasPrefix(value, "b_") {
		return false
	}
	_, err := hex.DecodeString(value[2:])
	return err == nil
}

func validLabel(value string, maximum int) bool {
	if len(value) == 0 || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validOriginalName(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > 255 || !utf8.ValidString(value) ||
		strings.ContainsAny(value, `/\\`) || filepath.Base(value) != value {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func publishObject(stagePath, objectPath string, size uint64, digest string) error {
	if err := os.Rename(stagePath, objectPath); err != nil {
		if validationErr := validateObject(objectPath, size, digest); validationErr != nil {
			return errors.Join(fmt.Errorf("publish blob object: %w", err), validationErr)
		}
		_ = os.Remove(stagePath)
		return nil
	}
	return validateObject(objectPath, size, digest)
}

func validateObject(filename string, size uint64, digest string) error {
	file, err := os.Open(filename)
	if err != nil {
		return fmt.Errorf("%w: open object: %v", ErrCorrupt, err)
	}
	hash := sha256.New()
	written, readErr := io.Copy(hash, file)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || written < 0 || uint64(written) != size ||
		hex.EncodeToString(hash.Sum(nil)) != digest {
		return fmt.Errorf("%w: object content differs from its address", ErrCorrupt)
	}
	return nil
}

func ensureRealDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return fmt.Errorf("create blob directory: %w", err)
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: blob path is not a real directory", ErrCorrupt)
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}

type rowScanner interface {
	Scan(...any) error
}

func scanBlob(row rowScanner) (Blob, error) {
	var blob Blob
	var createdAt, updatedAt string
	if err := row.Scan(
		&blob.ID, &blob.SHA256, &blob.Bytes, &blob.OwnerKind, &blob.OwnerID,
		&blob.Purpose, &blob.MediaType, &blob.OriginalName, &blob.Visibility,
		&blob.Revision, &blob.Deleted, &createdAt, &updatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Blob{}, ErrNotFound
		}
		return Blob{}, fmt.Errorf("read blob metadata: %w", err)
	}
	var err error
	blob.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Blob{}, fmt.Errorf("%w: invalid blob creation time", ErrCorrupt)
	}
	blob.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Blob{}, fmt.Errorf("%w: invalid blob update time", ErrCorrupt)
	}
	return blob, nil
}
