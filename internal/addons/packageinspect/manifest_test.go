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
