package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type recordingPackageStorage struct {
	recordingLifecycle
	calls int
	err   error
}

func (s *recordingPackageStorage) PackageStorage(context.Context) (packagemanager.PackageStorage, error) {
	s.calls++
	return packagemanager.PackageStorage{ContractVersion: "addon-package-storage.v1", Automatic: true}, s.err
}

func TestPackageStorageAuthorizationValidationAndSafeErrors(t *testing.T) {
	s := &recordingPackageStorage{}
	denied := newAdminHandler(t, s, func(*http.Request) error { return errors.New("denied") })
	if result := serveAdminRequest(denied, "GET", "/api/admin/addon-package-storage", ""); result.Code != 403 || s.calls != 0 {
		t.Fatal(result.Code)
	}
	allowed := newAdminHandler(t, s, func(*http.Request) error { return nil })
	if result := serveAdminRequest(allowed, "GET", "/api/admin/addon-package-storage?all=1", ""); result.Code != 400 || s.calls != 0 {
		t.Fatal(result.Code, s.calls)
	}
	result := serveAdminRequest(allowed, "GET", "/api/admin/addon-package-storage", "")
	if result.Code != 200 || result.Header().Get("Cache-Control") != "no-store" || !strings.Contains(result.Body.String(), `"automatic":true`) {
		t.Fatal(result.Code, result.Body.String())
	}
	// Downloading, restoring and preparing old builds are no longer offered.
	if result := serveAdminRequest(allowed, "POST", "/api/admin/addon-package-storage/restore", "{}"); result.Code != 404 && result.Code != 405 {
		t.Fatal("removed operation still routed", result.Code)
	}
	s.err = errors.New("private/token/path")
	result = serveAdminRequest(allowed, "GET", "/api/admin/addon-package-storage", "")
	if result.Code != 500 || strings.Contains(result.Body.String(), "private/token") {
		t.Fatal(result.Code, result.Body.String())
	}
}
