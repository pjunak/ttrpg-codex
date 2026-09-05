package legacyconvert

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestConvertSidebarSettingsPreservesEffectiveV1Navigation(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name, settings         string
		hidden                 []string
		created, settingsCount int
	}{
		{name: "no settings file", created: 1, settingsCount: 1},
		{name: "default layout", settings: `{}`, created: 1, settingsCount: 1},
		{name: "null layout", settings: `{"sidebarLayout":null,"hiddenSidebarPages":["/mapa/svet"]}`, hidden: []string{"/mapa/svet"}, created: 1, settingsCount: 2},
		{name: "retired hide list", settings: `{"hiddenSidebarPages":["/mapa/svet","/postavy","/mapa/svet","/retired"],"extension":{"kept":true}}`, hidden: []string{"/mapa/svet", "/postavy"}, created: 1, settingsCount: 3},
		{name: "saved layout wins", settings: `{"sidebarLayout":{"sections":[{"id":"custom","label":"My world","pages":["/mista"],"extension":true}],"hidden":["/postavy"],"extra":42},"hiddenSidebarPages":"ignored by v1"}`, settingsCount: 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			archive, output := filepath.Join(directory, "v1.zip"), filepath.Join(directory, "converted")
			entries := []zipEntry{{name: "data/locations.json", body: `[]`}}
			if test.settings != "" {
				entries = append(entries, zipEntry{name: "data/settings.json", body: test.settings})
			}
			writeLegacyZip(t, archive, entries)
			original, err := os.ReadFile(archive)
			if err != nil {
				t.Fatal(err)
			}
			report, err := Convert(context.Background(), Config{ArchivePath: archive, OutputDirectory: output})
			if err != nil {
				t.Fatal(err)
			}
			after, err := os.ReadFile(archive)
			if err != nil || !reflect.DeepEqual(original, after) {
				t.Fatalf("source changed: %v", err)
			}
			if report.Legacy.SidebarLayouts != test.created || report.CoreCollections["settings"] != test.settingsCount || report.CoreRecords != test.settingsCount {
				t.Fatalf("unexpected conversion counts: %+v", report)
			}
			database, err := sql.Open("sqlite", filepath.Join(output, "codex.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			var originalSettings map[string]json.RawMessage
			if test.settings != "" {
				if err := json.Unmarshal([]byte(test.settings), &originalSettings); err != nil {
					t.Fatal(err)
				}
			}
			for key, want := range originalSettings {
				if key == "sidebarLayout" && test.created == 1 {
					continue
				}
				var got string
				if err := database.QueryRow(`SELECT body_json FROM campaign_records WHERE collection_name = 'settings' AND record_key = ?`, key).Scan(&got); err != nil {
					t.Fatal(err)
				}
				var left, right any
				if json.Unmarshal(want, &left) != nil || json.Unmarshal([]byte(got), &right) != nil || !reflect.DeepEqual(left, right) {
					t.Fatalf("setting %s changed: %s", key, got)
				}
			}
			if test.created == 0 {
				return
			}
			var body string
			if err := database.QueryRow(`SELECT body_json FROM campaign_records WHERE collection_name = 'settings' AND record_key = 'sidebarLayout'`).Scan(&body); err != nil {
				t.Fatal(err)
			}
			var layout struct {
				Sections []legacySidebarSection
				Hidden   []string
			}
			if err := json.Unmarshal([]byte(body), &layout); err != nil {
				t.Fatal(err)
			}
			if len(layout.Sections) != 5 || layout.Sections[0].ID != "prehled" || layout.Sections[3].ID != "kompendium" || !layout.Sections[3].Collapsible || layout.Sections[3].DefaultOpen || layout.Sections[4].Role != "dm" {
				t.Fatalf("v1 groups were not preserved: %s", body)
			}
			if !reflect.DeepEqual(append([]string{}, layout.Hidden...), append([]string{}, test.hidden...)) {
				t.Fatalf("hidden routes: %v", layout.Hidden)
			}
			seen := map[string]bool{}
			for _, section := range layout.Sections {
				for _, route := range section.Pages {
					if seen[route] {
						t.Fatalf("duplicate route %s", route)
					}
					seen[route] = true
				}
			}
			for _, route := range layout.Hidden {
				if seen[route] {
					t.Fatalf("hidden route still visible: %s", route)
				}
				seen[route] = true
			}
			if len(seen) != 13 {
				t.Fatalf("lost routes: %v", seen)
			}
		})
	}
}

func TestConvertRejectsMalformedRetiredSidebarSettingsBeforePublication(t *testing.T) {
	t.Parallel()
	for _, hidden := range []string{`"/mista"`, `{}`, `[null]`, `[3]`, `["/mista",{}]`} {
		t.Run(hidden, func(t *testing.T) {
			directory := t.TempDir()
			archive, output := filepath.Join(directory, "v1.zip"), filepath.Join(directory, "converted")
			writeLegacyZip(t, archive, []zipEntry{{name: "data/settings.json", body: `{"hiddenSidebarPages":` + hidden + `}`}})
			_, err := Convert(context.Background(), Config{ArchivePath: archive, OutputDirectory: output})
			if !errors.Is(err, ErrInvalidLegacyBackup) {
				t.Fatalf("unexpected error: %v", err)
			}
			if _, err := os.Stat(output); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("output was published: %v", err)
			}
		})
	}
}
