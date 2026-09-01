package workerrpc

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

const serviceTestGeneration = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestServiceClientUsesVersionedBoundServiceContract(t *testing.T) {
	t.Parallel()
	meta := &Meta{Generation: "generation", RequestID: "request", CorrelationID: "correlation"}
	var called addonDataCall
	caller := addonDataCallerFunc(func(
		_ context.Context,
		method string,
		params any,
		actualMeta *Meta,
	) (json.RawMessage, error) {
		body, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		called = addonDataCall{method: method, body: body, meta: actualMeta}
		return json.RawMessage(`{
			"contractVersion":"host-service-result.v1","contract":"dnd5e.rules-data",
			"providerAddonId":"dnd-2024-compendium","providerContractVersion":"3.0.0",
			"providerGeneration":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"result":{"items":[{"id":"spell-1"}]}
		}`), nil
	})
	client, err := NewServiceClient(caller)
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Call(context.Background(), meta, ServiceCall{
		Contract: "dnd5e.rules-data", ProviderAddonID: "dnd-2024-compendium",
		Method: "query", Params: map[string]any{"kind": "spell"}, IdempotencyKey: "lookup-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ProviderAddonID != "dnd-2024-compendium" ||
		result.ProviderContractVersion != "3.0.0" || result.ProviderGeneration != serviceTestGeneration {
		t.Fatalf("service result = %+v", result)
	}
	decoded, err := DecodeServiceResult[struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}](result)
	if err != nil || len(decoded.Items) != 1 || decoded.Items[0].ID != "spell-1" {
		t.Fatalf("decoded result = %+v, %v", decoded, err)
	}
	if called.method != "host/service.call" || called.meta != meta {
		t.Fatalf("service RPC call = %+v", called)
	}
	assertAddonDataJSON(t, called.body, `{
		"contractVersion":"host-service-call.v1","contract":"dnd5e.rules-data",
		"providerAddonId":"dnd-2024-compendium","method":"query",
		"params":{"kind":"spell"},"idempotencyKey":"lookup-1"
	}`)
}

func TestServiceClientRejectsInvalidLocalAndRemoteBoundaries(t *testing.T) {
	t.Parallel()
	calls := 0
	client, err := NewServiceClient(addonDataCallerFunc(func(
		context.Context, string, any, *Meta,
	) (json.RawMessage, error) {
		calls++
		return json.RawMessage(`{
			"contractVersion":"host-service-result.v1","contract":"dnd5e.rules-data",
			"providerAddonId":"different-provider","providerContractVersion":"3.0.0",
			"providerGeneration":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"result":{},"unexpected":true
		}`), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Call(context.Background(), nil, ServiceCall{
		Contract: "dnd5e.rules-data", Method: "query", Params: "not-an-object",
	})
	if err == nil || calls != 0 {
		t.Fatalf("invalid local call error = %v, calls %d", err, calls)
	}
	_, err = client.Call(context.Background(), nil, ServiceCall{
		Contract: "dnd5e.rules-data", ProviderAddonID: "dnd-2024-compendium",
		Method: "query", Params: map[string]any{},
	})
	if err == nil || calls != 1 {
		t.Fatalf("invalid remote result error = %v, calls %d", err, calls)
	}
}

func TestServiceClientPreservesRPCFailures(t *testing.T) {
	t.Parallel()
	want := NewRPCError(JSONRPCApplication, KindUnavailable, "provider unavailable", true, nil)
	client, err := NewServiceClient(addonDataCallerFunc(func(
		context.Context, string, any, *Meta,
	) (json.RawMessage, error) {
		return nil, want
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Call(context.Background(), nil, ServiceCall{
		Contract: "dnd5e.rules-data", Method: "query", Params: map[string]any{},
	})
	if !errors.Is(err, want) {
		t.Fatalf("error = %v", err)
	}
}
