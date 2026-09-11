package contentcontract

import (
	"errors"
	"testing"
)

func TestSourceSelectionRetainsAlternateMembershipWithoutMutatingArchive(t *testing.T) {
	registry, err := Compile([]Declaration{{ID: "rules", Root: "content/rules", Schema: "contracts/record.schema.json", Revision: "1", Groups: &Groups{Field: "source.book", AdditionalField: "source.availableIn", Label: "Books"}}}, []File{
		{Path: "content/rules/a.json", Body: raw(`{"kind":"spell","id":"reprint","name":"Reprint","source":{"book":"a","availableIn":["b"]}}`)},
		{Path: "content/rules/b.json", Body: raw(`{"kind":"spell","id":"exclusive","name":"Exclusive","source":{"book":"a"}}`)},
		{Path: "content/rules/c.json", Body: raw(`{"kind":"book","id":"b","name":"Second book"}`)},
		{Path: "content/rules/d.json", Body: raw(`{"kind":"metadata","id":"meta","name":"Metadata"}`)},
	}, testSchemas(t))
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := registry.SourceCatalog("rules", "book")
	if err != nil || catalog["b"] != "Second book" || catalog["a"] != "a" {
		t.Fatalf("source catalog = %v, %v", catalog, err)
	}
	selected := registry.SelectSources(map[string]SourceSelection{"rules": {Revision: "selected-b", CatalogKind: "book", Enabled: map[string]bool{"b": true}}})
	if _, err := selected.Get("rules", "spell", "reprint"); err != nil {
		t.Fatal(err)
	}
	if _, err := selected.Get("rules", "spell", "exclusive"); !errors.Is(err, ErrRecordNotFound) {
		t.Fatal("disabled source remained eligible", err)
	}
	if _, err := registry.Get("rules", "spell", "exclusive"); err != nil {
		t.Fatal("source policy mutated archive", err)
	}
	description, _ := selected.Description("rules")
	if description.RecordCount != 3 || description.Revision != "selected-b" {
		t.Fatalf("effective catalog = %+v", description)
	}
	returned, _ := selected.Get("rules", "spell", "reprint")
	returned.Value[0] = '['
	original, _ := registry.Get("rules", "spell", "reprint")
	if original.Value[0] != '{' {
		t.Fatal("effective record mutated archive")
	}
}

func TestCursorBindsEffectiveRevisionSetAndKind(t *testing.T) {
	value := EncodeCursor(42, "rules", "allowed-a", "spell")
	if len(value) > 32 {
		t.Fatal("cursor exceeds public bound")
	}
	position, err := DecodeCursor(value, "rules", "allowed-a", "spell")
	if err != nil || position != 42 {
		t.Fatalf("cursor = %d,%v", position, err)
	}
	for _, test := range [][3]string{{"rules", "allowed-b", "spell"}, {"other", "allowed-a", "spell"}, {"rules", "allowed-a", "class"}} {
		if _, err := DecodeCursor(value, test[0], test[1], test[2]); !errors.Is(err, ErrInvalidQuery) {
			t.Fatal("cursor crossed effective snapshot", err)
		}
	}
	if _, err := DecodeCursor("NDI", "rules", "allowed-a", "spell"); err == nil {
		t.Fatal("unscoped cursor accepted")
	}
}
