package contentcontract

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
)

func TestCompileValidatesIndexesAndClonesImmutableContent(t *testing.T) {
	t.Parallel()
	registry, err := Compile([]Declaration{{
		ID: "rules", Root: "content/rules", Schema: "contracts/record.schema.json", Revision: "2026.09.1",
		Groups: &Groups{Field: "source.book", AdditionalField: "source.license", Label: "Sourcebook"},
	}}, []File{
		{Path: "content/rules/spells/shield.json", Body: raw(`{"kind":"spell","id":"shield","name":"Shield"}`)},
		{Path: "content/rules/classes/wizard.json", Body: raw(`{"kind":"class","id":"wizard","name":"Wizard"}`)},
		{Path: "content/other/ignored.json", Body: raw(`{"kind":"spell","id":"ignored","name":"Ignored"}`)},
	}, testSchemas(t))
	if err != nil {
		t.Fatal(err)
	}
	description, err := registry.Description("rules")
	if err != nil || description.RecordCount != 2 || description.Kinds["class"] != 1 ||
		description.Kinds["spell"] != 1 || len(description.SchemaSHA256) != 64 ||
		description.Groups == nil || description.Groups.Field != "source.book" {
		t.Fatalf("description = %+v, %v", description, err)
	}
	record, err := registry.Get("rules", "spell", "shield")
	if err != nil || string(record.Value) != `{"kind":"spell","id":"shield","name":"Shield"}` {
		t.Fatalf("record = %+v, %v", record, err)
	}
	record.Value[0] = '['
	again, err := registry.Get("rules", "spell", "shield")
	if err != nil || again.Value[0] != '{' {
		t.Fatal("returned content mutated the immutable registry")
	}
	description.Kinds["spell"] = 99
	description.Groups.Field = "mutated"
	againDescription, _ := registry.Description("rules")
	if againDescription.Kinds["spell"] != 1 || againDescription.Groups.Field != "source.book" {
		t.Fatal("returned description mutated the immutable registry")
	}
}

func TestQueryUsesStablePositionsAcrossKindFilters(t *testing.T) {
	t.Parallel()
	registry, err := Compile([]Declaration{{
		ID: "rules", Root: "content/rules", Schema: "contracts/record.schema.json", Revision: "1",
	}}, []File{
		{Path: "content/rules/c.json", Body: raw(`{"kind":"spell","id":"c","name":"C"}`)},
		{Path: "content/rules/a.json", Body: raw(`{"kind":"class","id":"a","name":"A"}`)},
		{Path: "content/rules/b.json", Body: raw(`{"kind":"spell","id":"b","name":"B"}`)},
	}, testSchemas(t))
	if err != nil {
		t.Fatal(err)
	}
	first, err := registry.Query(Query{SetID: "rules", Kind: "spell", AfterPosition: -1, Limit: 1})
	if err != nil || len(first.Records) != 1 || first.Records[0].ID != "b" || first.NextPosition == nil {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	second, err := registry.Query(Query{
		SetID: "rules", Kind: "spell", AfterPosition: *first.NextPosition, Limit: 1,
	})
	if err != nil || len(second.Records) != 1 || second.Records[0].ID != "c" || second.NextPosition != nil {
		t.Fatalf("second page = %+v, %v", second, err)
	}
}

func TestCompileRejectsInvalidSchemasIdentitiesAndDuplicates(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		files []File
	}{
		{"schema", []File{{Path: "content/rules/a.json", Body: raw(`{"kind":"spell","id":"a"}`)}}},
		{"identity", []File{{Path: "content/rules/a.json", Body: raw(`{"kind":"","id":"a","name":"A"}`)}}},
		{"duplicate", []File{
			{Path: "content/rules/a.json", Body: raw(`{"kind":"spell","id":"a","name":"A"}`)},
			{Path: "content/rules/b.json", Body: raw(`{"kind":"spell","id":"a","name":"Again"}`)},
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := Compile([]Declaration{{
				ID: "rules", Root: "content/rules", Schema: "contracts/record.schema.json", Revision: "1",
			}}, test.files, testSchemas(t))
			if !errors.Is(err, ErrInvalidRecord) {
				t.Fatalf("error = %v, want ErrInvalidRecord", err)
			}
		})
	}
}

func TestCompileAndQueryEnforcePayloadBounds(t *testing.T) {
	t.Parallel()
	oversized := make([]byte, MaximumRecordBytes+1)
	copy(oversized, `{"kind":"spell","id":"large","name":"`)
	for index := len(`{"kind":"spell","id":"large","name":"`); index < len(oversized)-2; index++ {
		oversized[index] = 'x'
	}
	copy(oversized[len(oversized)-2:], `"}`)
	_, err := Compile([]Declaration{{
		ID: "rules", Root: "content/rules", Schema: "contracts/record.schema.json", Revision: "1",
	}}, []File{{Path: "content/rules/large.json", Body: oversized}}, testSchemas(t))
	if !errors.Is(err, ErrInvalidRecord) {
		t.Fatalf("oversized record error = %v", err)
	}

	padding := make([]byte, MaximumQueryBytes/2-256)
	for index := range padding {
		padding[index] = 'x'
	}
	files := make([]File, 3)
	for index, id := range []string{"a", "b", "c"} {
		files[index] = File{
			Path: "content/rules/" + id + ".json",
			Body: raw(`{"kind":"spell","id":"` + id + `","name":"` + string(padding) + `"}`),
		}
	}
	registry, err := Compile([]Declaration{{
		ID: "rules", Root: "content/rules", Schema: "contracts/record.schema.json", Revision: "1",
	}}, files, testSchemas(t))
	if err != nil {
		t.Fatal(err)
	}
	first, err := registry.Query(Query{SetID: "rules", AfterPosition: -1, Limit: 3})
	if err != nil || len(first.Records) != 2 || first.NextPosition == nil || *first.NextPosition != 1 {
		t.Fatalf("bounded first page = records %d, next %v, error %v", len(first.Records), first.NextPosition, err)
	}
}

func TestRegistryRejectsUnknownAndInvalidQueries(t *testing.T) {
	t.Parallel()
	registry, err := Compile([]Declaration{{
		ID: "rules", Root: "content/rules", Schema: "contracts/record.schema.json", Revision: "1",
	}}, []File{{
		Path: "content/rules/a.json", Body: raw(`{"kind":"spell","id":"a","name":"A"}`),
	}}, testSchemas(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Get("rules", "spell", "missing"); !errors.Is(err, ErrRecordNotFound) {
		t.Fatalf("missing record error = %v", err)
	}
	if _, err := registry.Query(Query{SetID: "rules", AfterPosition: -1, Limit: 201}); !errors.Is(err, ErrInvalidQuery) {
		t.Fatalf("invalid query error = %v", err)
	}
}

func testSchemas(t *testing.T) *datacontract.Registry {
	t.Helper()
	registry, err := datacontract.Compile([]datacontract.Declaration{{
		Kind: datacontract.Collection, ID: "rules", Keyed: true,
		Visibility: datacontract.VisibilityPublic,
		Schema:     "contracts/record.schema.json", SchemaVersion: "1",
	}}, map[string][]byte{
		"contracts/record.schema.json": []byte(`{
			"$schema":"https://json-schema.org/draft/2020-12/schema",
			"type":"object","required":["kind","id","name"],
			"properties":{"kind":{"type":"string"},"id":{"type":"string"},"name":{"type":"string"}}
		}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func raw(value string) json.RawMessage { return json.RawMessage(value) }
