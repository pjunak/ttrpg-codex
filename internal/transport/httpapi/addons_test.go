package httpapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

func TestAddonAdminConfigurationFailsClosed(t *testing.T) {
	t.Parallel()

	if _, err := New(Config{AddonLifecycle: &recordingLifecycle{}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("lifecycle without authorizer error = %v", err)
	}
	if _, err := New(Config{AdminAuthorizer: AdminAuthorizer(func(*http.Request) error { return nil })}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("authorizer without lifecycle error = %v", err)
	}
	handler, err := New(Config{Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	response := serveAdminRequest(handler, http.MethodGet, "/api/admin/addons/example.addon", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("unconfigured admin route status = %d", response.Code)
	}
}

func TestAddonAdminAuthorizationRunsBeforeRequestParsing(t *testing.T) {
	t.Parallel()

	lifecycle := &recordingLifecycle{}
	handler := newAdminHandler(t, lifecycle, func(*http.Request) error {
		return errors.New("session rejected with private detail")
	})
	response := serveAdminRequest(
		handler, http.MethodPost, "/api/admin/addons/example.addon/activation-reviews", "not-json",
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if lifecycle.prepareCalls != 0 {
		t.Fatalf("prepare calls = %d", lifecycle.prepareCalls)
	}
	if bytes.Contains(response.Body.Bytes(), []byte("private detail")) {
		t.Fatalf("authorization detail leaked: %s", response.Body.String())
	}
}

func TestAddonAdminReviewEndpoints(t *testing.T) {
	t.Parallel()

	lifecycle := &recordingLifecycle{}
	handler := newAdminHandler(t, lifecycle, func(*http.Request) error { return nil })

	response := serveAdminRequest(
		handler, http.MethodPost, "/api/admin/addons/example.addon/activation-reviews",
		`{"generationId":"generation-2"}`,
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("prepare status = %d, body = %s", response.Code, response.Body.String())
	}
	if lifecycle.preparedAddonID != "example.addon" || lifecycle.preparedGenerationID != "generation-2" {
		t.Fatalf("prepare input = %q, %q", lifecycle.preparedAddonID, lifecycle.preparedGenerationID)
	}

	response = serveAdminRequest(
		handler, http.MethodPost, "/api/admin/addon-activation-reviews/review-1/approval",
		`{"grantedPermissionIds":["content.read","content.write"]}`,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("approve status = %d, body = %s", response.Code, response.Body.String())
	}
	if lifecycle.approvedReviewID != "review-1" || len(lifecycle.approvedGrants) != 2 {
		t.Fatalf("approval input = %q, %#v", lifecycle.approvedReviewID, lifecycle.approvedGrants)
	}

	response = serveAdminRequest(
		handler, http.MethodGet, "/api/admin/addon-activation-reviews/review-1", "",
	)
	if response.Code != http.StatusOK || lifecycle.readReviewID != "review-1" {
		t.Fatalf("get review status = %d, id = %q", response.Code, lifecycle.readReviewID)
	}

	response = serveAdminRequest(
		handler, http.MethodPost, "/api/admin/addon-activation-reviews/review-1/activation", "",
	)
	if response.Code != http.StatusOK || lifecycle.activatedReviewID != "review-1" {
		t.Fatalf("activate status = %d, id = %q", response.Code, lifecycle.activatedReviewID)
	}
}

func TestAddonAdminStagesBoundedZipUpload(t *testing.T) {
	t.Parallel()

	lifecycle := &recordingLifecycle{}
	handler := newAdminHandler(t, lifecycle, func(*http.Request) error { return nil })
	request := httptest.NewRequest(
		http.MethodPost, "/api/admin/addons/generations", strings.NewReader("package-bytes"),
	)
	request.Header.Set("Content-Type", "application/zip")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || lifecycle.stagedBody != "package-bytes" {
		t.Fatalf("stage response/input = %d, %q, %s", response.Code, lifecycle.stagedBody, response.Body.String())
	}

	request = httptest.NewRequest(
		http.MethodPost, "/api/admin/addons/generations", strings.NewReader("not-a-zip"),
	)
	request.Header.Set("Content-Type", "application/octet-stream")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("wrong media type response = %d, %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(
		http.MethodPost, "/api/admin/addons/generations", strings.NewReader("short"),
	)
	request.Header.Set("Content-Type", "application/zip")
	request.ContentLength = maxAddonPackageBytes + 1
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized response = %d, %s", response.Code, response.Body.String())
	}
}

func TestAddonAdminOperationalEndpoints(t *testing.T) {
	t.Parallel()

	lifecycle := &recordingLifecycle{}
	handler := newAdminHandler(t, lifecycle, func(*http.Request) error { return nil })

	response := serveAdminRequest(
		handler, http.MethodGet, "/api/admin/addons/example.addon?eventLimit=27", "",
	)
	if response.Code != http.StatusOK || lifecycle.snapshotAddonID != "example.addon" || lifecycle.snapshotEventLimit != 27 {
		t.Fatalf("snapshot status/input = %d, %q, %d", response.Code, lifecycle.snapshotAddonID, lifecycle.snapshotEventLimit)
	}

	response = serveAdminRequest(
		handler, http.MethodPost, "/api/admin/addons/example.addon/reload",
		`{"expectedStateRevision":3}`,
	)
	if response.Code != http.StatusOK || lifecycle.reloadAddonID != "example.addon" || lifecycle.reloadRevision != 3 {
		t.Fatalf("reload status/input = %d, %q, %d", response.Code, lifecycle.reloadAddonID, lifecycle.reloadRevision)
	}

	response = serveAdminRequest(
		handler, http.MethodPost, "/api/admin/addons/example.addon/disable",
		`{"expectedStateRevision":4}`,
	)
	if response.Code != http.StatusOK || lifecycle.disablePlan.AddonID != "example.addon" || lifecycle.disablePlan.ExpectedStateRevision != 4 {
		t.Fatalf("disable status/input = %d, %#v", response.Code, lifecycle.disablePlan)
	}
}

func TestAddonAdminRejectsAmbiguousOrInvalidInput(t *testing.T) {
	t.Parallel()

	lifecycle := &recordingLifecycle{}
	handler := newAdminHandler(t, lifecycle, func(*http.Request) error { return nil })
	cases := []struct {
		name string
		path string
		body string
	}{
		{"unknown field", "/api/admin/addons/example.addon/reload", `{"expectedStateRevision":1,"force":true}`},
		{"missing revision", "/api/admin/addons/example.addon/reload", `{}`},
		{"multiple values", "/api/admin/addons/example.addon/reload", `{"expectedStateRevision":1}{}`},
		{"invalid path id", "/api/admin/addons/bad:id/reload", `{"expectedStateRevision":1}`},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			response := serveAdminRequest(handler, http.MethodPost, test.path, test.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if !bytes.Contains(response.Body.Bytes(), []byte(`"kind":"INVALID_REQUEST"`)) {
				t.Fatalf("body = %s", response.Body.String())
			}
		})
	}
	if lifecycle.reloadCalls != 0 {
		t.Fatalf("reload calls = %d", lifecycle.reloadCalls)
	}
}

func TestAddonSnapshotRejectsAmbiguousQuery(t *testing.T) {
	t.Parallel()

	lifecycle := &recordingLifecycle{}
	handler := newAdminHandler(t, lifecycle, func(*http.Request) error { return nil })
	for _, path := range []string{
		"/api/admin/addons/example.addon?eventLimit=1&eventLimit=2",
		"/api/admin/addons/example.addon?events=2",
	} {
		response := serveAdminRequest(handler, http.MethodGet, path, "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("path %q status = %d, body = %s", path, response.Code, response.Body.String())
		}
	}
	if lifecycle.snapshotAddonID != "" {
		t.Fatalf("snapshot called for %q", lifecycle.snapshotAddonID)
	}
}

func TestAddonAdminEnforcesJSONMediaTypeAndBodyLimit(t *testing.T) {
	t.Parallel()

	lifecycle := &recordingLifecycle{}
	handler := newAdminHandler(t, lifecycle, func(*http.Request) error { return nil })

	request := httptest.NewRequest(
		http.MethodPost, "/api/admin/addons/example.addon/reload",
		bytes.NewBufferString(`{"expectedStateRevision":1}`),
	)
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("media type status = %d, body = %s", response.Code, response.Body.String())
	}

	response = serveAdminRequest(
		handler, http.MethodPost, "/api/admin/addons/example.addon/reload",
		strings.Repeat(" ", maxAdminRequestBytes+1),
	)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("body limit status = %d, body = %s", response.Code, response.Body.String())
	}
	if lifecycle.reloadCalls != 0 {
		t.Fatalf("reload calls = %d", lifecycle.reloadCalls)
	}
}

