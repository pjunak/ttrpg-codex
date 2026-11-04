package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/backupbundle"
)

// BackupBundles exports and imports the per-part backup bundle.
type BackupBundles interface {
	Export(context.Context, io.Writer) (backupbundle.Manifest, error)
	Import(context.Context, string) (backupbundle.Manifest, error)
}

func (s *server) registerBackupRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/backup", s.downloadBackup)
	mux.HandleFunc("POST /api/backup/import", s.importBackup)
}

func (s *server) authorizeBackup(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	if err := s.backupAuthorizer(r); err != nil {
		s.logger.Warn("backup request denied")
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM backup authorization is required")
		return false
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "backup query parameters are not supported")
		return false
	}
	return true
}

func (s *server) downloadBackup(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeBackup(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	if err := extendDeadlines(w, 6*time.Minute); err != nil {
		s.writeBackupFailure(w, r, err)
		return
	}
	stage, err := os.MkdirTemp("", "codex-backup-download-")
	if err != nil {
		s.writeBackupFailure(w, r, err)
		return
	}
	defer os.RemoveAll(stage)
	archive, err := os.Create(filepath.Join(stage, "backup.zip"))
	if err != nil {
		s.writeBackupFailure(w, r, err)
		return
	}
	defer archive.Close()
	manifest, err := s.backupBundles.Export(ctx, archive)
	if err == nil {
		_, err = archive.Seek(0, io.SeekStart)
	}
	if err != nil {
		s.writeBackupFailure(w, r, err)
		return
	}
	createdAt, err := time.Parse(time.RFC3339Nano, manifest.CreatedAt)
	if err != nil {
		s.writeBackupFailure(w, r, fmt.Errorf("generated backup timestamp: %w", err))
		return
	}
	filename := "codex-backup-" + createdAt.UTC().Format("20060102-150405") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, filename, createdAt, archive)
}

func (s *server) writeBackupFailure(w http.ResponseWriter, r *http.Request, err error) {
	s.logger.Error("backup download failed", "error", err, "remote", r.RemoteAddr)
	writeAPIError(w, http.StatusServiceUnavailable, "BACKUP_UNAVAILABLE", "backup could not be created")
}

func (s *server) importBackup(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeBackup(w, r) {
		return
	}
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/zip" {
		writeAPIError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/zip")
		return
	}
	limit := int64(backupbundle.MaximumArchiveBytes)
	if r.ContentLength > limit {
		writeBackupTooLarge(w, limit)
		return
	}
	// Uploading and checking a large bundle outlasts the server's default deadlines.
	if err := extendDeadlines(w, 30*time.Minute); err != nil {
		s.writeImportFailure(w, r, err)
		return
	}
	upload, err := os.CreateTemp("", "codex-import-*.zip")
	if err != nil {
		s.writeImportFailure(w, r, err)
		return
	}
	defer os.Remove(upload.Name())
	_, copyErr := io.Copy(upload, http.MaxBytesReader(w, r.Body, limit))
	closeErr := upload.Close()
	if copyErr != nil || closeErr != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(copyErr, &tooLarge) {
			writeBackupTooLarge(w, limit)
			return
		}
		s.writeImportFailure(w, r, errors.Join(copyErr, closeErr))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Minute)
	defer cancel()
	manifest, err := s.backupBundles.Import(ctx, upload.Name())
	if err != nil {
		s.writeImportFailure(w, r, err)
		return
	}
	s.logger.Info("backup imported as recovery points", "createdAt", manifest.CreatedAt, "parts", len(manifest.Parts))
	writeJSON(w, http.StatusOK, struct {
		ContractVersion string `json:"contractVersion"`
		CreatedAt       string `json:"createdAt"`
		Parts           int    `json:"parts"`
	}{"backup-import.v1", manifest.CreatedAt, len(manifest.Parts)})
}

func writeBackupTooLarge(w http.ResponseWriter, limit int64) {
	writeAPIError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE",
		fmt.Sprintf("backup exceeds the %d MiB limit", limit>>20))
}

func (s *server) writeImportFailure(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, backupbundle.ErrInvalid) {
		s.logger.Warn("backup import rejected", "error", err)
		writeAPIError(w, http.StatusBadRequest, "INVALID_BACKUP", err.Error())
		return
	}
	s.logger.Error("backup import failed", "error", err, "remote", r.RemoteAddr)
	writeAPIError(w, http.StatusServiceUnavailable, "BACKUP_UNAVAILABLE", "the backup could not be imported; the current data is unchanged")
}
