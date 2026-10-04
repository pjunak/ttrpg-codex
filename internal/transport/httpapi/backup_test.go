package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
)

func TestBackupConfigurationFailsClosed(t *testing.T) {
	t.Parallel()
	archives := &recordingBackupArchives{}
	authorize := AdminAuthorizer(func(*http.Request) error { return nil })
	if _, err := New(Config{BackupArchives: archives}); err != ErrInvalidConfig {
		t.Fatalf("backup without authorizer error = %v", err)
	}
	if _, err := New(Config{BackupAuthorizer: authorize}); err != ErrInvalidConfig {
		t.Fatalf("backup authorizer without service error = %v", err)
	}
}

func TestBackupAuthorizesBeforeCreationAndStreamsGeneratedArchive(t *testing.T) {
	t.Parallel()
	archives := &recordingBackupArchives{body: []byte("zip-body")}
	denied, err := New(Config{
		Logger: slog.New(slog.DiscardHandler), BackupArchives: archives,
		BackupAuthorizer: func(*http.Request) error { return errAuthorizationRequired },
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	denied.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/backup?ignored=true", nil))
	if response.Code != http.StatusForbidden || archives.calls != 0 {
		t.Fatalf("denied backup = %d %s; calls = %d", response.Code, response.Body.String(), archives.calls)
	}

	allowed, err := New(Config{
		Logger: slog.New(slog.DiscardHandler), BackupArchives: archives,
		BackupAuthorizer: func(*http.Request) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	allowed.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/backup", nil))
	if response.Code != http.StatusOK || response.Body.String() != "zip-body" || archives.calls != 1 {
		t.Fatalf("backup = %d %q; calls = %d", response.Code, response.Body.String(), archives.calls)
	}
	if response.Header().Get("Content-Type") != "application/zip" ||
		response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("Content-Disposition") != `attachment; filename="codex-backup-20260901-060000.zip"` {
		t.Fatalf("backup headers = %+v", response.Header())
	}
}

func TestBackupContainsCreatorFailures(t *testing.T) {
	t.Parallel()
	archives := &recordingBackupArchives{err: errors.New("private filesystem path")}
	handler, err := New(Config{
		Logger: slog.New(slog.DiscardHandler), BackupArchives: archives,
		BackupAuthorizer: func(*http.Request) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/backup", nil))
	if response.Code != http.StatusServiceUnavailable ||
		!strings.Contains(response.Body.String(), `"kind":"BACKUP_UNAVAILABLE"`) ||
		strings.Contains(response.Body.String(), "filesystem") {
		t.Fatalf("backup failure = %d %s", response.Code, response.Body.String())
	}
}

type recordingBackupArchives struct {
	body  []byte
	err   error
	calls int
}

func (archives *recordingBackupArchives) Create(_ context.Context, outputPath string) (backuparchive.Manifest, error) {
	archives.calls++
	if archives.err != nil {
		return backuparchive.Manifest{}, archives.err
	}
	if err := os.WriteFile(outputPath, archives.body, 0o640); err != nil {
		return backuparchive.Manifest{}, err
	}
	return backuparchive.Manifest{
		ContractVersion: backuparchive.ContractVersion,
		CreatedAt:       "2026-09-01T06:00:00Z",
		HostVersion:     "test",
	}, nil
}

func TestBackupRestoreStagesUploadThenRequestsRestart(t *testing.T) {
	t.Parallel()
	restores := &recordingBackupRestores{}
	denied, err := New(Config{
		Logger: slog.New(slog.DiscardHandler), BackupArchives: &recordingBackupArchives{}, BackupRestores: restores,
		BackupAuthorizer: func(*http.Request) error { return errAuthorizationRequired },
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	denied.ServeHTTP(response, restoreRequest("zip", "application/zip"))
	if response.Code != http.StatusForbidden || restores.staged != "" {
		t.Fatalf("denied restore = %d; staged %q", response.Code, restores.staged)
	}

	handler, err := New(Config{
		Logger: slog.New(slog.DiscardHandler), BackupArchives: &recordingBackupArchives{}, BackupRestores: restores,
		BackupAuthorizer: func(*http.Request) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, restoreRequest("zip", "text/plain"))
	if response.Code != http.StatusUnsupportedMediaType || restores.restarts != 0 {
		t.Fatalf("restore with wrong type = %d", response.Code)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, restoreRequest("backup-body", "application/zip"))
	if response.Code != http.StatusAccepted || restores.staged != "backup-body" || restores.restarts != 1 ||
		!strings.Contains(response.Body.String(), `"createdAt":"2026-09-01T06:00:00Z"`) {
		t.Fatalf("restore = %d %s; staged %q restarts %d", response.Code, response.Body.String(), restores.staged, restores.restarts)
	}
}

func TestBackupRestoreReportsInvalidAndPendingWithoutRestarting(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		err  error
		code int
		kind string
	}{
		{fmt.Errorf("%w: manifest is missing", backuparchive.ErrInvalidArchive), http.StatusBadRequest, "INVALID_BACKUP"},
		{backuparchive.ErrRestorePending, http.StatusConflict, "RESTORE_PENDING"},
		{errors.New("private disk path"), http.StatusServiceUnavailable, "RESTORE_UNAVAILABLE"},
	} {
		restores := &recordingBackupRestores{err: test.err}
		handler, err := New(Config{
			Logger: slog.New(slog.DiscardHandler), BackupArchives: &recordingBackupArchives{}, BackupRestores: restores,
			BackupAuthorizer: func(*http.Request) error { return nil },
		})
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, restoreRequest("zip", "application/zip"))
		if response.Code != test.code || !strings.Contains(response.Body.String(), `"kind":"`+test.kind+`"`) ||
			strings.Contains(response.Body.String(), "disk path") || restores.restarts != 0 {
			t.Fatalf("restore failure %v = %d %s; restarts %d", test.err, response.Code, response.Body.String(), restores.restarts)
		}
	}
}

func restoreRequest(body, contentType string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/backup/restore", strings.NewReader(body))
	request.Header.Set("Content-Type", contentType)
	return request
}

type recordingBackupRestores struct {
	staged   string
	restarts int
	err      error
}

func (restores *recordingBackupRestores) Stage(_ context.Context, archivePath string) (backuparchive.RestoreResult, error) {
	if restores.err != nil {
		return backuparchive.RestoreResult{}, restores.err
	}
	body, err := os.ReadFile(archivePath)
	if err != nil {
		return backuparchive.RestoreResult{}, err
	}
	restores.staged = string(body)
	return backuparchive.RestoreResult{Manifest: backuparchive.Manifest{CreatedAt: "2026-09-01T06:00:00Z", HostVersion: "test"}}, nil
}

func (restores *recordingBackupRestores) Restart() { restores.restarts++ }
