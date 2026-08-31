import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";

const boundary = "GET /api/events";
const maximumEventBytes = 64 * 1024;
const sha256Pattern = /^[0-9a-f]{64}$/;
const helloKeys = new Set(["cursor", "audience"]);
const resetKeys = new Set(["cursor", "reason"]);
const publicationKeys = new Set([
  "sequence",
  "topic",
  "resourceId",
  "revision",
  "occurredAt",
  "metadata",
]);

export type EventRefreshCause = "hello" | "reset" | "browser-addons-changed";

export interface EventRefresh {
  readonly cause: EventRefreshCause;
  readonly cursor: number;
  readonly revision?: string;
}

export interface EventStreamCallbacks {
  readonly onRefresh: (refresh: EventRefresh) => void;
  readonly onBoundaryError?: (error: BoundaryValidationError) => void;
  readonly onConnectionError?: () => void;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export type EventSourceFactory = (
  url: string,
  init: EventSourceInit,
) => EventSourceLike;

export class SharedEventStream {
  readonly #factory: EventSourceFactory;
  #source: EventSourceLike | undefined;

  constructor(factory: EventSourceFactory = (url, init) => new EventSource(url, init)) {
    this.#factory = factory;
  }

  open(callbacks: EventStreamCallbacks): void {
    this.close();
    const source = this.#factory("/api/events", { withCredentials: true });
    this.#source = source;
    this.#listen(source, "hello", callbacks, parseHello);
    this.#listen(source, "reset", callbacks, parseReset);
    this.#listen(source, "browser-addons-changed", callbacks, parseBrowserAddonChange);
    source.addEventListener("error", () => callbacks.onConnectionError?.());
  }

  close(): void {
    this.#source?.close();
    this.#source = undefined;
  }

  #listen(
    source: EventSourceLike,
    name: EventRefreshCause,
    callbacks: EventStreamCallbacks,
    parse: (event: Event) => EventRefresh,
  ): void {
    source.addEventListener(name, (event) => {
      if (source !== this.#source) {
        return;
      }
      try {
        callbacks.onRefresh(parse(event));
      } catch (error: unknown) {
        callbacks.onBoundaryError?.(
          error instanceof BoundaryValidationError
            ? error
            : new BoundaryValidationError(boundary, "event callback failed validation"),
        );
      }
    });
  }
}

export function parseHello(event: Event): EventRefresh {
  const message = parseMessage(event, "hello");
  if (!isRecord(message.value) || !hasOnlyKeys(message.value, helloKeys) ||
    (message.value["audience"] !== "public" && message.value["audience"] !== "dm")) {
    throw new BoundaryValidationError(boundary, "hello event has an invalid shape");
  }
  const cursor = requiredCursor(message.value["cursor"], message.lastEventId);
  return { cause: "hello", cursor };
}

export function parseReset(event: Event): EventRefresh {
  const message = parseMessage(event, "reset");
  if (!isRecord(message.value) || !hasOnlyKeys(message.value, resetKeys) ||
    message.value["reason"] !== "replay-unavailable") {
    throw new BoundaryValidationError(boundary, "reset event has an invalid shape");
  }
  const cursor = requiredCursor(message.value["cursor"], message.lastEventId);
  return { cause: "reset", cursor };
}

export function parseBrowserAddonChange(event: Event): EventRefresh {
  const message = parseMessage(event, "browser-addons-changed");
  if (!isRecord(message.value) || !hasOnlyKeys(message.value, publicationKeys)) {
    throw new BoundaryValidationError(boundary, "browser add-on event has an invalid shape");
  }
  const sequence = requiredCursor(message.value["sequence"], message.lastEventId);
  if (message.value["topic"] !== "browser-addons-changed" ||
    typeof message.value["revision"] !== "string" ||
    !sha256Pattern.test(message.value["revision"]) ||
    typeof message.value["occurredAt"] !== "string" ||
    !validTimestamp(message.value["occurredAt"]) ||
    !isRecord(message.value["metadata"]) ||
    (message.value["resourceId"] !== undefined && typeof message.value["resourceId"] !== "string")) {
    throw new BoundaryValidationError(boundary, "browser add-on event contains invalid values");
  }
  return {
    cause: "browser-addons-changed",
    cursor: sequence,
    revision: message.value["revision"],
  };
}

function parseMessage(event: Event, name: string): { value: unknown; lastEventId: string } {
  const candidate = event as Event & { data?: unknown; lastEventId?: unknown };
  if (typeof candidate.data !== "string" || typeof candidate.lastEventId !== "string") {
    throw new BoundaryValidationError(boundary, `${name} must be a message event`);
  }
  if (new TextEncoder().encode(candidate.data).byteLength > maximumEventBytes) {
    throw new BoundaryValidationError(boundary, `${name} event exceeds 64 KiB`);
  }
  let value: unknown;
  try {
    value = JSON.parse(candidate.data) as unknown;
  } catch {
    throw new BoundaryValidationError(boundary, `${name} event must contain valid JSON`);
  }
  return { value, lastEventId: candidate.lastEventId };
}

function requiredCursor(value: unknown, lastEventId: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
    lastEventId !== String(value)) {
    throw new BoundaryValidationError(boundary, "event cursor does not match Last-Event-ID");
  }
  return value;
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
