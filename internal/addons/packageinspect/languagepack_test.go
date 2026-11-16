package packageinspect

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	packEnglish = `{"contractVersion":"message-catalog.v1","locale":"en","sections":{
		"browse":{"browse.title":"Browse","browse.results":{"one":"{n} result","other":"{n} results"},"browse.clear":"Clear"}}}`
	packCzech = `{"contractVersion":"message-catalog.v1","locale":"cs","sections":{"browse":{"browse.title":"Procházet"}}}`
)

func testPackManifest() PackManifest {
	return PackManifest{PackFormat: 1, AddonID: "example-addon", Locale: "cs", AddonVersions: ">=1.0.0 <2.0.0", BuiltFrom: "1.0.0", Catalog: "messages.json"}
}

func writeTestPack(t *testing.T, manifest PackManifest, files map[string][]byte) string {
	t.Helper()
	var buffer bytes.Buffer
	if err := WritePack(&buffer, manifest, files); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "example.cs.langpack.zip")
	if err := os.WriteFile(filename, buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestInspectPackFileAcceptsDeclaredCatalogAndContent(t *testing.T) {
	t.Parallel()
	manifest := testPackManifest()
	manifest.Content = []string{"content/i18n/cs.json"}
	catalog := `{"contractVersion":"message-catalog.v1","locale":"cs","sections":{
		"manifest":{"manifest.name":"Ukázka"},
		"browse":{"browse.title":"Procházet","manifest.misplaced":"x"}}}`
	filename := writeTestPack(t, manifest, map[string][]byte{
		"messages.json":        []byte(catalog),
		"content/i18n/cs.json": []byte(`{"id":"cs","kind":"i18n","name":"Čeština","entries":{}}`),
	})
	report, err := newTestInspector(t).InspectPackFile(context.Background(), filename)
	if err != nil {
		t.Fatal(err)
	}
	if report.Manifest.AddonID != "example-addon" || report.Manifest.Locale != "cs" || len(report.ArchiveSHA256) != 64 ||
		len(report.Files) != 3 || report.Catalog == nil || report.Catalog.Messages != 2 ||
		len(report.Catalog.Issues) != 1 || !strings.HasPrefix(report.Catalog.Issues[0], "manifest.misplaced:") {
		t.Fatalf("report = %+v catalog %+v", report, report.Catalog)
	}
	if !report.Applies("1.4.2") || report.Applies("2.0.0") || report.Applies("not-a-version") {
		t.Fatal("version range is not applied")
	}
	if !bytes.Equal(report.CatalogBody(), []byte(catalog)) {
		t.Fatal("catalog body differs from the pack file")
	}
	// Building the same pack twice gives the same bytes.
	var first, second bytes.Buffer
	files := map[string][]byte{"messages.json": []byte(packCzech)}
	if WritePack(&first, testPackManifest(), files) != nil || WritePack(&second, testPackManifest(), files) != nil ||
		!bytes.Equal(first.Bytes(), second.Bytes()) {
		t.Fatal("pack ZIPs are not deterministic")
	}
}

func TestInspectPackFileRejectsBrokenPacks(t *testing.T) {
	t.Parallel()
	valid := map[string][]byte{"messages.json": []byte(packCzech)}
	for _, test := range []struct {
		name     string
		manifest func(*PackManifest)
		files    map[string][]byte
		raw      []zipEntry
		code     string
	}{
		{name: "undeclared file", files: map[string][]byte{"messages.json": []byte(packCzech), "web/index.js": []byte("x")}, code: CodeInvalidPack},
		{name: "missing catalog", files: map[string][]byte{}, code: CodeMissingFile},
		{name: "English pack", manifest: func(m *PackManifest) { m.Locale = "en" }, code: CodeInvalidPack},
		{name: "invalid add-on ID", manifest: func(m *PackManifest) { m.AddonID = "Bad_ID" }, code: CodeInvalidPack},
		{name: "range without builtFrom", manifest: func(m *PackManifest) { m.AddonVersions = ">=2.0.0" }, code: CodeInvalidPack},
		{name: "not a range", manifest: func(m *PackManifest) { m.AddonVersions = "soon" }, code: CodeInvalidPack},
		{name: "neither catalog nor content", manifest: func(m *PackManifest) { m.Catalog = "" }, files: map[string][]byte{}, code: CodeInvalidPack},
		{name: "content outside content/", manifest: func(m *PackManifest) { m.Content = []string{"data/x.json"} }, files: map[string][]byte{"messages.json": []byte(packCzech), "data/x.json": []byte("{}")}, code: CodeInvalidPack},
		{name: "content not JSON", manifest: func(m *PackManifest) { m.Content = []string{"content/x.json"} }, files: map[string][]byte{"messages.json": []byte(packCzech), "content/x.json": []byte("nope")}, code: CodeInvalidPack},
		{name: "catalog in another language", files: map[string][]byte{"messages.json": []byte(strings.Replace(packCzech, `"cs"`, `"sk"`, 1))}, code: CodeInvalidPack},
		{name: "traversal", raw: []zipEntry{{name: "pack.json", body: []byte("{}")}, {name: "../messages.json", body: []byte(packCzech)}}, code: CodeUnsafePath},
		{name: "no manifest", raw: []zipEntry{{name: "messages.json", body: []byte(packCzech)}}, code: CodeMissingFile},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var filename string
			if test.raw != nil {
				filename = writeRawZip(t, test.raw)
			} else {
				manifest := testPackManifest()
				if test.manifest != nil {
					test.manifest(&manifest)
				}
				files := test.files
				if files == nil {
					files = valid
				}
				filename = writeTestPack(t, manifest, files)
			}
			_, err := newTestInspector(t).InspectPackFile(context.Background(), filename)
			assertInspectionCode(t, err, test.code)
		})
	}
}

