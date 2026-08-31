package requestcontext

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestRegistryResolvesHostAuthorityAndIgnoresWireActor(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 31, 10, 0, 0, 0, time.UTC)
	registry := testRegistry(t, &now, 4)
	lease, err := registry.Issue(IssueRequest{
		AddonID:        "rules-engine",
		Generation:     "generation-7",
		CorrelationID:  "browser-request-9",
		Deadline:       now.Add(time.Minute),
		Actor:          workerrpc.Actor{Role: "player", ID: "player-3"},
		IdempotencyKey: "mutation-2",
		Traceparent:    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { lease.Close() })

	meta := lease.Meta()
	meta.Actor = &workerrpc.Actor{Role: "dm", ID: "forged"}
	authority, err := registry.ResolveContext(context.Background(), ResolveRequest{
		AddonID:    "rules-engine",
		Generation: "generation-7",
		Method:     "host/data.read",
		WireMeta:   meta,
	})
	if err != nil {
		t.Fatal(err)
	}
	if authority.Actor.Role != "player" || authority.Actor.ID != "player-3" {
		t.Fatalf("resolved forged actor instead of host authority: %+v", authority.Actor)
	}
	if authority.RequestID != meta.RequestID || authority.CorrelationID != "browser-request-9" {
		t.Fatalf("unexpected authority: %+v", authority)
	}
	if snapshot := registry.Snapshot(); snapshot.Active != 1 || snapshot.Issued != 1 || snapshot.Resolved != 1 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
}

func TestRegistryRejectsTamperingExpiryAndUnknownLineage(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 31, 10, 0, 0, 0, time.UTC)
	registry := testRegistry(t, &now, 4)
	lease, err := registry.Issue(IssueRequest{
		AddonID:    "rules-engine",
		Generation: "generation-7",
		Deadline:   now.Add(time.Minute),
		Actor:      workerrpc.Actor{Role: "system"},
	})
	if err != nil {
		t.Fatal(err)
	}

	tampered := lease.Meta()
	tampered.CorrelationID = "different"
	if _, err := registry.ResolveContext(context.Background(), ResolveRequest{
		AddonID: "rules-engine", Generation: "generation-7", WireMeta: tampered,
	}); !errors.Is(err, ErrInvalidContext) {
		t.Fatalf("tampered context error = %v, want ErrInvalidContext", err)
	}

	unknown := lease.Meta()
	unknown.RequestID = "never-issued"
	if _, err := registry.ResolveContext(context.Background(), ResolveRequest{
		AddonID: "rules-engine", Generation: "generation-7", WireMeta: unknown,
	}); !errors.Is(err, ErrUnknownContext) {
		t.Fatalf("unknown context error = %v, want ErrUnknownContext", err)
	}

	now = now.Add(2 * time.Minute)
	if _, err := registry.ResolveContext(context.Background(), ResolveRequest{
		AddonID: "rules-engine", Generation: "generation-7", WireMeta: lease.Meta(),
	}); !errors.Is(err, ErrExpiredContext) {
		t.Fatalf("expired context error = %v, want ErrExpiredContext", err)
	}
	if snapshot := registry.Snapshot(); snapshot.Active != 0 || snapshot.Rejected != 3 || snapshot.Expired != 1 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
}

func TestRegistryCapacityLeaseCloseAndGenerationInvalidation(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 31, 10, 0, 0, 0, time.UTC)
	registry := testRegistry(t, &now, 2)
	first := issueTestLease(t, registry, "generation-1", now.Add(time.Minute))
	second := issueTestLease(t, registry, "generation-2", now.Add(time.Minute))
	if _, err := registry.Issue(IssueRequest{
		AddonID: "rules-engine", Generation: "generation-3", Deadline: now.Add(time.Minute), Actor: workerrpc.Actor{Role: "system"},
	}); !errors.Is(err, ErrCapacity) {
		t.Fatalf("capacity error = %v, want ErrCapacity", err)
	}
	if removed := registry.InvalidateGeneration("rules-engine", "generation-1"); removed != 1 {
		t.Fatalf("invalidated %d contexts, want 1", removed)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if snapshot := registry.Snapshot(); snapshot.Active != 0 || snapshot.Invalidated != 1 || snapshot.Rejected != 1 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
}

func TestRegistryRejectsOutOfContractMetadataBeforeIssuing(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 31, 10, 0, 0, 0, time.UTC)
	registry := testRegistry(t, &now, 4)
	requests := []IssueRequest{
		{AddonID: "INVALID", Generation: "generation-1", Deadline: now.Add(time.Minute), Actor: workerrpc.Actor{Role: "system"}},
		{AddonID: "rules-engine", Generation: "bad\x00generation", Deadline: now.Add(time.Minute), Actor: workerrpc.Actor{Role: "system"}},
		{AddonID: "rules-engine", Generation: "generation-1", CorrelationID: string(make([]byte, 201)), Deadline: now.Add(time.Minute), Actor: workerrpc.Actor{Role: "system"}},
		{AddonID: "rules-engine", Generation: "generation-1", Deadline: now.Add(3 * time.Minute), Actor: workerrpc.Actor{Role: "system"}},
		{AddonID: "rules-engine", Generation: "generation-1", Deadline: now.Add(time.Minute), Actor: workerrpc.Actor{Role: "system"}, Traceparent: "not-a-traceparent"},
	}
	for index, request := range requests {
		if _, err := registry.Issue(request); !errors.Is(err, ErrInvalidContext) {
			t.Fatalf("request %d error = %v, want ErrInvalidContext", index, err)
		}
	}
	if snapshot := registry.Snapshot(); snapshot.Active != 0 || snapshot.Issued != 0 {
		t.Fatalf("invalid requests changed registry: %+v", snapshot)
	}
}

func TestRegistryConcurrentResolveAndClose(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 31, 10, 0, 0, 0, time.UTC)
	registry := testRegistry(t, &now, 8)
	lease := issueTestLease(t, registry, "generation-1", now.Add(time.Minute))
	meta := lease.Meta()

	var wait sync.WaitGroup
	for index := 0; index < 32; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, _ = registry.ResolveContext(context.Background(), ResolveRequest{
				AddonID: "rules-engine", Generation: "generation-1", WireMeta: meta,
			})
		}()
	}
	wait.Add(1)
	go func() {
		defer wait.Done()
		_ = lease.Close()
	}()
	wait.Wait()
	if snapshot := registry.Snapshot(); snapshot.Active != 0 {
		t.Fatalf("registry retained closed lease: %+v", snapshot)
	}
}

func testRegistry(t *testing.T, now *time.Time, capacity int) *Registry {
	t.Helper()
	var mu sync.Mutex
	next := 0
	registry, err := New(Config{
		MaxActive:   capacity,
		MaxLifetime: 2 * time.Minute,
		Now: func() time.Time {
			return *now
		},
		GenerateID: func() (string, error) {
			mu.Lock()
			defer mu.Unlock()
			next++
			return fmt.Sprintf("request-%d", next), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func issueTestLease(t *testing.T, registry *Registry, generation string, deadline time.Time) *Lease {
	t.Helper()
	lease, err := registry.Issue(IssueRequest{
		AddonID: "rules-engine", Generation: generation, Deadline: deadline, Actor: workerrpc.Actor{Role: "system"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return lease
}
