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

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
)

type BackupArchives interface {
	Create(context.Context, string) (backuparchive.Manifest, error)
}

// BackupRestores stages an uploaded backup; the host installs it on restart.
type BackupRestores interface {
	Stage(context.Context, string) (backuparchive.RestoreResult, error)
	Restart()
}

func (s *server) registerBackupRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/backup", s.downloadBackup)
	if s.backupRestores != nil {
		mux.HandleFunc("POST /api/backup/restore", s.restoreBackup)
	}
}

func (s *server) downloadBackup(w http.ResponseWriter, r *http.Request) {
	if err := s.backupAuthorizer(r); err != nil {
		s.logger.Warn("backup download denied")
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM backup authorization is required")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "backup query parameters are not supported")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(6 * time.Minute)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		s.writeBackupFailure(w, r, err)
		return
	}
	stage, err := os.MkdirTemp("", "codex-backup-download-")
	if err != nil {
		s.writeBackupFailure(w, r, err)
		return
	}
	defer os.RemoveAll(stage)
	archivePath := filepath.Join(stage, "backup.zip")
	manifest, err := s.backupArchives.Create(ctx, archivePath)
	if err != nil {
		s.writeBackupFailure(w, r, err)
		return
	}
	archive, err := os.Open(archivePath)
	if err != nil {
		s.writeBackupFailure(w, r, err)
		return
	}
	defer archive.Close()
	info, err := archive.Stat()
	if err != nil {
		s.writeBackupFailure(w, r, fmt.Errorf("inspect generated backup: %w", err))
		return
	}
	if !info.Mode().IsRegular() {
		s.writeBackupFailure(w, r, fmt.Errorf("generated backup is not a regular file"))
		return
	}
	createdAt, err := time.Parse(time.RFC3339Nano, manifest.CreatedAt)
	if err != nil {
		s.writeBackupFailure(w, r, fmt.Errorf("generated backup timestamp: %w", err))
		return
	}
	filename := "codex-backup-" + createdAt.UTC().Format("20060102-150405") + ".zip"
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, filename, createdAt, archive)
}

func (s *server) writeBackupFailure(w http.ResponseWriter, r *http.Request, err error) {
	s.logger.Error("backup download failed", "error", err, "remote", r.RemoteAddr)
	if errors.Is(err, packagemanager.ErrPackageUnavailable) {
		writeAPIError(w, http.StatusServiceUnavailable, "PACKAGE_UNAVAILABLE", "A recovery package could not be downloaded. Check GitHub access or upload its exact ZIP in Add-ons, then retry the backup.")
		return
	}
	writeAPIError(w, http.StatusServiceUnavailable, "BACKUP_UNAVAILABLE", "backup could not be created")
}

func (s *server) restoreBackup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if err := s.backupAuthorizer(r); err != nil {
		s.logger.Warn("backup restore denied")
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM backup authorization is required")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "restore query parameters are not supported")
		return
	}
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/zip" {
		writeAPIError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/zip")
		return
	}
	limit := backuparchive.DefaultLimits.MaximumArchiveBytes
	if r.ContentLength > limit {
		writeBackupTooLarge(w, limit)
		return
	}
	if !s.restoreBusy.TryLock() {
		writeAPIError(w, http.StatusConflict, "RESTORE_IN_PROGRESS", "another backup is being restored")
		return
	}
	defer s.restoreBusy.Unlock()
	// Uploading and verifying a large archive outlasts the server's default deadlines.
	if err := extendDeadlines(w, 30*time.Minute); err != nil {
		s.writeRestoreFailure(w, r, err)
		return
	}
	upload, err := os.CreateTemp("", "codex-restore-*.zip")
	if err != nil {
		s.writeRestoreFailure(w, r, err)
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
		s.writeRestoreFailure(w, r, errors.Join(copyErr, closeErr))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Minute)
	defer cancel()
	result, err := s.backupRestores.Stage(ctx, upload.Name())
	if err != nil {
		s.writeRestoreFailure(w, r, err)
		return
	}
	s.logger.Info("backup restore staged; restarting", "createdAt", result.Manifest.CreatedAt)
	writeJSON(w, http.StatusAccepted, struct {
		ContractVersion   string `json:"contractVersion"`
		CreatedAt         string `json:"createdAt"`
		HostVersion       string `json:"hostVersion"`
		AppliedMigrations int    `json:"appliedMigrations"`
	}{"backup-restore.v1", result.Manifest.CreatedAt, result.Manifest.HostVersion, result.AppliedMigrations})
	s.backupRestores.Restart()
}

func writeBackupTooLarge(w http.ResponseWriter, limit int64) {
	writeAPIError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE",
		fmt.Sprintf("backup exceeds the %d MiB limit", limit>>20))
}

func (s *server) writeRestoreFailure(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, backuparchive.ErrInvalidArchive):
		s.logger.Warn("backup restore rejected", "error", err)
		writeAPIError(w, http.StatusBadRequest, "INVALID_BACKUP", err.Error())
	case errors.Is(err, backuparchive.ErrRestorePending):
		writeAPIError(w, http.StatusConflict, "RESTORE_PENDING", "a restored backup is already waiting for the server to restart")
	default:
		s.logger.Error("backup restore failed", "error", err, "remote", r.RemoteAddr)
		writeAPIError(w, http.StatusServiceUnavailable, "RESTORE_UNAVAILABLE", "the backup could not be restored; the current data is unchanged")
	}
}
