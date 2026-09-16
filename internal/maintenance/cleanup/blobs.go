package cleanup

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var blobIDPattern = regexp.MustCompile(`b_[0-9a-f]{32}`)
var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type BlobCandidate struct {
	SHA256  string   `json:"sha256"`
	Bytes   int64    `json:"bytes"`
	Handles []string `json:"deletedHandles"`
}
type BlobReport struct {
	Objects          []BlobCandidate `json:"objects"`
	Bytes            int64           `json:"bytes"`
	ProtectedObjects int             `json:"protectedObjects"`
	PendingObjects   int             `json:"pendingObjects"`
	Review           string          `json:"reviewSHA256"`
}

func InspectBlobs(ctx context.Context, db *sql.DB, directory string) (BlobReport, error) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return BlobReport{}, err
	}
	defer tx.Rollback()
	return inspectBlobs(ctx, tx, directory)
}

func inspectBlobs(ctx context.Context, tx *sql.Tx, directory string) (BlobReport, error) {
	report := BlobReport{Objects: []BlobCandidate{}}
	protected := map[string]bool{}
	// Any authored reference keeps a handle, even if that handle is currently
	// logically deleted. References in unknown/extension fields remain protected.
	rows, err := tx.QueryContext(ctx, `SELECT body_json FROM campaign_records UNION ALL SELECT body_json FROM addon_documents
  UNION ALL SELECT body_json FROM addon_history_payloads`)
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var body string
		if err = rows.Scan(&body); err != nil {
			rows.Close()
			return report, err
		}
		if err = protectJSON([]byte(body), protected); err != nil {
			rows.Close()
			return report, err
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return report, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT image_json FROM recovery_points")
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var body string
		if err = rows.Scan(&body); err != nil {
			rows.Close()
			return report, err
		}
		var image map[string]json.RawMessage
		if err = json.Unmarshal([]byte(body), &image); err != nil {
			rows.Close()
			return report, err
		}
		var handles []struct {
			ID      string `json:"blob_id"`
			Deleted int    `json:"deleted"`
		}
		if err = json.Unmarshal(image["blobs"], &handles); err != nil {
			rows.Close()
			return report, err
		}
		for _, handle := range handles {
			if handle.Deleted == 0 {
				protected[handle.ID] = true
			}
		}
		for _, field := range []string{"records", "documents", "assets"} {
			if err = protectJSON(image[field], protected); err != nil {
				rows.Close()
				return report, err
			}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return report, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT blob_id FROM core_media_assets")
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return report, err
		}
		protected[id] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return report, err
	}
	kept := map[string]bool{}
	handles := map[string][]string{}
	rows, err = tx.QueryContext(ctx, "SELECT blob_id,object_sha256,deleted FROM blobs ORDER BY blob_id")
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var id, hash string
		var deleted bool
		if err = rows.Scan(&id, &hash, &deleted); err != nil {
			rows.Close()
			return report, err
		}
		if !deleted || protected[id] {
			kept[hash] = true
		}
		handles[hash] = append(handles[hash], id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return report, err
	}
	report.ProtectedObjects = len(kept)
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM blob_collection_pending").Scan(&report.PendingObjects); err != nil {
		return report, err
	}
	root := filepath.Join(directory, "blobs", "sha256")
	if err = realParents(root); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return finishBlobReport(report)
		}
		return report, err
	}
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("blob collection refuses symbolic links")
		}
		if entry.IsDir() {
			return nil
		}
		hash := entry.Name()
		relative, e := filepath.Rel(root, path)
		if e != nil {
			return e
		}
		if !hashPattern.MatchString(hash) || filepath.ToSlash(relative) != hash[:2]+"/"+hash {
			return fmt.Errorf("unexpected blob object path: %s", relative)
		}
		if kept[hash] {
			return nil
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return errors.New("blob object is not a regular file")
		}
		file, e := os.Open(path)
		if e != nil {
			return e
		}
		digest := sha256.New()
		_, copyErr := io.Copy(digest, file)
		closeErr := file.Close()
		if e = errors.Join(copyErr, closeErr); e != nil {
			return e
		}
		if hex.EncodeToString(digest.Sum(nil)) != hash {
			return fmt.Errorf("blob content does not match its hash: %s", hash)
		}
		ids := handles[hash]
		if ids == nil {
			ids = []string{}
		}
		report.Objects = append(report.Objects, BlobCandidate{hash, info.Size(), ids})
		report.Bytes += info.Size()
		return nil
	})
	if err != nil {
		return report, err
	}
	return finishBlobReport(report)
}

