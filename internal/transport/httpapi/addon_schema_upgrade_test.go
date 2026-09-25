package httpapi

import (
	"context"
	"errors"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"net/http"
	"strings"
	"testing"
)

type recordingSchemaUpgrader struct {
	recordingLifecycle
	calls       int
	fingerprint string
	err         error
}

func (l *recordingSchemaUpgrader) PrepareSchemaReview(context.Context, string, string) (datalifecycle.SchemaReview, error) {
	l.calls++
	return datalifecycle.SchemaReview{}, l.err
}
func (l *recordingSchemaUpgrader) GetSchemaReview(context.Context, string) (datalifecycle.SchemaReview, error) {
	l.calls++
	return datalifecycle.SchemaReview{}, l.err
}
func (l *recordingSchemaUpgrader) ApplySchemaReview(_ context.Context, _ string, digest string) (datalifecycle.SchemaReview, error) {
	l.calls++
	l.fingerprint = digest
	return datalifecycle.SchemaReview{}, l.err
}
func (l *recordingSchemaUpgrader) SchemaReviewRecovery(context.Context, string) ([]byte, error) {
	l.calls++
	return []byte(`{"private":"snapshot"}`), l.err
}
func TestSchemaReviewAdminBoundary(t *testing.T) {
	hash := strings.Repeat("a", 64)
	routes := []struct{ method, path, body string }{
		{"POST", "/api/admin/addons/example/schema-reviews", `{"generationId":"` + hash + `"}`},
		{"GET", "/api/admin/addon-schema-reviews/review", ""},
		{"POST", "/api/admin/addon-schema-reviews/review/apply", `{"reviewSha256":"` + hash + `"}`},
		{"GET", "/api/admin/addon-schema-reviews/review/recovery", ""},
	}
	for _, route := range routes {
		l := &recordingSchemaUpgrader{}
		handler := newAdminHandler(t, l, func(*http.Request) error { return nil })
		result := serveAdminRequest(handler, route.method, route.path, route.body)
		if result.Code != 200 || l.calls != 1 || result.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %s", route.path, result.Code, result.Body.String())
		}
		denied := &recordingSchemaUpgrader{}
		handler = newAdminHandler(t, denied, func(*http.Request) error { return errors.New("private auth") })
		result = serveAdminRequest(handler, route.method, route.path, route.body)
		if result.Code != 403 || denied.calls != 0 || strings.Contains(result.Body.String(), "private auth") {
			t.Fatal("authorization bypass")
		}
	}
	l := &recordingSchemaUpgrader{}
	handler := newAdminHandler(t, l, func(*http.Request) error { return nil })
	for _, body := range []string{`{}`, `{"reviewSha256":"wrong"}`, `{"reviewSha256":"` + hash + `","values":[]}`} {
		if result := serveAdminRequest(handler, "POST", routes[2].path, body); result.Code != 400 || l.calls != 0 {
			t.Fatal("unreviewed apply accepted")
		}
	}
	l.err = datalifecycle.ErrUpgradeStale
	if result := serveAdminRequest(handler, "POST", routes[2].path, routes[2].body); result.Code != 409 || l.fingerprint != hash {
		t.Fatal("wrong stale boundary")
	}
}
