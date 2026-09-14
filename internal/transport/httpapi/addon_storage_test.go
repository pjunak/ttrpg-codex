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

func (s *recordingPackageStorage) PackageStorage(context.Context, int64, int64) (packagemanager.PackageStorage, error) {
	s.calls++
	return packagemanager.PackageStorage{}, s.err
}
func (s *recordingPackageStorage) RestorePackage(context.Context, string, string) (packagemanager.Generation, error) {
	s.calls++
	return packagemanager.Generation{}, s.err
}
func (s *recordingPackageStorage) PrepareRecoveryPackages(context.Context, int64, int64) (packagemanager.PackageStorage, error) {
	s.calls++
	return packagemanager.PackageStorage{}, s.err
}
func (s *recordingPackageStorage) RetryPackageEvictions(context.Context) error {
	s.calls++
	return s.err
}

func TestPackageStorageAuthorizationValidationAndSafeErrors(t *testing.T) {
	s := &recordingPackageStorage{}
	denied := newAdminHandler(t, s, func(*http.Request) error { return errors.New("denied") })
	for _, action := range []string{"restore", "review", "prepare", "retry"} {
		result := serveAdminRequest(denied, "POST", "/api/admin/addon-package-storage/"+action, "{")
		if result.Code != 403 || s.calls != 0 {
			t.Fatal(action, result.Code, s.calls)
		}
	}
	if result := serveAdminRequest(denied, "GET", "/api/admin/addon-package-storage", ""); result.Code != 403 || s.calls != 0 {
		t.Fatal(result.Code)
	}
	allowed := newAdminHandler(t, s, func(*http.Request) error { return nil })
	for _, input := range []struct{ action, body string }{{"restore", `{"addonId":"example","generationId":"bad"}`}, {"review", `{"pointId":-1,"expectedRevision":1}`}, {"prepare", `{"pointId":1,"expectedRevision":1,"force":true}`}, {"retry", `{"all":true}`}} {
		result := serveAdminRequest(allowed, "POST", "/api/admin/addon-package-storage/"+input.action, input.body)
		if result.Code != 400 || s.calls != 0 {
			t.Fatal(input, result.Code, s.calls)
		}
	}
	for _, input := range []struct{ action, body string }{{"restore", `{"addonId":"example","generationId":"` + strings.Repeat("a", 64) + `"}`}, {"review", `{"pointId":1,"expectedRevision":1}`}, {"prepare", `{"pointId":1,"expectedRevision":1}`}, {"retry", `{}`}} {
		result := serveAdminRequest(allowed, "POST", "/api/admin/addon-package-storage/"+input.action, input.body)
		if result.Code != 200 || result.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(input, result.Code)
		}
	}
	for _, check := range []struct {
		err    error
		status int
	}{{packagemanager.ErrReviewStale, 409}, {packagemanager.ErrPackageUnavailable, 503}, {errors.New("private/token/path"), 500}} {
		s.err = check.err
		result := serveAdminRequest(allowed, "POST", "/api/admin/addon-package-storage/prepare", `{"pointId":1,"expectedRevision":1}`)
		if result.Code != check.status || strings.Contains(result.Body.String(), "private/token") {
			t.Fatal(result.Code, result.Body.String())
		}
	}
}
