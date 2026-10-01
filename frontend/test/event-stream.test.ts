import { describe, expect, it, vi } from "vitest";
import { BoundaryValidationError } from "../src/core/boundary.js";
import {
  SharedEventStream,
  parseBrowserAddonChange,
  parseCampaignDataChange,
  parseHello,
  parseReset,
  type EventSourceLike,
} from "../src/core/event-stream.js";

describe("shared event boundary", () => {
  it("validates hello and browser graph revision messages", () => {
    expect(parseHello(message("0", { cursor: 0, audience: "public" }))).toEqual({
      cause: "hello",
      cursor: 0,
    });
    expect(parseReset(message("2", { cursor: 2, reason: "replay-unavailable" }))).toEqual({
      cause: "reset",
      cursor: 2,
    });
    expect(
      parseBrowserAddonChange(
        message("3", {
          sequence: 3,
          topic: "browser-addons-changed",
          resourceId: "dm-tools",
          revision: "a".repeat(64),
          occurredAt: "2026-08-31T12:00:00Z",
          metadata: { reason: "activated" },
        }),
      ),
    ).toEqual({
      cause: "browser-addons-changed",
      cursor: 3,
      revision: "a".repeat(64),
    });
    expect(
      parseCampaignDataChange(
        message("4", {
          sequence: 4,
          topic: "campaign-data-changed",
          resourceId: "characters",
          revision: "7",
          occurredAt: "2026-08-31T12:00:01Z",
          metadata: { commitId: 12, records: 2 },
        }),
      ),
    ).toEqual({
      cause: "campaign-data-changed",
      cursor: 4,
      collection: "characters",
      revision: 7,
    });
  });

  it.each([
    message("2", { cursor: 1, audience: "public" }),
    message("1", { cursor: 1, audience: "player" }),
    message("1", {
      sequence: 1,
      topic: "browser-addons-changed",
      revision: "short",
      occurredAt: "now",
      metadata: {},
    }),
    message("2", {
      sequence: 2,
      topic: "campaign-data-changed",
      resourceId: "private",
      revision: "1",
      occurredAt: "2026-08-31T12:00:00Z",
      metadata: { commitId: 1, records: 1 },
    }),
  ])("rejects malformed event %#", (event) => {
    expect(() =>
      event.type === "hello" ? parseHello(event) : parseBrowserAddonChange(event),
    ).toThrow(BoundaryValidationError);
  });
});

describe("SharedEventStream", () => {
  it("cancels a replaced stream's delivered work while keeping its replacement live", () => {
    const sources: FakeEventSource[] = [];
    const stream = new SharedEventStream(() => {
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    });
    const signals: AbortSignal[] = [];
    const onRefresh = (_event: unknown, signal: AbortSignal) => signals.push(signal);
    stream.open({ onRefresh });
    sources[0]!.dispatch("hello", message("0", { cursor: 0, audience: "public" }));
    expect(signals[0]?.aborted).toBe(false);
    stream.open({ onRefresh });
    expect(signals[0]?.aborted).toBe(true);
    sources[1]!.dispatch("hello", message("1", { cursor: 1, audience: "dm" }));
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[1]).not.toBe(signals[0]);
    sources[0]!.dispatch("hello", message("2", { cursor: 2, audience: "public" }));
    expect(signals).toHaveLength(2);
    stream.close();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("keeps delivered work live through a transient connection error and reconnect hello", () => {
    const source = new FakeEventSource();
    const stream = new SharedEventStream(() => source);
    const signals: AbortSignal[] = [];
    const onConnectionError = vi.fn();
    stream.open({
      onRefresh: (_event, signal) => signals.push(signal),
      onConnectionError,
    });
    source.dispatch("hello", message("0", { cursor: 0, audience: "public" }));
    source.dispatch("error", new Event("error"));
    expect(onConnectionError).toHaveBeenCalledOnce();
    expect(signals[0]?.aborted).toBe(false);
    source.dispatch("hello", message("2", { cursor: 2, audience: "public" }));
    expect(signals[1]).toBe(signals[0]);
    stream.close();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("ignores a callback failure after that callback retires its stream", () => {
    const source = new FakeEventSource();
    const stream = new SharedEventStream(() => source);
    const onBoundaryError = vi.fn();
    stream.open({
      onRefresh: () => {
        stream.close();
        throw new Error("retired callback failure");
      },
      onBoundaryError,
    });
    source.dispatch("hello", message("0", { cursor: 0, audience: "public" }));
    expect(onBoundaryError).not.toHaveBeenCalled();
  });

  it("ignores connection errors from replaced and closed sources", () => {
    const sources: FakeEventSource[] = [];
    const stream = new SharedEventStream(() => {
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    });
    const previousError = vi.fn(),
      currentError = vi.fn();
    stream.open({ onRefresh: vi.fn(), onConnectionError: previousError });
    const previous = sources[0]!;
    stream.open({ onRefresh: vi.fn(), onConnectionError: currentError });
    previous.dispatch("error", new Event("error"));
    expect(previousError).not.toHaveBeenCalled();
    const current = sources[1]!;
    current.dispatch("error", new Event("error"));
    expect(currentError).toHaveBeenCalledOnce();
    stream.close();
    current.dispatch("error", new Event("error"));
    expect(currentError).toHaveBeenCalledOnce();
  });

  it("uses one credentialed source, routes refreshes, and ignores a replaced source", () => {
    const sources: FakeEventSource[] = [];
    const factory = vi.fn((url: string, init: EventSourceInit) => {
      const source = new FakeEventSource();
      sources.push(source);
      expect(url).toBe("/api/events");
      expect(init.withCredentials).toBe(true);
      return source;
    });
    const refreshes: string[] = [];
    const stream = new SharedEventStream(factory);
    stream.open({ onRefresh: (event) => refreshes.push(event.cause) });
    const previous = sources[0] as FakeEventSource;
    stream.open({ onRefresh: (event) => refreshes.push(`next:${event.cause}`) });

    previous.dispatch("hello", message("0", { cursor: 0, audience: "public" }));
    (sources[1] as FakeEventSource).dispatch(
      "browser-addons-changed",
      message("1", {
        sequence: 1,
        topic: "browser-addons-changed",
        revision: "b".repeat(64),
        occurredAt: "2026-08-31T12:00:00Z",
        metadata: {},
      }),
    );
    (sources[1] as FakeEventSource).dispatch(
      "campaign-data-changed",
      message("2", {
        sequence: 2,
        topic: "campaign-data-changed",
        resourceId: "locations",
        revision: "3",
        occurredAt: "2026-08-31T12:00:00Z",
        metadata: { commitId: 2, records: 1 },
      }),
    );

    expect(previous.closed).toBe(true);
    expect(refreshes).toEqual(["next:browser-addons-changed", "next:campaign-data-changed"]);
    stream.close();
    expect((sources[1] as FakeEventSource).closed).toBe(true);
  });
});

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function message(lastEventId: string, value: unknown): Event {
  const topic =
    typeof value === "object" && value !== null && "topic" in value
      ? String((value as { topic: unknown }).topic)
      : "hello";
  return { type: topic, data: JSON.stringify(value), lastEventId } as unknown as Event;
}
