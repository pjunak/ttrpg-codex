package packageinspect

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const catalogFixtures = "../../../contracts/addons/v3/examples/catalogs"

func TestCatalogRulesMatchSharedFixtures(t *testing.T) {
	t.Parallel()

	var fixture struct {
		Cases []struct {
			Name     string   `json:"name"`
			File     string   `json:"file"`
			Locale   string   `json:"locale"`
			English  string   `json:"english"`
			Rejected bool     `json:"rejected"`
			Dropped  []string `json:"dropped"`
			Messages int      `json:"messages"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readCatalogFixture(t, "cases.json"), &fixture); err != nil {
		t.Fatal(err)
	}
	inspector := newTestInspector(t)
	for _, test := range fixture.Cases {
		t.Run(test.Name, func(t *testing.T) {
			t.Parallel()
			var english *messageCatalog
			if test.English != "" {
				var err error
				if english, err = orderedCatalog(readCatalogFixture(t, test.English)); err != nil {
					t.Fatal(err)
				}
			}
			catalog, issues, dropped := inspector.checkCatalog(readCatalogFixture(t, test.File), test.Locale, english)
			if (catalog == nil) != test.Rejected {
				t.Fatalf("rejected = %v, want %v (issues %q)", catalog == nil, test.Rejected, issues)
			}
			if test.Rejected {
				if len(issues) != 1 {
					t.Fatalf("issues = %q", issues)
				}
				return
			}
			if len(dropped) == 0 {
				dropped = []string{}
			}
			if !reflect.DeepEqual(dropped, append([]string{}, test.Dropped...)) || len(issues) != len(test.Dropped) {
				t.Fatalf("dropped %q with issues %q, want %q", dropped, issues, test.Dropped)
			}
			if catalog.messageCount() != test.Messages {
				t.Fatalf("messages = %d, want %d", catalog.messageCount(), test.Messages)
			}
		})
	}
}

func TestInspectFileBuildsEffectiveLocaleCatalogs(t *testing.T) {
	t.Parallel()

	var manifest map[string]any
	if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["description"] = "Browse example rules."
	manifest["runtime"] = map[string]any{"ui": map[string]any{"mode": "integrated", "entry": "web/index.js"}}
	manifest["contributions"] = []any{
		map[string]any{
			"id": "browse.route", "surface": "route", "label": "Browse",
			"config": map[string]any{"path": "browse", "labels": map[string]any{"cs": "Procházet"}},
		},
		map[string]any{
			"id": "browse.sidebar", "surface": "sidebar", "label": "Browse",
			"config": map[string]any{"route": "browse.route", "labels": map[string]any{"cs": "Procházení"}},
		},
	}
	manifest["locales"] = map[string]any{"en": "locales/en.json", "cs": "locales/cs.json", "sk": "locales/sk.json"}
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	english := `{"contractVersion":"message-catalog.v1","locale":"en","sections":{
		"browse":{"browse.title":"Browse","browse.count":{"one":"{n} rule","other":"{n} rules"}}}}`
	czech := `{"contractVersion":"message-catalog.v1","locale":"cs","sections":{
		"manifest":{"manifest.contribution.browse.sidebar.label":"Pravidla"},
		"browse":{"browse.title":"Procházet","browse.count":{"one":"{n} pravidlo","few":"{n} pravidla","other":"{n} pravidel"},"browse.extra":"Navíc"}}}`
	packagePath := writePackage(t, map[string][]byte{
		manifestFilename:  body,
		"web/index.js":    []byte("export function activate() {}"),
		"locales/en.json": []byte(english),
		"locales/cs.json": []byte(czech),
		"locales/sk.json": []byte(`{"browse.title":"Prehliadať"}`),
	})
	report, err := newTestInspector(t).InspectFile(context.Background(), packagePath)
	if err != nil {
		t.Fatal(err)
	}
	locales := make([]string, 0, len(report.Locales))
	for _, locale := range report.Locales {
		locales = append(locales, locale.Locale)
	}
	if !reflect.DeepEqual(locales, []string{"en", "cs", "sk"}) {
		t.Fatalf("locales = %q", locales)
	}

	en := report.Locales[0]
	if en.Path != "locales/en.json" || en.Messages != 6 || len(en.Issues) != 0 ||
		!reflect.DeepEqual(en.Sections, []string{"manifest", "browse"}) || len(en.SHA256) != 64 {
		t.Fatalf("English catalog = %+v", en)
	}
	assertCatalogBody(t, en, map[string]any{
		"manifest.name":                            "Example Add-on",
		"manifest.description":                     "Browse example rules.",
		"manifest.contribution.browse.route.label": "Browse",
		"browse.title":                             "Browse",
	})
	if !strings.HasPrefix(string(en.Body()), `{"contractVersion":"message-catalog.v1","locale":"en","sections":{"manifest":{"manifest.name"`) {
		t.Fatalf("English body does not keep file order: %s", en.Body())
	}

	cs := report.Locales[1]
	if cs.Messages != 4 || len(cs.Issues) != 1 || !strings.HasPrefix(cs.Issues[0], "browse.extra:") {
		t.Fatalf("Czech catalog = %+v", cs)
	}
	assertCatalogBody(t, cs, map[string]any{
		// The catalog's translation wins over the deprecated label; the route label is folded in.
		"manifest.contribution.browse.sidebar.label": "Pravidla",
		"manifest.contribution.browse.route.label":   "Procházet",
	})

	sk := report.Locales[2]
	if sk.Path != "locales/sk.json" || sk.Messages != 0 || len(sk.Issues) != 1 ||
		!strings.Contains(sk.Issues[0], "not a message-catalog.v1 file") {
		t.Fatalf("rejected catalog = %+v", sk)
	}

	// Without catalogs, English comes from the manifest and Czech from the deprecated labels.
	delete(manifest, "locales")
	if body, err = json.Marshal(manifest); err != nil {
		t.Fatal(err)
	}
	packagePath = writePackage(t, map[string][]byte{
		manifestFilename: body,
		"web/index.js":   []byte("export function activate() {}"),
	})
	if report, err = newTestInspector(t).InspectFile(context.Background(), packagePath); err != nil {
		t.Fatal(err)
	}
	if len(report.Locales) != 2 || report.Locales[0].Messages != 4 || report.Locales[1].Path != "" ||
		report.Locales[1].Messages != 2 || len(report.Locales[1].Issues) != 0 {
		t.Fatalf("manifest-only catalogs = %+v", report.Locales)
	}
}

func TestManifestLocalesRequireEnglishAndCanonicalTags(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name    string
		locales map[string]any
		valid   bool
	}{
		{name: "English and Czech", locales: map[string]any{"en": "locales/en.json", "cs": "locales/cs.json"}, valid: true},
		{name: "region", locales: map[string]any{"en": "locales/en.json", "pt-BR": "locales/pt-BR.json"}, valid: true},
		{name: "no English", locales: map[string]any{"cs": "locales/cs.json"}},
		{name: "lowercase region", locales: map[string]any{"en": "locales/en.json", "pt-br": "locales/pt.json"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var manifest map[string]any
			if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
				t.Fatal(err)
			}
			manifest["locales"] = test.locales
			body, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			_, err = newTestInspector(t).parseManifest(body)
			if (err == nil) != test.valid {
				t.Fatalf("parseManifest error = %v, want valid %v", err, test.valid)
			}
		})
	}
}

func readCatalogFixture(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(catalogFixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func assertCatalogBody(t *testing.T, catalog LocaleCatalog, want map[string]any) {
	t.Helper()
	var decoded struct {
		ContractVersion string                    `json:"contractVersion"`
		Locale          string                    `json:"locale"`
		Sections        map[string]map[string]any `json:"sections"`
	}
	if err := json.Unmarshal(catalog.Body(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ContractVersion != CatalogContract || decoded.Locale != catalog.Locale {
		t.Fatalf("catalog header = %+v", decoded)
	}
	for key, value := range want {
		found := false
		for _, section := range decoded.Sections {
			if message, ok := section[key]; ok {
				found = true
				if !reflect.DeepEqual(message, value) {
					t.Fatalf("%s = %v, want %v", key, message, value)
				}
			}
		}
		if !found {
			t.Fatalf("%s missing from %s", key, catalog.Body())
		}
	}
}
