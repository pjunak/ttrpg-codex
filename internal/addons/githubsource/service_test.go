package githubsource

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/addons/requestcontext"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (fn transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }
func response(body []byte) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body))}
}
func jsonBody(value any) []byte { body, _ := json.Marshal(value); return body }
func digest(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:])
}
func archive(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, body := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func packageBytes(t *testing.T, addonID, version string) []byte {
	manifest := jsonBody(map[string]any{"packageFormat": 1, "id": addonID, "name": "GitHub test", "version": version,
		"compatibility": map[string]string{"host": "^2.0.0", "addonApi": "^3.0.0"}, "capabilities": map[string]any{"required": []string{}, "optional": []string{}}, "permissions": []any{}})
	checksums := jsonBody(map[string]any{"algorithm": "sha256", "files": map[string]string{"addon.json": strings.TrimPrefix(digest(manifest), "sha256:")}})
	return archive(t, map[string][]byte{"addon.json": manifest, "checksums.json": checksums})
}

type dataLifecycle struct{}

func (dataLifecycle) ReviewActivation(context.Context, string, *datacontract.Registry) ([]datalifecycle.Issue, error) {
	return nil, nil
}
func (dataLifecycle) BeginActivation(context.Context, string, string, *datacontract.Registry) (datalifecycle.Transition, error) {
	return dataTransition{}, nil
}
func (dataLifecycle) BeginDeactivation(string, string) datalifecycle.Transition {
	return dataTransition{}
}

type dataTransition struct{}

func (dataTransition) Commit()   {}
func (dataTransition) Rollback() {}

func fixture(t *testing.T) (*Service, *packagemanager.Manager, string) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := sqlite.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	inspector, err := packageinspect.New(packageinspect.DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	brokerStore, err := servicebroker.NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	contexts, err := requestcontext.New(requestcontext.Config{})
	if err != nil {
		t.Fatal(err)
	}
	broker, err := servicebroker.New(brokerStore, servicebroker.NewRuntimeDirectory(), contexts)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := packagemanager.New(packagemanager.Config{DB: db, PackageDirectory: filepath.Join(root, "addons"), Inspector: inspector, Broker: broker,
		DataLifecycle: dataLifecycle{}, HostVersion: "2.0.0", AddonAPIVersion: "3.0.0", WorkerProtocolVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.Shutdown(ctx) })
	service, err := New(Config{DB: db, DataDirectory: root, Lifecycle: manager, Inspector: inspector, EnvironmentToken: "environment-token"})
	if err != nil {
		t.Fatal(err)
	}
	return service, manager, root
}

func TestRepositoryNormalizationAndCredentialPersistence(t *testing.T) {
	s, _, root := fixture(t)
	ctx := context.Background()
	for _, raw := range []string{"Owner/Repo", "https://github.com/Owner/Repo.git/"} {
		repo, err := NormalizeRepo(raw)
		if err != nil || repo != "owner/repo" {
			t.Fatalf("normalize %q: %q %v", raw, repo, err)
		}
	}
	for _, raw := range []string{"https://github.com.evil.test/a/b", "https://user:password@github.com/a/b", "https://github.com/a/b?token=secret", "https://github.com/a/%2e%2e", "../repo", "a/..", "http://127.0.0.1/a/b"} {
		if _, err := NormalizeRepo(raw); !errors.Is(err, ErrInvalid) {
			t.Fatalf("accepted %q", raw)
		}
	}
	if err := s.SaveToken(ctx, "", "default-token"); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveToken(ctx, "Owner/Repo", "first-scoped-token"); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveToken(ctx, "owner/other", "other-scoped-token"); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveToken(ctx, "owner/repo", "replacement-token"); err != nil {
		t.Fatal(err)
	}
	if value, _ := s.token(ctx, "owner/repo"); value != "replacement-token" {
		t.Fatal("scoped token not replaced")
	}
	status, err := s.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(jsonBody(status), []byte("replacement-token")) || len(status.Credentials.Repositories) != 2 {
		t.Fatalf("bad token status: %+v", status.Credentials)
	}
	reopened, err := New(Config{DB: s.store.db, DataDirectory: root, Lifecycle: s.lifecycle, Inspector: s.inspector, EnvironmentToken: "environment-token"})
	if err != nil {
		t.Fatal(err)
	}
	if value, _ := reopened.token(ctx, "owner/repo"); value != "replacement-token" {
		t.Fatal("token lost after restart")
	}
	if err := s.SaveToken(ctx, "owner/repo", ""); err != nil {
		t.Fatal(err)
	}
	if value, _ := s.token(ctx, "owner/repo"); value != "default-token" {
		t.Fatal("missing default fallback")
	}
	if err := s.SaveToken(ctx, "", ""); err != nil {
		t.Fatal(err)
	}
	if value, _ := s.token(ctx, "owner/repo"); value != "environment-token" {
		t.Fatal("missing environment fallback")
	}
	if value, _ := s.token(ctx, "owner/other"); value != "other-scoped-token" {
		t.Fatal("unrelated token was removed")
	}
	if err := s.SaveToken(ctx, "", "bad\ntoken"); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid token accepted")
	}
	backup := filepath.Join(t.TempDir(), "backup.zip")
	manifest, err := backuparchive.Create(ctx, backuparchive.CreateConfig{Database: s.store.db, DataDirectory: root, OutputPath: backup, HostVersion: "test"})
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range manifest.Entries {
		if strings.Contains(entry.Path, "credentials") {
			t.Fatal("credentials entered backup")
		}
	}
	restored := filepath.Join(t.TempDir(), "restored")
	if _, err := backuparchive.Restore(ctx, backuparchive.RestoreConfig{ArchivePath: backup, DataDirectory: restored, Migrations: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(restored, "credentials", "github.db")); !os.IsNotExist(err) {
		t.Fatal("restored credential material")
	}
}

func TestReleaseStagesReviewedUpdatesAndTracksActiveGeneration(t *testing.T) {
	s, manager, _ := fixture(t)
	ctx := context.Background()
	source := Source{Repo: "owner/repo", Channel: "release"}
	body := packageBytes(t, "example", "1.0.0")
	assetID := int64(1)
	downloadCalls := 0
	s.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.github.com" || r.Header.Get("Authorization") != "Bearer environment-token" {
			t.Fatalf("unexpected remote request: %s", r.URL.Host)
		}
		if r.URL.Path == "/repos/owner/repo/releases/latest" {
			return response(jsonBody(map[string]any{"tag_name": "v1", "assets": []any{map[string]any{"id": assetID, "name": "example.zip", "size": len(body), "state": "uploaded", "digest": digest(body)}}})), nil
		}
		downloadCalls++
		return response(body), nil
	})
	found, err := s.Discover(ctx, source, "")
	if err != nil || len(found.Candidates) != 1 {
		t.Fatalf("discover: %+v %v", found, err)
	}
	if downloadCalls != 0 {
		t.Fatal("check downloaded a package")
	}
	first, err := s.Stage(ctx, source, "", found.Candidates[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := manager.Snapshot(ctx, "example", 10)
	if err != nil || snapshot.State.ActiveGenerationID != "" {
		t.Fatal("staging activated package")
	}
	activate := func(generation string) {
		t.Helper()
		review, err := manager.PrepareActivationReview(ctx, "example", generation)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := manager.ApproveActivationReview(ctx, review.ReviewID, []string{}); err != nil {
			t.Fatal(err)
		}
		if _, err := manager.ActivateReviewed(ctx, review.ReviewID); err != nil {
			t.Fatal(err)
		}
	}
	found, _ = s.Discover(ctx, source, "example")
	if found.Candidates[0].Active {
		t.Fatal("staged-only package reported active")
	}
	activate(first.GenerationID)
	found, _ = s.Discover(ctx, source, "example")
	if !found.Candidates[0].Active {
		t.Fatal("active release reported out of date")
	}
	oldID := found.Candidates[0].ID
	body = packageBytes(t, "example", "1.1.0")
	assetID++
	before := downloadCalls
	if _, err := s.Stage(ctx, source, "example", oldID); !errors.Is(err, ErrConflict) || downloadCalls != before {
		t.Fatal("stale discovery downloaded a moving target")
	}
	found, _ = s.Discover(ctx, source, "example")
	second, err := s.Stage(ctx, source, "example", found.Candidates[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	found, _ = s.Discover(ctx, source, "example")
	if found.Candidates[0].Active {
		t.Fatal("downloaded update reported active")
	}
	activate(second.GenerationID)
	activate(first.GenerationID)
	found, _ = s.Discover(ctx, source, "example")
	if found.Candidates[0].Active {
		t.Fatal("rollback hidden by latest download provenance")
	}
	body = packageBytes(t, "different-addon", "1.0.0")
	assetID++
	found, _ = s.Discover(ctx, source, "example")
	if _, err := s.Stage(ctx, source, "example", found.Candidates[0].ID); !errors.Is(err, ErrIdentity) {
		t.Fatalf("identity error: %v", err)
	}
	ids, _ := manager.InstalledAddonIDs(ctx)
	if len(ids) != 1 {
		t.Fatal("wrong add-on was staged")
	}
	status, _ := s.Status(ctx)
	link := status.Sources[0]
	link.Source.Repo = "owner/changed"
	if err := s.SaveSource(ctx, link, false); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveSource(ctx, link, false); !errors.Is(err, ErrConflict) {
		t.Fatal("stale source revision overwrote new source")
	}
	if _, err := s.Discover(ctx, source, "example"); !errors.Is(err, ErrConflict) {
		t.Fatal("old repository discovery still accepted")
	}
	status, _ = s.Status(ctx)
	current := status.Sources[0]
	if err := s.SaveSource(ctx, current, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.source(ctx, "example"); !errors.Is(err, ErrSourceMissing) {
		t.Fatal("unlink retained active source")
	}
	if err := s.SaveSource(ctx, LinkedSource{AddonID: "example", Source: source}, false); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveSource(ctx, current, true); !errors.Is(err, ErrConflict) {
		t.Fatal("stale unlink removed relinked source")
	}
}

func TestUpdateCompletingAfterUninstallCannotReinstallOrRelink(t *testing.T) {
	s, manager, _ := fixture(t)
	ctx := context.Background()
	body := packageBytes(t, "example", "1.0.0")
	if _, err := manager.StageArchive(ctx, bytes.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	source := Source{Repo: "owner/repo", Channel: "release"}
	if err := s.SaveSource(ctx, LinkedSource{AddonID: "example", Source: source}, false); err != nil {
		t.Fatal(err)
	}
	s.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/repos/owner/repo/releases/latest" {
			return response(jsonBody(map[string]any{"tag_name": "v1", "assets": []any{map[string]any{"id": 1, "name": "example.zip", "size": len(body), "state": "uploaded", "digest": digest(body)}}})), nil
		}
		review, err := manager.PrepareUninstall(ctx, "example")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := manager.Uninstall(ctx, "example", review.ReviewSHA256); err != nil {
			t.Fatal(err)
		}
		return response(body), nil
	})
	discovery, err := s.Discover(ctx, source, "example")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Stage(ctx, source, "example", discovery.Candidates[0].ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("late update = %v", err)
	}
	ids, err := manager.InstalledAddonIDs(ctx)
	if err != nil || len(ids) != 0 {
		t.Fatalf("removed package returned: %v,%v", ids, err)
	}
	if err := s.store.saveSource(ctx, LinkedSource{AddonID: "example", Source: source}); !errors.Is(err, ErrConflict) {
		t.Fatalf("late link restored: %v", err)
	}
	if _, err := s.store.source(ctx, "example"); !errors.Is(err, ErrSourceMissing) {
		t.Fatalf("link restored: %v", err)
	}
}

func TestActionsSelectsSuccessfulSameRepositoryBuildAndUnwrapsPackage(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	source := Source{Repo: "owner/repo", Channel: "actions", Artifact: "reviewed-package"}
	body := archive(t, map[string][]byte{"example.zip": packageBytes(t, "example", "1.0.0")})
	expired := false
	s.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/repos/owner/repo":
			return response([]byte(`{"id":1,"default_branch":"main"}`)), nil
		case "/repos/owner/repo/actions/runs":
			if r.URL.Query().Get("branch") != "main" {
				t.Fatal("default branch not used")
			}
			return response([]byte(`{"workflow_runs":[
              {"id":90,"event":"pull_request","status":"completed","conclusion":"success","head_branch":"main","head_repository":{"id":2}},
              {"id":91,"event":"push","status":"completed","conclusion":"failure","head_branch":"main","head_repository":{"id":1}},
              {"id":92,"event":"push","status":"completed","conclusion":"success","head_branch":"other","head_repository":{"id":1}},
              {"id":93,"event":"push","status":"completed","conclusion":"success","head_branch":"main","head_sha":"abc123","head_repository":{"id":1}}
            ]}`)), nil
		case "/repos/owner/repo/actions/runs/93/artifacts":
			return response(jsonBody(map[string]any{"artifacts": []any{map[string]any{"id": 7, "name": "reviewed-package", "size_in_bytes": len(body), "digest": digest(body), "expired": expired}}})), nil
		case "/repos/owner/repo/actions/artifacts/7/zip":
			return response(body), nil
		default:
			t.Fatalf("unexpected request %s", r.URL.Path)
			return nil, ErrUnavailable
		}
	})
	found, err := s.Discover(ctx, source, "")
	if err != nil {
		t.Fatal(err)
	}
	generation, err := s.Stage(ctx, source, "", found.Candidates[0].ID)
	if err != nil || generation.AddonID != "example" {
		t.Fatalf("stage: %+v %v", generation, err)
	}
	expired = true
	if _, err := s.Discover(ctx, source, "example"); !errors.Is(err, ErrNoPackage) {
		t.Fatalf("expired artifact: %v", err)
	}
	expired = false
	body = archive(t, map[string][]byte{"one.zip": []byte("first"), "two.zip": []byte("second")})
	found, _ = s.Discover(ctx, source, "example")
	if _, err := s.Stage(ctx, source, "example", found.Candidates[0].ID); !errors.Is(err, ErrPackage) {
		t.Fatalf("ambiguous artifact: %v", err)
	}
}

