package httpapi

import (
	"context"
	"errors"
	"fmt"
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

func (s *server) registerBackupRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/backup", s.downloadBackup)
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
