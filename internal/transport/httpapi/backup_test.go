package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/backupbundle"
)

type recordingBackupBundles struct {
	body     []byte
	err      error
	exports  int
	imported string
}

func (bundles *recordingBackupBundles) Export(_ context.Context, w io.Writer) (backupbundle.Manifest, error) {
	bundles.exports++
	if bundles.err != nil {
		return backupbundle.Manifest{}, bundles.err
	}
	if _, err := w.Write(bundles.body); err != nil {
		return backupbundle.Manifest{}, err
	}
	return backupbundle.Manifest{Format: backupbundle.Format, CreatedAt: "2026-09-01T06:00:00Z", HostVersion: "test"}, nil
}

func (bundles *recordingBackupBundles) Import(_ context.Context, path string) (backupbundle.Manifest, error) {
	if bundles.err != nil {
		return backupbundle.Manifest{}, bundles.err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return backupbundle.Manifest{}, err
	}
	bundles.imported = string(body)
	return backupbundle.Manifest{CreatedAt: "2026-09-01T06:00:00Z", Parts: make([]backupbundle.Part, 3)}, nil
}

func backupHandler(t *testing.T, bundles BackupBundles, authorized bool) http.Handler {
	t.Helper()
	handler, err := New(Config{
		Logger: slog.New(slog.DiscardHandler), BackupBundles: bundles,
		BackupAuthorizer: func(*http.Request) error {
			if authorized {
				return nil
			}
			return errAuthorizationRequired
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func TestBackupConfigurationFailsClosed(t *testing.T) {
	t.Parallel()
	authorize := AdminAuthorizer(func(*http.Request) error { return nil })
	if _, err := New(Config{BackupBundles: &recordingBackupBundles{}}); err != ErrInvalidConfig {
		t.Fatalf("backup without authorizer error = %v", err)
	}
	if _, err := New(Config{BackupAuthorizer: authorize}); err != ErrInvalidConfig {
		t.Fatalf("backup authorizer without service error = %v", err)
	}
}

func TestBackupAuthorizesBeforeExportAndStreamsTheBundle(t *testing.T) {
	t.Parallel()
	bundles := &recordingBackupBundles{body: []byte("zip-body")}
	response := httptest.NewRecorder()
	backupHandler(t, bundles, false).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/backup", nil))
	if response.Code != http.StatusForbidden || bundles.exports != 0 {
		t.Fatalf("denied backup = %d %s; exports = %d", response.Code, response.Body.String(), bundles.exports)
	}
	allowed := backupHandler(t, bundles, true)
	response = httptest.NewRecorder()
	allowed.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/backup?ignored=true", nil))
	if response.Code != http.StatusBadRequest || bundles.exports != 0 {
		t.Fatalf("backup with query = %d", response.Code)
	}
	response = httptest.NewRecorder()
	allowed.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/backup", nil))
	if response.Code != http.StatusOK || response.Body.String() != "zip-body" || bundles.exports != 1 {
		t.Fatalf("backup = %d %q; exports = %d", response.Code, response.Body.String(), bundles.exports)
	}
	if response.Header().Get("Content-Type") != "application/zip" ||
		response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("Content-Disposition") != `attachment; filename="codex-backup-20260901-060000.zip"` {
		t.Fatalf("backup headers = %+v", response.Header())
	}
	// The full server archive restore is a maintenance command, not a route.
	response = httptest.NewRecorder()
	allowed.ServeHTTP(response, importRequest("/api/backup/restore", "zip", "application/zip"))
	if response.Code != http.StatusNotFound {
		t.Fatalf("retired restore route = %d", response.Code)
	}
}

func TestBackupContainsExportFailures(t *testing.T) {
	t.Parallel()
	response := httptest.NewRecorder()
	backupHandler(t, &recordingBackupBundles{err: errors.New("private filesystem path")}, true).
		ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/backup", nil))
	if response.Code != http.StatusServiceUnavailable ||
		!strings.Contains(response.Body.String(), `"kind":"BACKUP_UNAVAILABLE"`) ||
		strings.Contains(response.Body.String(), "filesystem") {
		t.Fatalf("backup failure = %d %s", response.Code, response.Body.String())
	}
}

func importRequest(path, body, contentType string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", contentType)
	return request
}

func TestBackupImportAuthorizesAndChecksTheUpload(t *testing.T) {
	t.Parallel()
	bundles := &recordingBackupBundles{}
	response := httptest.NewRecorder()
	backupHandler(t, bundles, false).ServeHTTP(response, importRequest("/api/backup/import", "zip", "application/zip"))
	if response.Code != http.StatusForbidden || bundles.imported != "" {
		t.Fatalf("denied import = %d; imported %q", response.Code, bundles.imported)
	}
	handler := backupHandler(t, bundles, true)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, importRequest("/api/backup/import", "zip", "text/plain"))
	if response.Code != http.StatusUnsupportedMediaType || bundles.imported != "" {
		t.Fatalf("import with wrong type = %d", response.Code)
	}
	tooLarge := importRequest("/api/backup/import", "zip", "application/zip")
	tooLarge.ContentLength = backupbundle.MaximumArchiveBytes + 1
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, tooLarge)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized import = %d", response.Code)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, importRequest("/api/backup/import", "bundle-body", "application/zip"))
	if response.Code != http.StatusOK || bundles.imported != "bundle-body" ||
		response.Body.String() != `{"contractVersion":"backup-import.v1","createdAt":"2026-09-01T06:00:00Z","parts":3}`+"\n" {
		t.Fatalf("import = %d %s; imported %q", response.Code, response.Body.String(), bundles.imported)
	}
}

func TestBackupImportReportsInvalidBundlesAndHidesOtherFailures(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		err  error
		code int
		kind string
	}{
		{fmt.Errorf("%w: manifest is missing", backupbundle.ErrInvalid), http.StatusBadRequest, "INVALID_BACKUP"},
		{errors.New("private disk path"), http.StatusServiceUnavailable, "BACKUP_UNAVAILABLE"},
	} {
		response := httptest.NewRecorder()
		backupHandler(t, &recordingBackupBundles{err: test.err}, true).
			ServeHTTP(response, importRequest("/api/backup/import", "zip", "application/zip"))
		if response.Code != test.code || !strings.Contains(response.Body.String(), `"kind":"`+test.kind+`"`) ||
			strings.Contains(response.Body.String(), "disk path") {
			t.Fatalf("import failure %v = %d %s", test.err, response.Code, response.Body.String())
		}
	}
}
