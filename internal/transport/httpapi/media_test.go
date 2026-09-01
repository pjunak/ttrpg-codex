package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	applicationmedia "github.com/pjunak/ttrpg-codex/internal/application/media"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/mediastore"
)

func TestMediaConfigurationFailsClosed(t *testing.T) {
	t.Parallel()
	allow := MediaAuthorizer(func(*http.Request) (applicationmedia.Authority, error) {
		return applicationmedia.Authority{Role: applicationmedia.RoleDM}, nil
	})
	if _, err := New(Config{Media: &mediaStub{}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("media without authorizer error = %v", err)
	}
	if _, err := New(Config{MediaAuthorizer: allow}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("authorizer without media error = %v", err)
	}
}

func TestMediaUploadAuthorizesBeforeReadingAndReturnsOpaqueURL(t *testing.T) {
	t.Parallel()
	stub := &mediaStub{}
	denied, err := New(Config{
		Media: stub,
		MediaAuthorizer: func(*http.Request) (applicationmedia.Authority, error) {
			return applicationmedia.Authority{}, errAuthorizationRequired
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/media/character-portrait/hero", strings.NewReader("image"))
	request.Header.Set("Content-Type", "image/png")
	response := httptest.NewRecorder()
	denied.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || stub.uploadCalls != 0 {
		t.Fatalf("denied upload = %d, calls %d", response.Code, stub.uploadCalls)
	}

	allowed, err := New(Config{
		Media: stub, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaAuthorizer: func(*http.Request) (applicationmedia.Authority, error) {
			return applicationmedia.Authority{Role: applicationmedia.RolePlayer}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPost, "/api/media/character-portrait/hero", strings.NewReader("image"))
	request.Header.Set("Content-Type", "image/png")
	request.Header.Set("X-Codex-Filename", "Hrdina%20%C5%BElu%C5%A5ou%C4%8Dk%C3%BD.png")
	response = httptest.NewRecorder()
	allowed.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || stub.uploadCalls != 1 || stub.uploadBody != "image" ||
		stub.uploadName != "Hrdina žluťoučký.png" {
		t.Fatalf("upload = %d, calls %d, body %q: %s", response.Code, stub.uploadCalls, stub.uploadBody, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"url":"/api/media/b_11111111111111111111111111111111"`) ||
		!strings.Contains(response.Body.String(), `"contractVersion":"media-blob.v1"`) {
		t.Fatalf("upload response = %s", response.Body.String())
	}
}

func TestMediaReadStreamsWithVisibilityAwareCacheHeaders(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	filename := filepath.Join(directory, "blob")
	if err := os.WriteFile(filename, []byte("image bytes"), 0o640); err != nil {
		t.Fatal(err)
	}
	stub := &mediaStub{openPath: filename}
	handler, err := New(Config{
		Media: stub,
		MediaAuthorizer: func(*http.Request) (applicationmedia.Authority, error) {
			return applicationmedia.Authority{Role: applicationmedia.RoleAnonymous}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodGet, "/api/media/b_11111111111111111111111111111111", nil,
	))
	if response.Code != http.StatusOK || response.Body.String() != "image bytes" {
		t.Fatalf("read = %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "public, no-cache" ||
		response.Header().Get("ETag") != `"`+strings.Repeat("a", 64)+`"` ||
		!strings.Contains(response.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("read headers = %#v", response.Header())
	}
}

func TestMediaDeleteRequiresExactContract(t *testing.T) {
	t.Parallel()
	stub := &mediaStub{}
	handler, err := New(Config{
		Media: stub,
		MediaAuthorizer: func(*http.Request) (applicationmedia.Authority, error) {
			return applicationmedia.Authority{Role: applicationmedia.RoleDM}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodDelete, "/api/media/b_11111111111111111111111111111111",
		strings.NewReader(`{"contractVersion":"wrong","expectedRevision":1}`),
	)
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || stub.deleteCalls != 0 {
		t.Fatalf("invalid delete = %d, calls %d", response.Code, stub.deleteCalls)
	}
	response = httptest.NewRecorder()
	request = httptest.NewRequest(
		http.MethodDelete, "/api/media/b_11111111111111111111111111111111",
		strings.NewReader(`{"contractVersion":"media-delete.v1","expectedRevision":1}`),
	)
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || stub.deleteCalls != 1 ||
		!strings.Contains(response.Body.String(), `"contractVersion":"media-delete-result.v1"`) {
		t.Fatalf("delete = %d, calls %d: %s", response.Code, stub.deleteCalls, response.Body.String())
	}
}

func TestSessionMediaAuthorizerUsesEffectiveRoleAndBoundCSRF(t *testing.T) {
	t.Parallel()
	service, err := sessionauth.New(sessionauth.Config{
		DMPassword: "dragon-master", PlayerPassword: "adventurer",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := service.Login("dragon-master")
	if err != nil {
		t.Fatal(err)
	}
	authorize := SessionMediaAuthorizer(service)
	request := httptest.NewRequest(http.MethodPost, "/api/media/world-map/main", nil)
	request = request.WithContext(sessionauth.WithActor(request.Context(), session.Actor))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session.Token})
	if _, err := authorize(request); !errors.Is(err, errAuthorizationRequired) {
		t.Fatalf("missing CSRF error = %v", err)
	}
	request.Header.Set(csrfHeaderName, session.CSRFToken)
	authority, err := authorize(request)
	if err != nil || authority.Role != applicationmedia.RoleDM {
		t.Fatalf("DM authority = %+v, %v", authority, err)
	}
	playerView, err := service.SwitchRole(session.Token, sessionauth.RolePlayer)
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/media/id", nil)
	request = request.WithContext(sessionauth.WithActor(request.Context(), playerView.Actor))
	authority, err = authorize(request)
	if err != nil || authority.Role != applicationmedia.RolePlayer {
		t.Fatalf("effective player authority = %+v, %v", authority, err)
	}
}

type mediaStub struct {
	uploadCalls int
	uploadBody  string
	uploadName  string
	deleteCalls int
	openPath    string
}

func (stub *mediaStub) Upload(
	_ context.Context,
	_ applicationmedia.Authority,
	request applicationmedia.UploadRequest,
) (applicationmedia.Asset, error) {
	stub.uploadCalls++
	body, err := io.ReadAll(request.Content)
	stub.uploadBody = string(body)
	stub.uploadName = request.OriginalName
	if err != nil {
		return applicationmedia.Asset{}, err
	}
	return stubAsset(false), nil
}

func (stub *mediaStub) Open(
	_ context.Context,
	_ applicationmedia.Authority,
	_ string,
) (*os.File, applicationmedia.Asset, error) {
	file, err := os.Open(stub.openPath)
	return file, stubAsset(false), err
}

func (stub *mediaStub) Latest(
	context.Context,
	applicationmedia.Authority,
	applicationmedia.Kind,
	string,
) (applicationmedia.Asset, error) {
	return stubAsset(false), nil
}

func (stub *mediaStub) Delete(
	context.Context,
	applicationmedia.Authority,
	string,
	int64,
) (applicationmedia.Asset, error) {
	stub.deleteCalls++
	return stubAsset(true), nil
}

func stubAsset(deleted bool) applicationmedia.Asset {
	createdAt := time.Date(2026, time.September, 1, 17, 0, 0, 0, time.UTC)
	revision := int64(1)
	if deleted {
		revision = 2
	}
	return applicationmedia.Asset{
		Binding: mediastore.Asset{
			Sequence: 1, BlobID: "b_11111111111111111111111111111111",
			Kind: string(applicationmedia.CharacterPortrait), TargetKey: "hero", CreatedAt: createdAt,
		},
		Blob: blobstore.Blob{
			ID: "b_11111111111111111111111111111111", SHA256: strings.Repeat("a", 64),
			Bytes: uint64(len("image bytes")), OwnerKind: blobstore.OwnerCore,
			OwnerID: "campaign", Purpose: "media", MediaType: "image/png",
			OriginalName: "hero.png", Visibility: blobstore.VisibilityPublic,
			Revision: revision, Deleted: deleted, CreatedAt: createdAt, UpdatedAt: createdAt,
		},
	}
}