func TestLifecycleErrorsUseStablePublicClassifications(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    error
		status int
		kind   string
	}{
		{"wrapped conflict", errors.Join(packagemanager.ErrReviewStale, errors.New("private state")), http.StatusConflict, "REVIEW_STALE"},
		{"invalid grant", packagemanager.ErrPermission, http.StatusUnprocessableEntity, "PERMISSION"},
		{"worker startup", packagemanager.ErrActivationFailed, http.StatusServiceUnavailable, "ACTIVATION_FAILED"},
		{"unknown internal", errors.New("private database path"), http.StatusInternalServerError, "INTERNAL"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			status, kind, message := classifyLifecycleError(test.err)
			if status != test.status || kind != test.kind {
				t.Fatalf("classification = %d, %q", status, kind)
			}
			if bytes.Contains([]byte(message), []byte("private")) {
				t.Fatalf("private detail leaked in %q", message)
			}
		})
	}
}

func newAdminHandler(
	t *testing.T,
	lifecycle AddonLifecycle,
	authorize func(*http.Request) error,
) http.Handler {
	t.Helper()
	handler, err := New(Config{
		Version:         "test-version",
		Logger:          slog.New(slog.DiscardHandler),
		AddonLifecycle:  lifecycle,
		AdminAuthorizer: AdminAuthorizer(authorize),
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func serveAdminRequest(handler http.Handler, method string, path string, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

type recordingLifecycle struct {
	stagedBody           string
	prepareCalls         int
	preparedAddonID      string
	preparedGenerationID string
	readReviewID         string
	approvedReviewID     string
	approvedGrants       []string
	activatedReviewID    string
	snapshotAddonID      string
	snapshotEventLimit   int
	reloadCalls          int
	reloadAddonID        string
	reloadRevision       int64
	disablePlan          packagemanager.DisablePlan
}

func (lifecycle *recordingLifecycle) InstalledAddonIDs(context.Context) ([]string, error) {
	return []string{"disabled-addon", "staged-addon"}, nil
}

func TestInstalledAddonInventoryAuthorization(t *testing.T) {
	t.Parallel()
	handler := newAdminHandler(t, &recordingLifecycle{}, func(*http.Request) error { return nil })
	response := serveAdminRequest(handler, http.MethodGet, "/api/admin/addons", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"staged-addon"`) {
		t.Fatalf("inventory = %d %s", response.Code, response.Body.String())
	}
	denied := newAdminHandler(t, &recordingLifecycle{}, func(*http.Request) error { return errors.New("denied") })
	if response := serveAdminRequest(denied, http.MethodGet, "/api/admin/addons", ""); response.Code != http.StatusForbidden {
		t.Fatal(response.Code)
	}
}

func (lifecycle *recordingLifecycle) StageArchive(
	_ context.Context, archive io.Reader,
) (packagemanager.Generation, error) {
	body, err := io.ReadAll(archive)
	if err != nil {
		return packagemanager.Generation{}, err
	}
	lifecycle.stagedBody = string(body)
	digest := strings.Repeat("a", 64)
	return packagemanager.Generation{
		AddonID: "uploaded-addon", GenerationID: digest, ArchiveSHA256: digest,
	}, nil
}

func (lifecycle *recordingLifecycle) Snapshot(
	_ context.Context, addonID string, eventLimit int,
) (packagemanager.Snapshot, error) {
	lifecycle.snapshotAddonID = addonID
	lifecycle.snapshotEventLimit = eventLimit
	return packagemanager.Snapshot{State: packagemanager.State{AddonID: addonID}}, nil
}

func (lifecycle *recordingLifecycle) PrepareActivationReview(
	_ context.Context, addonID string, generationID string,
) (packagemanager.ActivationReview, error) {
	lifecycle.prepareCalls++
	lifecycle.preparedAddonID = addonID
	lifecycle.preparedGenerationID = generationID
	return packagemanager.ActivationReview{ReviewID: "review-1", AddonID: addonID, GenerationID: generationID}, nil
}

func (lifecycle *recordingLifecycle) GetActivationReview(
	_ context.Context, reviewID string,
) (packagemanager.ActivationReview, error) {
	lifecycle.readReviewID = reviewID
	return packagemanager.ActivationReview{ReviewID: reviewID}, nil
}

func (lifecycle *recordingLifecycle) ApproveActivationReview(
	_ context.Context, reviewID string, grantedPermissionIDs []string,
) (packagemanager.ActivationReview, error) {
	lifecycle.approvedReviewID = reviewID
	lifecycle.approvedGrants = append([]string(nil), grantedPermissionIDs...)
	return packagemanager.ActivationReview{ReviewID: reviewID, Status: packagemanager.ReviewApproved}, nil
}

func (lifecycle *recordingLifecycle) ActivateReviewed(
	_ context.Context, reviewID string,
) (packagemanager.ActivationResult, error) {
	lifecycle.activatedReviewID = reviewID
	return packagemanager.ActivationResult{ReviewID: reviewID}, nil
}

func (lifecycle *recordingLifecycle) Reload(
	_ context.Context, addonID string, expectedStateRevision int64,
) (packagemanager.ActivationResult, error) {
	lifecycle.reloadCalls++
	lifecycle.reloadAddonID = addonID
	lifecycle.reloadRevision = expectedStateRevision
	return packagemanager.ActivationResult{State: packagemanager.State{AddonID: addonID}}, nil
}

func (lifecycle *recordingLifecycle) Disable(
	_ context.Context, plan packagemanager.DisablePlan,
) (packagemanager.DisableResult, error) {
	lifecycle.disablePlan = plan
	return packagemanager.DisableResult{State: packagemanager.State{AddonID: plan.AddonID}}, nil
}
