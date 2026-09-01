package datacontract

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestRegistryCompilesReferencesAndValidatesDocuments(t *testing.T) {
	t.Parallel()
	registry, err := Compile([]Declaration{{
		Kind: Collection, ID: "notes", Keyed: true, Visibility: VisibilityDM,
		Schema: "contracts/notes.schema.json", SchemaVersion: "1.0.0",
		Indexes: []Index{{Path: "/title", Unique: true}},
	}}, map[string][]byte{
		"contracts/notes.schema.json": []byte(`{"$ref":"common.schema.json#/$defs/note"}`),
		"contracts/common.schema.json": []byte(`{
			"$defs":{"note":{"type":"object","additionalProperties":false,"required":["title"],"properties":{"title":{"type":"string","minLength":1}}}}
		}`),
		"contracts/unrelated.schema.json": []byte(`{"type":"integer"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	description, err := registry.Description(Collection, "notes")
	if err != nil {
		t.Fatal(err)
	}
	if !description.Keyed || description.Visibility != VisibilityDM ||
		len(description.SchemaSHA256) != 64 || len(description.Indexes) != 1 || !description.Indexes[0].Unique {
		t.Fatalf("description = %+v", description)
	}
	if err := registry.Validate(Collection, "notes", json.RawMessage(`{"title":"Remember"}`)); err != nil {
		t.Fatalf("valid document rejected: %v", err)
	}
	if err := registry.Validate(Collection, "notes", json.RawMessage(`{"title":"","extra":true}`)); !errors.Is(err, ErrInvalidDocument) {
		t.Fatalf("invalid document error = %v", err)
	}
	if err := registry.Validate(Collection, "missing", json.RawMessage(`{}`)); !errors.Is(err, ErrDefinitionNotFound) {
		t.Fatalf("missing definition error = %v", err)
	}

	description.Indexes[0].Path = "/mutated"
	again, _ := registry.Description(Collection, "notes")
	if again.Indexes[0].Path != "/title" {
		t.Fatalf("description mutation escaped registry: %+v", again)
	}
}

func TestSchemaDigestCoversOnlyReferencedClosure(t *testing.T) {
	t.Parallel()
	declaration := []Declaration{{
		Kind: Collection, ID: "notes", Visibility: VisibilityPublic,
		Schema: "contracts/notes.schema.json", SchemaVersion: "1.0.0",
	}}
	resources := map[string][]byte{
		"contracts/notes.schema.json":     []byte(`{"$ref":"common.schema.json"}`),
		"contracts/common.schema.json":    []byte(`{"type":"string"}`),
		"contracts/unrelated.schema.json": []byte(`{"type":"boolean"}`),
	}
	registry, err := Compile(declaration, resources)
	if err != nil {
		t.Fatal(err)
	}
	baseline, _ := registry.Description(Collection, "notes")

	resources["contracts/unrelated.schema.json"] = []byte(`{"type":"number"}`)
	registry, err = Compile(declaration, resources)
	if err != nil {
		t.Fatal(err)
	}
	unrelated, _ := registry.Description(Collection, "notes")
	if unrelated.SchemaSHA256 != baseline.SchemaSHA256 {
		t.Fatal("unreferenced schema changed the effective digest")
	}

	resources["contracts/common.schema.json"] = []byte(`{"type":"integer"}`)
	registry, err = Compile(declaration, resources)
	if err != nil {
		t.Fatal(err)
	}
	referenced, _ := registry.Description(Collection, "notes")
	if referenced.SchemaSHA256 == baseline.SchemaSHA256 {
		t.Fatal("referenced schema did not change the effective digest")
	}
}

func TestRegistryRejectsMalformedDeclarationsAndTrailingJSON(t *testing.T) {
	t.Parallel()
	resources := map[string][]byte{"contracts/value.schema.json": []byte(`{"type":"object"}`)}
	if _, err := Compile([]Declaration{{
		Kind: RecordExtension, ID: "sheet", Visibility: VisibilityPublic,
		Schema: "contracts/value.schema.json", SchemaVersion: "1.0.0",
	}}, resources); !errors.Is(err, ErrInvalidDeclaration) {
		t.Fatalf("targetless extension error = %v", err)
	}
	registry, err := Compile([]Declaration{{
		Kind: Collection, ID: "notes", Visibility: VisibilityPublic,
		Schema: "contracts/value.schema.json", SchemaVersion: "1.0.0",
	}}, resources)
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Validate(Collection, "notes", json.RawMessage(`{} trailing`)); !errors.Is(err, ErrInvalidDocument) {
		t.Fatalf("trailing JSON error = %v", err)
	}
}