func protectJSON(body []byte, protected map[string]bool) error {
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return err
	}
	var walk func(any)
	walk = func(v any) {
		switch item := v.(type) {
		case string:
			for _, id := range blobIDPattern.FindAllString(item, -1) {
				protected[id] = true
			}
			// Recovery stores document bodies as JSON strings, which may themselves
			// contain escaped identifiers. Decode that extra layer before scanning.
			if json.Valid([]byte(item)) {
				var nested any
				if json.Unmarshal([]byte(item), &nested) == nil {
					switch nested.(type) {
					case map[string]any, []any:
						walk(nested)
					}
				}
			}
		case map[string]any:
			for _, child := range item {
				walk(child)
			}
		case []any:
			for _, child := range item {
				walk(child)
			}
		}
	}
	walk(value)
	return nil
}

func finishBlobReport(report BlobReport) (BlobReport, error) {
	sort.Slice(report.Objects, func(i, j int) bool { return report.Objects[i].SHA256 < report.Objects[j].SHA256 })
	body, err := json.Marshal(report)
	if err != nil {
		return report, err
	}
	sum := sha256.Sum256(body)
	report.Review = hex.EncodeToString(sum[:])
	return report, nil
}

// QueueBlobs atomically removes only reviewed, unreferenced metadata and saves
// unlink intent. ResumeBlobs is safe after a crash at either side of each unlink.
func QueueBlobs(ctx context.Context, db *sql.DB, directory, reviewed string) (BlobReport, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return BlobReport{}, err
	}
	defer tx.Rollback()
	report, err := inspectBlobs(ctx, tx, directory)
	if err != nil {
		return report, err
	}
	if reviewed == "" || reviewed != report.Review {
		return report, ErrStale
	}
	for _, item := range report.Objects {
		for _, id := range item.Handles {
			if _, err = tx.ExecContext(ctx, "DELETE FROM blobs WHERE blob_id=? AND deleted=1", id); err != nil {
				return report, err
			}
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM blob_objects WHERE sha256=?", item.SHA256); err != nil {
			return report, err
		}
		if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO blob_collection_pending(sha256,bytes) VALUES(?,?)", item.SHA256, item.Bytes); err != nil {
			return report, err
		}
	}
	return report, tx.Commit()
}

func ResumeBlobs(ctx context.Context, db *sql.DB, directory string) error {
	rows, err := db.QueryContext(ctx, "SELECT sha256 FROM blob_collection_pending ORDER BY sha256")
	if err != nil {
		return err
	}
	hashes := []string{}
	for rows.Next() {
		var hash string
		if err = rows.Scan(&hash); err != nil {
			rows.Close()
			return err
		}
		hashes = append(hashes, hash)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, hash := range hashes {
		if !hashPattern.MatchString(hash) {
			return errors.New("invalid pending blob hash")
		}
		var used int
		if err = db.QueryRowContext(ctx, "SELECT count(*) FROM blob_objects WHERE sha256=?", hash).Scan(&used); err != nil {
			return err
		}
		if used == 0 {
			path := filepath.Join(directory, "blobs", "sha256", hash[:2], hash)
			if err = realParents(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if err == nil {
				if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
					return err
				}
			}
		}
		// A restarted host may have recreated an object with this content. Cancel
		// its old unlink intent; a future review can assess its new references.
		if _, err = db.ExecContext(ctx, "DELETE FROM blob_collection_pending WHERE sha256=?", hash); err != nil {
			return err
		}
	}
	return nil
}

// Refuse links in every component, including a linked data directory. This is
// required before an offline collector may unlink any content-addressed path.
func realParents(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for current := absolute; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("blob collection refuses symbolic link %s", current)
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	if strings.TrimSpace(absolute) == "" {
		return errors.New("empty blob path")
	}
	return nil
}
