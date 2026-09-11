package contenttransport

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
)

func TestCallerServesCatalogRecordsAndBoundedQueries(t *testing.T) {
	t.Parallel()
	caller := testCaller(t)

	catalog, err := caller.Call(context.Background(), "service/dnd5e.rules-data/catalog", json.RawMessage(`{}`), nil)
	if err != nil || !strings.Contains(string(catalog), `"contractVersion":"content-catalog.v1"`) ||
		!strings.Contains(string(catalog), `"recordCount":3`) {
		t.Fatalf("catalog = %s, %v", catalog, err)
	}
	record, err := caller.Call(context.Background(), "service/dnd5e.rules-data/get", json.RawMessage(
		`{"setId":"rules","kind":"spell","id":"shield"}`,
	), nil)
	if err != nil || !strings.Contains(string(record), `"name":"Shield"`) {
		t.Fatalf("record = %s, %v", record, err)
	}
	first, err := caller.Call(context.Background(), "service/dnd5e.rules-data/query", json.RawMessage(
		`{"setId":"rules","kind":"spell","limit":1}`,
	), nil)
	if err != nil || !strings.Contains(string(first), `"id":"magic-missile"`) ||
		!strings.Contains(string(first), `"nextCursor":`) {
		t.Fatalf("first page = %s, %v", first, err)
	}
	var page struct {
		NextCursor string `json:"nextCursor"`
	}
	if err := json.Unmarshal(first, &page); err != nil {
		t.Fatal(err)
	}
	query, _ := json.Marshal(map[string]any{"setId": "rules", "kind": "spell", "limit": 1, "cursor": page.NextCursor})
	second, err := caller.Call(context.Background(), "service/dnd5e.rules-data/query", json.RawMessage(
		query,
	), nil)
	if err != nil || !strings.Contains(string(second), `"id":"shield"`) ||
		strings.Contains(string(second), "nextCursor") {
		t.Fatalf("second page = %s, %v", second, err)
	}
}

func TestCallerRejectsUnsupportedMalformedAndCancelledCalls(t *testing.T) {
	t.Parallel()
	caller := testCaller(t)
	if _, err := caller.Call(context.Background(), "service/rules/search", json.RawMessage(`{}`), nil); !errors.Is(err, ErrUnsupportedMethod) {
		t.Fatalf("unsupported method error = %v", err)
	}
	if _, err := caller.Call(context.Background(), "service/rules/get", json.RawMessage(
		`{"setId":"rules","kind":"spell","id":"shield","extra":true}`,
	), nil); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("malformed request error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := caller.Call(ctx, "service/rules/catalog", json.RawMessage(`{}`), nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled call error = %v", err)
	}
}

func testCaller(t *testing.T) *Caller {
	t.Helper()
	schemas, err := datacontract.Compile([]datacontract.Declaration{{
		Kind: datacontract.Collection, ID: "rules", Keyed: true,
		Visibility: datacontract.VisibilityPublic,
		Schema:     "contracts/rule.json", SchemaVersion: "fixture-1",
	}}, map[string][]byte{"contracts/rule.json": []byte(`{
		"type":"object","required":["kind","id","name"],
		"properties":{"kind":{"type":"string"},"id":{"type":"string"},"name":{"type":"string"}}
	}`)})
	if err != nil {
		t.Fatal(err)
	}
	registry, err := contentcontract.Compile([]contentcontract.Declaration{{
		ID: "rules", Root: "content/rules", Schema: "contracts/rule.json", Revision: "fixture-1",
	}}, []contentcontract.File{
		{Path: "content/rules/class/wizard.json", Body: []byte(`{"kind":"class","id":"wizard","name":"Wizard"}`)},
		{Path: "content/rules/spell/magic-missile.json", Body: []byte(`{"kind":"spell","id":"magic-missile","name":"Magic Missile"}`)},
		{Path: "content/rules/spell/shield.json", Body: []byte(`{"kind":"spell","id":"shield","name":"Shield"}`)},
	}, schemas)
	if err != nil {
		t.Fatal(err)
	}
	caller, err := New(registry)
	if err != nil {
		t.Fatal(err)
	}
	return caller
}
