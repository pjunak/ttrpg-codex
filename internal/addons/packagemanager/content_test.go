package packagemanager

import (
	"errors"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
)

func TestContentRegistryRequiresExactActiveGeneration(t *testing.T) {
	t.Parallel()
	registry, err := contentcontract.Compile([]contentcontract.Declaration{{
		ID: "rules", Root: "content/rules", Schema: "contracts/record.json", Revision: "one",
	}}, []contentcontract.File{{
		Path: "content/rules/spell/a.json", Body: []byte(`{"kind":"spell","id":"a"}`),
	}}, contentTestSchemas(t))
	if err != nil {
		t.Fatal(err)
	}
	manager := &Manager{runtimes: map[string]activeRuntime{
		"compendium": {
			generation: Generation{AddonID: "compendium", GenerationID: "generation-a"},
			content:    registry,
		},
	}}
	actual, err := manager.ContentRegistry("compendium", "generation-a")
	if err != nil || actual != registry {
		t.Fatalf("registry = %p, %v", actual, err)
	}
	if _, err := manager.ContentRegistry("compendium", "generation-b"); !errors.Is(err, ErrNotActive) {
		t.Fatalf("stale generation error = %v", err)
	}
	if _, err := manager.ContentRegistry("missing", "generation-a"); !errors.Is(err, ErrNotActive) {
		t.Fatalf("missing add-on error = %v", err)
	}
}

func contentTestSchemas(t *testing.T) *datacontract.Registry {
	t.Helper()
	registry, err := datacontract.Compile([]datacontract.Declaration{{
		Kind: datacontract.Collection, ID: "rules", Keyed: true,
		Visibility: datacontract.VisibilityPublic,
		Schema:     "contracts/record.json", SchemaVersion: "one",
	}}, map[string][]byte{
		"contracts/record.json": []byte(`{
			"type":"object","required":["kind","id"],
			"properties":{"kind":{"type":"string"},"id":{"type":"string"}}
		}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	return registry
}
