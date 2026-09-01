package campaign

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestNormalizeRecordPreservesLegacyIdentityAndVisibility(t *testing.T) {
	t.Parallel()

	character := json.RawMessage(`{
		"id": "Frulam old id",
		"name": "Frulam",
		"visibility": "dm",
		"addonData": {"example-addon": {"note": "preserved"}}
	}`)
	descriptor, _ := Describe(Characters)
	normalized, visibility, err := NormalizeRecord(descriptor, "Frulam old id", character)
	if err != nil {
		t.Fatal(err)
	}
	if visibility != VisibilityDM {
		t.Fatalf("visibility = %q", visibility)
	}
	var value map[string]any
	if err := json.Unmarshal(normalized, &value); err != nil {
		t.Fatal(err)
	}
	if value["id"] != "Frulam old id" || value["name"] != "Frulam" || value["addonData"] == nil {
		t.Fatalf("record fields were not preserved: %#v", value)
	}
}

func TestRelationshipIdentityIsCollisionFree(t *testing.T) {
	t.Parallel()

	first, err := ListRecordKey(Relationships, json.RawMessage(
		`{"source":"a||b","target":"c","type":"ally"}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	second, err := ListRecordKey(Relationships, json.RawMessage(
		`{"source":"a","target":"b||c","type":"ally"}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("relationship keys collide: %q", first)
	}
}

func TestNormalizeRecordRejectsInvalidShapesAndIdentityChanges(t *testing.T) {
	t.Parallel()

	list, _ := Describe(Characters)
	keyed, _ := Describe(Settings)
	tests := []struct {
		name       string
		descriptor Descriptor
		key        string
		value      json.RawMessage
	}{
		{name: "list scalar", descriptor: list, key: "a", value: json.RawMessage(`true`)},
		{name: "mismatched id", descriptor: list, key: "a", value: json.RawMessage(`{"id":"b"}`)},
		{name: "invalid visibility", descriptor: list, key: "a", value: json.RawMessage(`{"id":"a","visibility":"secret"}`)},
		{name: "prototype key", descriptor: keyed, key: "__proto__", value: json.RawMessage(`[]`)},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, _, err := NormalizeRecord(test.descriptor, test.key, test.value); !errors.Is(err, ErrInvalidRecord) {
				t.Fatalf("error = %v, want ErrInvalidRecord", err)
			}
		})
	}
}
