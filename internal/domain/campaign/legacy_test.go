package campaign

import (
	"encoding/json"
	"testing"
)

func TestLegacyDatasetRoundTripsKnownCollectionsAndPreservesUnknownData(t *testing.T) {
	t.Parallel()

	source := []byte(`{
		"characters": [
			{"id":"alice","name":"Alice","visibility":"public"},
			{"id":"secret","name":"Secret","visibility":"dm"}
		],
		"settings": {"appearance":{"theme":"classic"}},
		"relationships": [
			{"source":"alice","target":"secret","type":"ally"}
		],
		"addon:dm-tools:notes": [{"id":"note-1","body":"untouched"}]
	}`)
	dataset, err := DecodeLegacyDataset(source)
	if err != nil {
		t.Fatal(err)
	}
	if len(dataset.Present) != 3 || len(dataset.Records) != 4 {
		t.Fatalf("unexpected decoded dataset: %+v", dataset)
	}
	if _, ok := dataset.Passthrough["addon:dm-tools:notes"]; !ok {
		t.Fatal("unknown add-on collection was not retained")
	}
	characterPositions := make(map[string]int64)
	for _, record := range dataset.Records {
		if record.Collection == Characters {
			characterPositions[record.Key] = record.Position
		}
	}
	if characterPositions["alice"] != 0 || characterPositions["secret"] != 1 {
		t.Fatalf("list order was not retained: %+v", dataset.Records)
	}

	encoded, err := EncodeLegacyDataset(dataset)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	var characters []map[string]any
	if err := json.Unmarshal(roundTrip["characters"], &characters); err != nil {
		t.Fatal(err)
	}
	if len(characters) != 2 || characters[0]["id"] != "alice" || characters[1]["id"] != "secret" {
		t.Fatalf("character order changed: %#v", characters)
	}
	if string(roundTrip["addon:dm-tools:notes"]) != string(dataset.Passthrough["addon:dm-tools:notes"]) {
		t.Fatal("unknown collection changed")
	}
}

func TestLegacyDatasetPromotesDeletedDefaultArrays(t *testing.T) {
	t.Parallel()

	dataset, err := DecodeLegacyDataset([]byte(`{"deletedDefaults":["alice","settings:genders:elf","alice"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(dataset.Records) != 2 || dataset.Records[0].Key != "alice" ||
		string(dataset.Records[0].Value) != "true" {
		t.Fatalf("unexpected promoted tombstones: %+v", dataset.Records)
	}
	encoded, err := EncodeLegacyDataset(dataset)
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]map[string]bool
	if err := json.Unmarshal(encoded, &root); err != nil {
		t.Fatal(err)
	}
	if !root["deletedDefaults"]["alice"] || !root["deletedDefaults"]["settings:genders:elf"] {
		t.Fatalf("unexpected encoded tombstones: %#v", root)
	}
}

func TestLegacyDatasetDistinguishesAbsentAndMaterializedEmptyCollections(t *testing.T) {
	t.Parallel()

	dataset, err := DecodeLegacyDataset([]byte(`{"characters":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(dataset.Present) != 1 || dataset.Present[0] != Characters || len(dataset.Records) != 0 {
		t.Fatalf("materialized empty collection was lost: %+v", dataset)
	}
	encoded, err := EncodeLegacyDataset(dataset)
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &root); err != nil {
		t.Fatal(err)
	}
	if string(root["characters"]) != "[]" {
		t.Fatalf("characters = %s", root["characters"])
	}
	if _, exists := root["relationships"]; exists {
		t.Fatal("absent collection was synthesized")
	}
}
