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