func TestLanguagePackExampleIsValid(t *testing.T) {
	t.Parallel()
	body, err := os.ReadFile("../../../contracts/addons/v3/examples/language-pack.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := newTestInspector(t).parsePackManifest(body); err != nil {
		t.Fatal(err)
	}
}

func TestPackFileNames(t *testing.T) {
	t.Parallel()
	if name := PackFileName("dnd-2024-compendium-3.6.0", "pt-BR"); name != "dnd-2024-compendium-3.6.0.pt-BR.langpack.zip" {
		t.Fatalf("PackFileName = %s", name)
	}
	for _, test := range []struct {
		name, version, locale string
		ok                    bool
	}{
		{name: "dnd-2024-compendium-3.6.0.pt-BR.langpack.zip", version: "3.6.0", locale: "pt-BR", ok: true},
		{name: "dnd-2024-compendium-3.6.0-rc.1.de.langpack.zip", version: "3.6.0-rc.1", locale: "de", ok: true},
		{name: "dnd-2024-compendium-3.6.0.zip"},
		{name: "dnd-2024-compendium-3.6.0.en.langpack.zip"},
		{name: "dnd-2024-compendium-extra-3.6.0.cs.langpack.zip", version: "extra-3.6.0", locale: "cs", ok: true},
		{name: "other-addon-1.0.0.cs.langpack.zip"},
		{name: "dnd-2024-compendium-.cs.langpack.zip"},
		{name: "dnd-2024-compendium-3.6.0.CS.langpack.zip"},
	} {
		version, locale, ok := ParsePackFileName(test.name, "dnd-2024-compendium")
		if ok != test.ok || version != test.version || locale != test.locale {
			t.Errorf("ParsePackFileName(%q) = %q %q %v", test.name, version, locale, ok)
		}
	}
	if !IsPackFileName("X.cs.LANGPACK.zip") || IsPackFileName("x.zip") {
		t.Fatal("IsPackFileName")
	}
	for version, want := range map[string]string{"3.6.0": ">=3.6.0 <4.0.0", "0.4.2": ">=0.4.2 <0.5.0"} {
		if got, err := DefaultPackVersions(version); err != nil || got != want {
			t.Errorf("DefaultPackVersions(%s) = %q %v", version, got, err)
		}
	}
}

func TestMergePackCatalogPrefersPackageMessages(t *testing.T) {
	t.Parallel()
	inspector := newTestInspector(t)
	manifest := map[string]any{}
	if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["locales"] = map[string]any{"en": "locales/en.json", "cs": "locales/cs.json"}
	body, _ := json.Marshal(manifest)
	report, err := inspector.InspectFile(context.Background(), writePackage(t, map[string][]byte{
		manifestFilename:  body,
		"locales/en.json": []byte(packEnglish),
		"locales/cs.json": []byte(packCzech),
	}))
	if err != nil {
		t.Fatal(err)
	}
	inspect := func(locale, catalog string) PackReport {
		packManifest := testPackManifest()
		packManifest.Locale = locale
		pack, err := inspector.InspectPackFile(context.Background(), writeTestPack(t, packManifest, map[string][]byte{"messages.json": []byte(catalog)}))
		if err != nil {
			t.Fatal(err)
		}
		return pack
	}

	// The package's own Czech wins; the pack fills the missing keys and its
	// unknown key and changed placeholders are dropped as issues.
	merged, source, err := inspector.MergePackCatalog(report.Locales, inspect("cs", `{"contractVersion":"message-catalog.v1","locale":"cs","sections":{
		"manifest":{"manifest.name":"Ukázkový doplněk"},
		"browse":{"browse.title":"Prohlížet","browse.clear":"Vymazat","browse.gone":"Pryč","browse.results":{"one":"{count} výsledek","other":"{count} výsledků"}}}}`))
	if err != nil || source != "package+pack" {
		t.Fatalf("merge = %v %s", err, source)
	}
	assertCatalogBody(t, merged, map[string]any{
		"browse.title":  "Procházet",
		"browse.clear":  "Vymazat",
		"manifest.name": "Ukázkový doplněk",
	})
	if merged.Messages != 3 || merged.Path != "locales/cs.json" || len(merged.Issues) != 2 ||
		!strings.HasPrefix(merged.Issues[0], "language pack: browse.gone:") {
		t.Fatalf("merged = %+v", merged)
	}

	// A pack that adds nothing leaves the package's catalog as it is.
	unchanged, source, err := inspector.MergePackCatalog(report.Locales, inspect("cs", packCzech))
	if err != nil || source != "package" || unchanged.SHA256 != report.Locales[1].SHA256 || len(unchanged.Issues) != 0 {
		t.Fatalf("unchanged = %+v %s %v", unchanged, source, err)
	}

	// A language only the pack supplies.
	german, source, err := inspector.MergePackCatalog(report.Locales, inspect("de", `{"contractVersion":"message-catalog.v1","locale":"de","sections":{"browse":{"browse.title":"Durchsuchen"}}}`))
	if err != nil || source != "pack" || german.Locale != "de" || german.Path != "" || german.Messages != 1 {
		t.Fatalf("German = %+v %s %v", german, source, err)
	}
}
