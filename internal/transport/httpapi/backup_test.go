package httpapi

import (
	"context"
	"errors"
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
