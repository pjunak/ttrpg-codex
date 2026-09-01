package packageinspect

import (
	"encoding/json"
	"testing"
)

func TestManifestRetainsCompleteServiceConsumerPolicy(t *testing.T) {
	t.Parallel()

	var manifest Manifest
	if err := json.Unmarshal([]byte(`{
		"services": {
			"consumes": [{
				"contract": "dnd5e.rules-engine",
				"range": "^3.0.0",
				"cardinality": "one",
				"required": true,
				"selection": "operator"
			}]
		}
	}`), &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Services.Consumes) != 1 {
		t.Fatalf("consumer count = %d, want 1", len(manifest.Services.Consumes))
	}
	consumer := manifest.Services.Consumes[0]
	if consumer.Contract != "dnd5e.rules-engine" || consumer.Range != "^3.0.0" ||
		consumer.Cardinality != "one" || !consumer.Required || consumer.Selection != "operator" {
		t.Fatalf("incomplete service consumer policy: %+v", consumer)
	}
}

func TestManifestRetainsCapabilities(t *testing.T) {
	t.Parallel()

	var manifest Manifest
	if err := json.Unmarshal([]byte(`{
		"capabilities": {
			"required": ["worker.native", "services.broker"],
			"optional": ["worker.health-details"]
		}
	}`), &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Capabilities.Required) != 2 || manifest.Capabilities.Optional[0] != "worker.health-details" {
		t.Fatalf("incomplete capability policy: %+v", manifest.Capabilities)
	}
}

func TestManifestRetainsCompleteContributionPolicy(t *testing.T) {
	t.Parallel()

	var manifest Manifest
	if err := json.Unmarshal([]byte(`{
		"contributions": [{
			"id": "planner.route",
			"surface": "route",
			"label": "Story Planner",
			"roles": ["dm"],
			"order": 200,
			"requires": ["ui.contributions"],
			"config": {"path": "planner"}
		}]
	}`), &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Contributions) != 1 {
		t.Fatalf("contribution count = %d, want 1", len(manifest.Contributions))
	}
	contribution := manifest.Contributions[0]
	if contribution.ID != "planner.route" || contribution.Surface != "route" ||
		contribution.Label != "Story Planner" || len(contribution.Roles) != 1 ||
		contribution.Roles[0] != "dm" || contribution.Order != 200 ||
		len(contribution.Requires) != 1 || contribution.Requires[0] != "ui.contributions" ||
		contribution.Config["path"] != "planner" {
		t.Fatalf("incomplete contribution policy: %+v", contribution)
	}
}

func TestManifestRetainsCompleteDataPolicy(t *testing.T) {
	t.Parallel()

	var manifest Manifest
	if err := json.Unmarshal([]byte(`{
		"collections": [{
			"id": "planning_items",
			"keyed": true,
			"visibility": "dm",
			"schema": "contracts/planning-item.schema.json",
			"schemaVersion": "2.1.0",
			"indexes": [{"path": "/parentId", "unique": true}]
		}],
		"recordExtensions": [{
			"id": "sheet",
			"target": "characters",
			"visibility": "private",
			"schema": "contracts/sheet.schema.json",
			"schemaVersion": "3.0.0"
		}]
	}`), &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Collections) != 1 || len(manifest.RecordExtensions) != 1 {
		t.Fatalf("data declarations = %+v, %+v", manifest.Collections, manifest.RecordExtensions)
	}
	collection := manifest.Collections[0]
	if collection.ID != "planning_items" || !collection.Keyed || collection.Visibility != "dm" ||
		collection.Schema != "contracts/planning-item.schema.json" || collection.SchemaVersion != "2.1.0" ||
		len(collection.Indexes) != 1 || collection.Indexes[0].Path != "/parentId" || !collection.Indexes[0].Unique {
		t.Fatalf("incomplete collection policy: %+v", collection)
	}
	extension := manifest.RecordExtensions[0]
	if extension.ID != "sheet" || extension.Target != "characters" || extension.Visibility != "private" ||
		extension.Schema != "contracts/sheet.schema.json" || extension.SchemaVersion != "3.0.0" {
		t.Fatalf("incomplete extension policy: %+v", extension)
	}
}

func TestManifestSchemaRequiresCanonicalNavigationMetadata(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		contribution map[string]any
		valid        bool
	}{
		{
			name: "route",
			contribution: map[string]any{
				"id": "planner.route", "surface": "route", "label": "Planner",
				"config": map[string]any{"path": "planning/story"},
			},
			valid: true,
		},
		{
			name: "sidebar",
			contribution: map[string]any{
				"id": "planner.sidebar", "surface": "sidebar", "label": "Planner",
				"config": map[string]any{"route": "planner.route"},
			},
			valid: true,
		},
		{
			name: "route traversal",
			contribution: map[string]any{
				"id": "planner.route", "surface": "route", "label": "Planner",
				"config": map[string]any{"path": "../planner"},
			},
		},
		{
			name: "sidebar arbitrary link",
			contribution: map[string]any{
				"id": "planner.sidebar", "surface": "sidebar", "label": "Planner",
				"config": map[string]any{"route": "planner.route", "href": "https://invalid.example"},
			},
		},
	}

	inspector := newTestInspector(t)
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			var manifest map[string]any
			if err := json.Unmarshal(minimalManifest("example-addon"), &manifest); err != nil {
				t.Fatal(err)
			}
			manifest["contributions"] = []any{test.contribution}
			body, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			_, err = inspector.parseManifest(body)
			if test.valid && err != nil {
				t.Fatalf("valid navigation metadata rejected: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("invalid navigation metadata accepted")
			}
		})
	}
}
