package githubsource

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/events"
)

func languagePackBytes(t *testing.T, locale, versions, builtFrom, name string) []byte {
	t.Helper()
	var body bytes.Buffer
	catalog := `{"contractVersion":"message-catalog.v1","locale":"` + locale + `","sections":{"manifest":{"manifest.name":"` + name + `"}}}`
	if err := packageinspect.WritePack(&body, packageinspect.PackManifest{PackFormat: 1, AddonID: "example", Locale: locale,
		AddonVersions: versions, BuiltFrom: builtFrom, Catalog: "messages.json"}, map[string][]byte{"messages.json": []byte(catalog)}); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func activateExample(t *testing.T, manager *packagemanager.Manager, body []byte) {
	t.Helper()
	ctx := context.Background()
	generation, err := manager.StageArchive(ctx, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	review, err := manager.PrepareActivationReview(ctx, "example", generation.GenerationID)
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

type packRemote struct {
	mu        sync.Mutex
	limited   bool
	releases  []any
	assets    map[string][]byte
	downloads []string
}

func (remote *packRemote) roundTrip(t *testing.T) transportFunc {
	return func(r *http.Request) (*http.Response, error) {
		remote.mu.Lock()
		defer remote.mu.Unlock()
		if r.URL.Host != "api.github.com" {
			t.Errorf("unexpected host %s", r.URL.Host)
		}
		if remote.limited {
			return &http.Response{StatusCode: 403, Header: http.Header{"X-Ratelimit-Remaining": {"0"}}, Body: io.NopCloser(strings.NewReader("{}"))}, nil
		}
		if r.URL.Path == "/repos/owner/repo/releases" && r.URL.Query().Get("per_page") == "30" {
			return response(jsonBody(remote.releases)), nil
		}
		if body, ok := remote.assets[r.URL.Path]; ok {
			remote.downloads = append(remote.downloads, r.URL.Path)
			return response(body), nil
		}
		return &http.Response{StatusCode: 404, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	}
}

func packAssetJSON(id int, name string, body []byte) map[string]any {
	return map[string]any{"id": id, "name": name, "state": "uploaded", "size": len(body), "digest": digest(body), "updated_at": "2026-11-01T00:00:00Z"}
}

func catalogsOf(t *testing.T, manager *packagemanager.Manager) packagemanager.BrowserCatalogs {
	t.Helper()
	graph, err := manager.BrowserGraph(context.Background())
	if err != nil || len(graph.Catalogs) != 1 {
		t.Fatalf("graph = %+v, %v", graph, err)
	}
	return graph.Catalogs[0]
}

func packStatus(catalogs packagemanager.BrowserCatalogs, locale string) packagemanager.BrowserLanguagePack {
	for _, pack := range catalogs.Packs {
		if pack.Locale == locale {
			return pack
		}
	}
	return packagemanager.BrowserLanguagePack{}
}

func TestPackSyncFetchesMatchingPacksAndRemovesDisabledLanguages(t *testing.T) {
	s, manager, _ := fixture(t)
	ctx := context.Background()
	activateExample(t, manager, packageBytes(t, "example", "1.0.0"))

	newer := languagePackBytes(t, "cs", ">=1.1.0 <2.0.0", "1.1.0", "Příklad 1.1")
	current := languagePackBytes(t, "cs", ">=1.0.0 <2.0.0", "1.0.0", "Příklad")
	french := languagePackBytes(t, "fr", ">=1.0.0 <2.0.0", "1.0.0", "Exemple")
	remote := &packRemote{
		releases: []any{
			map[string]any{"draft": true, "assets": []any{packAssetJSON(9, "example-1.2.0.cs.langpack.zip", newer)}},
			map[string]any{"assets": []any{
				packAssetJSON(1, "example-1.1.0.zip", packageBytes(t, "example", "1.1.0")),
				packAssetJSON(2, "example-1.1.0.cs.langpack.zip", newer),
				packAssetJSON(3, "example-1.1.0.fr.langpack.zip", french),
				packAssetJSON(4, "other-1.1.0.de.langpack.zip", french),
			}},
			map[string]any{"assets": []any{packAssetJSON(5, "example-1.0.0.cs.langpack.zip", current)}},
		},
		assets: map[string][]byte{
			"/repos/owner/repo/releases/assets/2": newer,
			"/repos/owner/repo/releases/assets/3": french,
			"/repos/owner/repo/releases/assets/5": current,
		},
	}
	s.client.Transport = remote.roundTrip(t)

	enabled := []string{"en", "cs", "de"}
	sync, err := NewPackSync(PackSyncConfig{Service: s, Host: manager, EnabledLocales: func(context.Context) ([]string, error) { return enabled, nil }})
	if err != nil {
		t.Fatal(err)
	}
	// Without a GitHub source the add-on is not checked at all.
	if err := sync.Check(ctx, true); err != nil || len(remote.downloads) != 0 || len(catalogsOf(t, manager).Packs) != 0 {
		t.Fatalf("unlinked check: %v, downloads %v", err, remote.downloads)
	}
	if err := s.SaveSource(ctx, LinkedSource{AddonID: "example", Source: Source{Repo: "owner/repo", Channel: "release"}}, false); err != nil {
		t.Fatal(err)
	}
	if err := sync.Check(ctx, true); err != nil {
		t.Fatal(err)
	}
	// The pack built from the active version is preferred over the newer one.
	if len(remote.downloads) != 1 || remote.downloads[0] != "/repos/owner/repo/releases/assets/5" {
		t.Fatalf("downloads = %v", remote.downloads)
	}
	catalogs := catalogsOf(t, manager)
	if packStatus(catalogs, "cs") != (packagemanager.BrowserLanguagePack{Locale: "cs", Status: "installed", Version: "1.0.0"}) ||
		packStatus(catalogs, "de") != (packagemanager.BrowserLanguagePack{Locale: "de", Status: "none"}) ||
		packStatus(catalogs, "fr") != (packagemanager.BrowserLanguagePack{Locale: "fr", Status: "available"}) || len(catalogs.Packs) != 3 {
		t.Fatalf("packs = %+v", catalogs.Packs)
	}
	var czech packagemanager.BrowserCatalogLocale
	for _, locale := range catalogs.Locales {
		if locale.Locale == "cs" {
			czech = locale
		}
	}
	if czech.Source != "pack" || czech.Messages != 1 {
		t.Fatalf("Czech catalog = %+v", czech)
	}

	// A stored pack whose digest is still published is not downloaded again.
	if err := sync.Check(ctx, true); err != nil || len(remote.downloads) != 1 {
		t.Fatalf("repeat check: %v, downloads %v", err, remote.downloads)
	}

	// A failed check keeps the installed pack, reports the failure and is
	// retried by the next pass.
	remote.limited = true
	if err := sync.Check(ctx, true); err != nil {
		t.Fatal(err)
	}
	catalogs = catalogsOf(t, manager)
	if packStatus(catalogs, "cs") != (packagemanager.BrowserLanguagePack{Locale: "cs", Status: "installed", Version: "1.0.0", Error: "rate-limited"}) ||
		packStatus(catalogs, "de") != (packagemanager.BrowserLanguagePack{Locale: "de", Status: "failed", Error: "rate-limited"}) {
		t.Fatalf("packs after a failure = %+v", catalogs.Packs)
	}
	remote.limited = false
	if err := sync.Check(ctx, false); err != nil {
		t.Fatal(err)
	}
	if packStatus(catalogsOf(t, manager), "de").Status != "none" {
		t.Fatalf("retry did not run: %+v", catalogsOf(t, manager).Packs)
	}

	// Disabling Czech removes its pack; enabling French fetches one.
	enabled = []string{"en", "fr"}
	if err := sync.Check(ctx, false); err != nil {
		t.Fatal(err)
	}
	catalogs = catalogsOf(t, manager)
	if packStatus(catalogs, "cs").Status != "available" || packStatus(catalogs, "fr").Status != "installed" {
		t.Fatalf("packs after changing languages = %+v", catalogs.Packs)
	}
	var rows int
	if err := s.store.db.QueryRowContext(ctx, `SELECT count(*) FROM addon_language_packs WHERE locale = 'cs'`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("Czech rows = %d, %v", rows, err)
	}
}

func TestDiscoveryIgnoresLanguagePacks(t *testing.T) {
	s, _, _ := fixture(t)
	body := packageBytes(t, "example", "1.0.0")
	pack := languagePackBytes(t, "cs", ">=1.0.0 <2.0.0", "1.0.0", "Příklad")
	s.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/repos/owner/repo/releases/latest" {
			return response(jsonBody(map[string]any{"tag_name": "v1", "assets": []any{
				packAssetJSON(1, "example-1.0.0.zip", body), packAssetJSON(2, "example-1.0.0.cs.langpack.zip", pack)}})), nil
		}
		return &http.Response{StatusCode: 404, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})
	found, err := s.Discover(context.Background(), Source{Repo: "owner/repo", Channel: "release"}, "")
	if err != nil || len(found.Candidates) != 1 || found.Candidates[0].Name != "example-1.0.0.zip" {
		t.Fatalf("discover = %+v, %v", found, err)
	}
}

func TestRelevantPackEvents(t *testing.T) {
	metadata := func(reason string) json.RawMessage { return jsonBody(map[string]string{"reason": reason}) }
	for _, test := range []struct {
		event events.Event
		want  bool
	}{
		{events.Event{Topic: "campaign-data-changed", ResourceID: "settings"}, true},
		{events.Event{Topic: "campaign-data-changed", ResourceID: "characters"}, false},
		{events.Event{Topic: "campaign-restored"}, true},
		{events.Event{Topic: "browser-addons-changed", Metadata: metadata("activated")}, true},
		{events.Event{Topic: "browser-addons-changed", Metadata: metadata("language-packs")}, false},
		{events.Event{Topic: "addon-data-changed"}, false},
	} {
		if got := relevantPackEvent(test.event); got != test.want {
			t.Errorf("%+v = %v", test.event, got)
		}
	}
}

func TestPackSyncFollowsEventsInTheBackground(t *testing.T) {
	s, manager, _ := fixture(t)
	broker, err := events.New(events.Config{DB: s.store.db})
	if err != nil {
		t.Fatal(err)
	}
	checks := make(chan []string, 8)
	sync, err := NewPackSync(PackSyncConfig{Service: s, Host: manager,
		EnabledLocales: func(context.Context) ([]string, error) {
			checks <- []string{"en"}
			return []string{"en"}, nil
		},
		Subscribe: func() (*events.Subscription, error) { return broker.Subscribe(events.AudienceDM) },
	})
	if err != nil {
		t.Fatal(err)
	}
	sync.Start(context.Background())
	defer sync.Stop()
	<-checks // the start-up check
	for range 50 {
		if _, err := broker.Publish(context.Background(), events.Publication{Audience: events.AudiencePublic, Topic: "campaign-data-changed", ResourceID: "settings", Revision: "2"}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-checks:
			return
		default:
		}
	}
	<-checks
}
