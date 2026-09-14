package httpapi

import (
	"context"
	"errors"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"net/http"
	"strings"
	"testing"
)

type recordingCleaner struct {
	recordingLifecycle
	calls int
	scope packagemanager.CleanupScope
	hash  string
	err   error
}

func (c *recordingCleaner) PrepareCleanup(_ context.Context, s packagemanager.CleanupScope) (packagemanager.CleanupReview, error) {
	c.calls++
	c.scope = s
	return packagemanager.CleanupReview{}, c.err
}
func (c *recordingCleaner) Cleanup(_ context.Context, s packagemanager.CleanupScope, h string) (packagemanager.CleanupResult, error) {
	c.calls++
	c.scope = s
	c.hash = h
	return packagemanager.CleanupResult{}, c.err
}
func (c *recordingCleaner) RetryCleanups(context.Context) (packagemanager.CleanupResult, error) {
	c.calls++
	return packagemanager.CleanupResult{}, c.err
}
func TestPackageCleanupAuthorizationValidationAndErrors(t *testing.T) {
	for _, action := range []string{"review", "apply", "retry"} {
		c := &recordingCleaner{}
		h := newAdminHandler(t, c, func(*http.Request) error { return errors.New("denied") })
		response := serveAdminRequest(h, "POST", "/api/admin/addon-package-cleanup/"+action, "{")
		if response.Code != 403 || c.calls != 0 {
			t.Fatalf("authorization %s: %d %d", action, response.Code, c.calls)
		}
	}
	c := &recordingCleaner{}
	h := newAdminHandler(t, c, func(*http.Request) error { return nil })
	hash := strings.Repeat("a", 64)
	for _, request := range []struct{ action, body string }{{"review", `{"addonId":"example","keepInactive":1}`}, {"apply", `{"scope":{"addonId":"example","keepInactive":1},"reviewSha256":"` + hash + `"}`}, {"retry", `{}`}} {
		response := serveAdminRequest(h, "POST", "/api/admin/addon-package-cleanup/"+request.action, request.body)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	if c.calls != 3 || c.scope.AddonID != "example" || *c.scope.KeepInactive != 1 || c.hash != hash {
		t.Fatalf("inputs %+v", c)
	}
	for _, request := range []struct{ action, body string }{{"review", `{"force":true}`}, {"apply", `{"scope":{"keepInactive":0},"reviewSha256":"invalid"}`}, {"retry", `{"force":true}`}} {
		response := serveAdminRequest(h, "POST", "/api/admin/addon-package-cleanup/"+request.action, request.body)
		if response.Code != 400 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	if c.calls != 3 {
		t.Fatal("invalid request reached cleanup")
	}
	for _, err := range []error{packagemanager.ErrReviewStale, packagemanager.ErrCleanupPending} {
		c.err = err
		response := serveAdminRequest(h, "POST", "/api/admin/addon-package-cleanup/review", `{"keepInactive":0}`)
		if response.Code != 409 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	c.err = errors.New("private filesystem path")
	response := serveAdminRequest(h, "POST", "/api/admin/addon-package-cleanup/retry", `{}`)
	if response.Code != 500 || strings.Contains(response.Body.String(), "private") {
		t.Fatal(response.Code, response.Body.String())
	}
}
