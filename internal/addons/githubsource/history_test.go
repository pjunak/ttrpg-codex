package githubsource

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

func TestHistoricalPackageFetchUsesExactAssetAndRepositoryCredential(t *testing.T) {
	ctx := context.Background()
	s, _, _ := fixture(t)
	body := packageBytes(t, "example", "1.0.0")
	source := Source{Repo: "owner/private", Channel: "release"}
	raw, _ := json.Marshal(source)
	ref := packagemanager.PackageReference{AddonID: "example", GenerationID: strings.TrimPrefix(digest(body), "sha256:"), Locators: []packagemanager.PackageLocator{{Source: raw, RemoteID: "original", DownloadPath: "/repos/owner/private/releases/assets/123", Digest: digest(body)}}}
	if err := s.SaveToken(ctx, "owner/private", "scoped-private-token"); err != nil {
		t.Fatal(err)
	}
	calls := 0
	s.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "api.github.com" || r.URL.Path != "/repos/owner/private/releases/assets/123" || r.Header.Get("Authorization") != "Bearer scoped-private-token" {
			t.Fatalf("wrong historical request: %s", r.URL)
		}
		return response(body), nil
	})
	dest := filepath.Join(t.TempDir(), "old.zip")
	if err := s.FetchPackage(ctx, ref, dest); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(dest)
	if err != nil || digest(actual) != digest(body) || calls != 1 {
		t.Fatal("wrong historical bytes", err, calls)
	}
	for _, path := range []string{"https://evil.test/file", "/repos/other/repo/releases/assets/123", "/repos/owner/private/releases/assets/123?token=x", "/repos/owner/private/releases/latest"} {
		ref.Locators[0].DownloadPath = path
		if err := s.FetchPackage(ctx, ref, filepath.Join(t.TempDir(), "invalid.zip")); !errors.Is(err, packagemanager.ErrPackageUnavailable) {
			t.Fatal(path, err)
		}
	}
	if calls != 1 {
		t.Fatal("untrusted locator reached network")
	}
}

func TestHistoricalLegacyLookupNeverSubstitutesLatestOrChangedBytes(t *testing.T) {
	ctx := context.Background()
	s, _, _ := fixture(t)
	body := packageBytes(t, "example", "1.0.0")
	source := Source{Repo: "owner/repo", Channel: "release"}
	raw, _ := json.Marshal(source)
	fingerprint := remoteID(41, digest(body), "original-date")
	ref := packagemanager.PackageReference{AddonID: "example", GenerationID: strings.TrimPrefix(digest(body), "sha256:"), Locators: []packagemanager.PackageLocator{{Source: raw, RemoteID: fingerprint}}}
	downloads := 0
	changed := false
	removed := false
	s.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/repos/owner/repo/releases" {
			assets := []map[string]any{{"id": 99, "digest": "sha256:newer", "updated_at": "new-date"}}
			if !removed {
				assets = append(assets, map[string]any{"id": 41, "digest": digest(body), "updated_at": "original-date"})
			}
			return response(jsonBody([]map[string]any{{"assets": assets}})), nil
		}
		if r.URL.Path != "/repos/owner/repo/releases/assets/41" {
			t.Fatal("substituted newer asset", r.URL)
		}
		downloads++
		if changed {
			return response(packageBytes(t, "example", "2.0.0")), nil
		}
		return response(body), nil
	})
	if err := s.FetchPackage(ctx, ref, filepath.Join(t.TempDir(), "old.zip")); err != nil {
		t.Fatal(err)
	}
	changed = true
	if err := s.FetchPackage(ctx, ref, filepath.Join(t.TempDir(), "changed.zip")); !errors.Is(err, packagemanager.ErrPackageUnavailable) {
		t.Fatal(err)
	}
	removed = true
	if err := s.FetchPackage(ctx, ref, filepath.Join(t.TempDir(), "missing.zip")); !errors.Is(err, packagemanager.ErrPackageUnavailable) {
		t.Fatal(err)
	}
	if downloads != 2 {
		t.Fatal("missing historical release fetched another asset")
	}
}