func TestDownloadsBoundBytesVerifyDigestAndStripRedirectCredentials(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	body := []byte("package bytes")
	candidate := Candidate{downloadPath: "/repos/owner/repo/releases/assets/1", Digest: digest(body)}
	for _, target := range []string{"https://release-assets.githubusercontent.com/file?sig=private", "http://127.0.0.1/secret", "https://github.com.evil.test/file", "https://api.github.com/other", "https://release-assets.githubusercontent.com:444/file"} {
		t.Run(target, func(t *testing.T) {
			s.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "api.github.com" {
					return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{target}}, Body: io.NopCloser(strings.NewReader(""))}, nil
				}
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Fatal("credential reached redirect target")
				}
				return response(body), nil
			})
			file, err := s.download(ctx, candidate, "release", "private-token")
			if strings.HasPrefix(target, "https://release-assets.githubusercontent.com/file") {
				if err != nil {
					t.Fatal(err)
				}
				file.Close()
				os.Remove(file.Name())
			} else if !errors.Is(err, ErrUnavailable) {
				t.Fatalf("unsafe redirect: %v", err)
			}
			if err != nil && strings.Contains(err.Error(), "private") {
				t.Fatal("signed URL leaked")
			}
		})
	}
	s.client.Transport = transportFunc(func(*http.Request) (*http.Response, error) { return response([]byte("changed bytes")), nil })
	if _, err := s.download(ctx, candidate, "release", ""); !errors.Is(err, ErrConflict) {
		t.Fatal("digest mismatch accepted")
	}
	s.client.Transport = transportFunc(func(*http.Request) (*http.Response, error) {
		r := response(body)
		r.ContentLength = packageinspect.DefaultLimits.MaxArchiveBytes + 1
		return r, nil
	})
	if _, err := s.download(ctx, candidate, "release", ""); !errors.Is(err, ErrPackage) {
		t.Fatal("oversized download accepted")
	}
}

func TestCertificateErrorsIdentifyServerTrustWithoutExposingRequestDetails(t *testing.T) {
	s, _, _ := fixture(t)
	s.client.Transport = transportFunc(func(*http.Request) (*http.Response, error) {
		return nil, &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}
	})
	_, err := s.request(context.Background(), "/repos/owner/repo/releases/latest?secret=private", "private-token", "application/json")
	if !errors.Is(err, ErrTLS) || strings.Contains(err.Error(), "private") {
		t.Fatalf("certificate failure was not safely classified: %v", err)
	}
	s.client.Transport = transportFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("network error at https://example.test/?signature=private")
	})
	_, err = s.request(context.Background(), "/repos/owner/repo/releases/latest", "private-token", "application/json")
	if !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "private") {
		t.Fatalf("network failure exposed request details: %v", err)
	}
}
