package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type recordingDisabler struct {
	recordingLifecycle
	reviewed    string
	applied     string
	fingerprint string
	err         error
}

func (l *recordingDisabler) PrepareDisable(_ context.Context, id string) (packagemanager.DisableReview, error) {
	l.reviewed = id
	return packagemanager.DisableReview{ContractVersion: "addon-disable-review.v1", AddonID: id}, l.err
}
func (l *recordingDisabler) DisableReviewed(_ context.Context, id, fingerprint string) (packagemanager.ReviewedDisableResult, error) {
	l.applied, l.fingerprint = id, fingerprint
	return packagemanager.ReviewedDisableResult{AddonID: id, ConfigurationResult: packagemanager.ConfigurationResult{ContractVersion: "addon-configuration-result.v1", Applied: true}}, l.err
}
func TestReviewedDisableAdminBoundary(t *testing.T) {
	l := &recordingDisabler{}
	handler := newAdminHandler(t, l, func(*http.Request) error { return nil })
	review := serveAdminRequest(handler, "POST", "/api/admin/addons/example/disable-review", "{}")
	if review.Code != 200 || l.reviewed != "example" {
		t.Fatalf("review: %d %s", review.Code, review.Body.String())
	}
	hash := strings.Repeat("a", 64)
	applied := serveAdminRequest(handler, "POST", "/api/admin/addons/example/disable-reviewed", `{"reviewSha256":"`+hash+`"}`)
	if applied.Code != 200 || l.applied != "example" || l.fingerprint != hash {
		t.Fatalf("disable: %d %s", applied.Code, applied.Body.String())
	}
	l.applied = ""
	for _, body := range []string{`{}`, `{"reviewSha256":"bad"}`, `{"expectedStateRevision":1}`, `{"reviewSha256":"` + hash + `","targets":["unreviewed"]}`} {
		result := serveAdminRequest(handler, "POST", "/api/admin/addons/example/disable-reviewed", body)
		if result.Code != 400 || l.applied != "" {
			t.Fatalf("invalid confirmation accepted: %d", result.Code)
		}
	}
	l.err = packagemanager.ErrReviewStale
	if got := serveAdminRequest(handler, "POST", "/api/admin/addons/example/disable-reviewed", `{"reviewSha256":"`+hash+`"}`); got.Code != 409 {
		t.Fatalf("stale status %d", got.Code)
	}
	for _, action := range []string{"disable-review", "disable-reviewed"} {
		denied := &recordingDisabler{}
		h := newAdminHandler(t, denied, func(*http.Request) error { return errors.New("private authority detail") })
		result := serveAdminRequest(h, "POST", "/api/admin/addons/example/"+action, "not JSON")
		if result.Code != 403 || denied.reviewed != "" || denied.applied != "" || strings.Contains(result.Body.String(), "private authority") {
			t.Fatal("authorization not enforced before parsing")
		}
	}
}
