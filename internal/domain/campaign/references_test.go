package campaign

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var updateReferences = flag.Bool("update-references", false, "rewrite the browser copy of the reference table")

// The browser editors are tested against this file, so a field added on one
// side fails until the other side agrees.
func TestBrowserReferenceTableMatches(t *testing.T) {
	type collectionFields struct {
		References []ReferenceField `json:"references"`
		DMOnly     []string         `json:"dmOnly"`
	}
	table := make(map[Collection]collectionFields)
	for _, descriptor := range Descriptors() {
		references, dmOnly := ReferenceFields(descriptor.Name), DMOnlyFields(descriptor.Name)
		if len(references) == 0 && len(dmOnly) == 0 {
			continue
		}
		table[descriptor.Name] = collectionFields{References: references, DMOnly: dmOnly}
	}
	encoded, err := json.MarshalIndent(table, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	path := filepath.Join("..", "..", "..", "frontend", "test", "fixtures", "campaign-references.json")
	if *updateReferences {
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.ReplaceAll(current, []byte("\r\n"), []byte("\n")), encoded) {
		t.Fatalf("%s is stale; run go test ./internal/domain/campaign -update-references", path)
	}
}

func TestReferenceFieldsAreWellFormed(t *testing.T) {
	for collection, references := range referenceFields {
		for _, reference := range references {
			if _, ok := Describe(reference.Target); !ok || reference.Field == "" ||
				(reference.Kind == ReferenceObjects) != (reference.IDField != "") ||
				reference.Kind != ReferenceOne && (len(reference.Placement) > 0 || len(reference.Reserved) > 0 ||
					reference.Deleted != "" || len(reference.Clears) > 0) {
				t.Errorf("%s.%s is malformed: %+v", collection, reference.Field, reference)
			}
		}
	}
}
