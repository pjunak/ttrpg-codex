package packagemanager

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

func writeLanguagePack(t *testing.T, locale, versions, catalog string) string {
	t.Helper()
	var body bytes.Buffer
	manifest := packageinspect.PackManifest{PackFormat: 1, AddonID: "browser-addon", Locale: locale,
		AddonVersions: versions, BuiltFrom: "1.0.0", Catalog: "messages.json"}
	if versions == ">=2.0.0" {
		manifest.BuiltFrom = "2.0.0"
	}
	if err := packageinspect.WritePack(&body, manifest, map[string][]byte{"messages.json": []byte(catalog)}); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "browser-addon-1.0.0."+locale+".langpack.zip")
	if err := os.WriteFile(filename, body.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return filename
}

func catalogLocale(t *testing.T, graph BrowserGraph, locale string) BrowserCatalogLocale {
	t.Helper()
	for _, catalog := range graph.Catalogs[0].Locales {
		if catalog.Locale == locale {
			return catalog
		}
	}
	t.Fatalf("no %s catalog in %+v", locale, graph.Catalogs[0].Locales)
	return BrowserCatalogLocale{}
}

func TestLanguagePacksMergeIntoCatalogsAndSurviveRestart(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := testDatabase(t)
	packageDirectory := filepath.Join(t.TempDir(), "packages")
	manager, _ := testManager(t, db, packageDirectory, &fakeRuntimeFactory{})
	generation, err := manager.Stage(ctx, writeAddonPackage(t, packageSpec{
		ID: "browser-addon", Version: "1.0.0", UIEntry: "web/index.js",
		Locales: map[string]string{"en": "locales/en.json", "cs": "locales/cs.json"},
		ExtraFiles: map[string][]byte{
			"locales/en.json": []byte(`{"contractVersion":"message-catalog.v1","locale":"en","sections":{"main":{"main.title":"Planner","main.empty":"Nothing yet"}}}`),
			"locales/cs.json": []byte(`{"contractVersion":"message-catalog.v1","locale":"cs","sections":{"main":{"main.title":"Plánovač"}}}`),
		},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: "browser-addon", GenerationID: generation.GenerationID}); err != nil {
		t.Fatal(err)
	}
	targets, err := manager.LanguagePackTargets(ctx)
	if err != nil || len(targets) != 1 || targets[0].Version != "1.0.0" || targets[0].GenerationID != generation.GenerationID || len(targets[0].Packs) != 0 {
		t.Fatalf("targets = %+v, %v", targets, err)
	}
	target := targets[0]

	// A pack for other versions or a generation that is no longer active is refused.
	if _, err := manager.InstallLanguagePack(ctx, target, writeLanguagePack(t, "cs", ">=2.0.0", `{"contractVersion":"message-catalog.v1","locale":"cs","sections":{}}`)); !errors.Is(err, ErrLanguagePackMismatch) {
		t.Fatalf("other versions error = %v", err)
	}
	stale := target
	stale.GenerationID = strings.Repeat("a", 64)
	if _, err := manager.InstallLanguagePack(ctx, stale, writeLanguagePack(t, "de", ">=1.0.0 <2.0.0", `{"contractVersion":"message-catalog.v1","locale":"de","sections":{"main":{"main.title":"Planer"}}}`)); !errors.Is(err, ErrLanguagePackStale) {
		t.Fatalf("stale generation error = %v", err)
	}

	czech, err := manager.InstallLanguagePack(ctx, target, writeLanguagePack(t, "cs", ">=1.0.0 <2.0.0",
		`{"contractVersion":"message-catalog.v1","locale":"cs","sections":{"main":{"main.title":"Plánovač z balíčku","main.empty":"Zatím nic"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	german, err := manager.InstallLanguagePack(ctx, target, writeLanguagePack(t, "de", ">=1.0.0 <2.0.0",
		`{"contractVersion":"message-catalog.v1","locale":"de","sections":{"main":{"main.title":"Planer"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	manager.RecordLanguagePackCheck(ctx, LanguagePackCheck{
		AddonID: "browser-addon", GenerationID: generation.GenerationID, Available: []string{"fr", "de", "cs"},
		Results: map[string]LanguagePackResult{"it": {Status: PackFailed, Error: "rate-limited"}, "pl": {Status: PackNone}},
	})

	assertGraph := func(manager *Manager) {
		t.Helper()
		graph, err := manager.BrowserGraph(ctx)
		if err != nil {
			t.Fatal(err)
		}
		cs, de := catalogLocale(t, graph, "cs"), catalogLocale(t, graph, "de")
		if cs.Source != "package+pack" || cs.Messages != 2 || de.Source != "pack" || de.Messages != 1 {
			t.Fatalf("catalogs = %+v", graph.Catalogs[0].Locales)
		}
		opened, err := manager.OpenLocaleCatalog(ctx, "browser-addon", generation.GenerationID, "cs", cs.SHA256)
		if err != nil || !strings.Contains(string(opened.Body), `"main.title":"Plánovač"`) || !strings.Contains(string(opened.Body), "Zatím nic") {
			t.Fatalf("merged Czech = %s, %v", opened.Body, err)
		}
		if _, err := manager.OpenLocaleCatalog(ctx, "browser-addon", generation.GenerationID, "de", de.SHA256); err != nil {
			t.Fatal(err)
		}
		want := []BrowserLanguagePack{
			{Locale: "cs", Status: PackInstalled, Version: "1.0.0"},
			{Locale: "de", Status: PackInstalled, Version: "1.0.0"},
			{Locale: "fr", Status: PackAvailable},
			{Locale: "it", Status: PackFailed, Error: "rate-limited"},
			{Locale: "pl", Status: PackNone},
		}
		packs := graph.Catalogs[0].Packs
		if len(packs) != len(want) {
			t.Fatalf("packs = %+v", packs)
		}
		for index := range want {
			if packs[index] != want[index] {
				t.Fatalf("packs = %+v", packs)
			}
		}
	}
	assertGraph(manager)
	for _, pack := range []packageinspect.PackReport{czech, german} {
		if _, err := os.Stat(filepath.Join(packageDirectory, ".language-packs", pack.ArchiveSHA256+".zip")); err != nil {
			t.Fatal(err)
		}
	}

	// A restarted host serves the stored packs again. Check results are not
	// stored: the next check reports them.
	if err := manager.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	restarted, _ := testManager(t, db, packageDirectory, &fakeRuntimeFactory{})
	if _, err := restarted.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	restarted.RecordLanguagePackCheck(ctx, LanguagePackCheck{
		AddonID: "browser-addon", GenerationID: generation.GenerationID, Available: []string{"fr", "de", "cs"},
		Results: map[string]LanguagePackResult{"it": {Status: PackFailed, Error: "rate-limited"}, "pl": {Status: PackNone}},
	})
	assertGraph(restarted)
	targets, err = restarted.LanguagePackTargets(ctx)
	if err != nil || targets[0].Packs["cs"] != czech.ArchiveSHA256 || targets[0].Packs["de"] != german.ArchiveSHA256 {
		t.Fatalf("restarted targets = %+v, %v", targets, err)
	}

	// Disabling German removes its pack, its file and its catalog.
	if err := restarted.RemoveLanguagePacks(ctx, func(_, locale string) bool { return locale != "de" }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(packageDirectory, ".language-packs", german.ArchiveSHA256+".zip")); !os.IsNotExist(err) {
		t.Fatalf("German pack file remains: %v", err)
	}
	var rows int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM addon_language_packs`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("rows = %d, %v", rows, err)
	}
	graph, err := restarted.BrowserGraph(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, catalog := range graph.Catalogs[0].Locales {
		if catalog.Locale == "de" {
			t.Fatalf("German catalog remains: %+v", graph.Catalogs[0].Locales)
		}
	}

	// A stored pack whose file disappeared is reported and left out of the targets, so the next check fetches it again.
	if err := restarted.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(packageDirectory, ".language-packs", czech.ArchiveSHA256+".zip")); err != nil {
		t.Fatal(err)
	}
	broken, _ := testManager(t, db, packageDirectory, &fakeRuntimeFactory{})
	if _, err := broken.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if targets, err = broken.LanguagePackTargets(ctx); err != nil || len(targets[0].Packs) != 0 {
		t.Fatalf("targets with a missing file = %+v, %v", targets, err)
	}
	graph, err = broken.BrowserGraph(ctx)
	if err != nil || catalogLocale(t, graph, "cs").Source != "package" ||
		graph.Catalogs[0].Packs[0] != (BrowserLanguagePack{Locale: "cs", Status: PackFailed, Error: "storage"}) {
		t.Fatalf("graph with a missing pack = %+v, %v", graph.Catalogs, err)
	}
	if err := broken.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}
