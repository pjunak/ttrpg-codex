import { isRecord } from "../core/boundary.js";
import { browserAddonRouteHash, parseBrowserAddonLocation } from "./navigation.js";
import type { ActiveBrowserContribution, BrowserContributionRegistry } from "./browser-sdk.js";
import type { BrowserRole } from "./generation-manager.js";

export type WikiReference = { readonly label: string; readonly hint: string } | { readonly path: string };
export type WikiRequest = { readonly contractVersion: "wiki-links.v1"; readonly operation: "resolve"; readonly references: readonly WikiReference[] } |
  { readonly contractVersion: "wiki-links.v1"; readonly operation: "search"; readonly query: string; readonly limit: number };
export interface WikiMatch { readonly index: number; readonly href: string; readonly label: string; readonly description: string }
export interface WikiResult { readonly active: ActiveBrowserContribution; readonly matches: readonly WikiMatch[]; readonly failed: boolean }

export function wikiProviders(registry: BrowserContributionRegistry | undefined, role: BrowserRole | undefined): readonly ActiveBrowserContribution[] {
  return role ? registry?.list("wiki-kind", role).filter(active => active.binding.kind === "model-provider" &&
    active.descriptor.config["contractVersion"] === 1) ?? [] : [];
}

export function acceptsWikiReference(active: ActiveBrowserContribution, reference: WikiReference): boolean {
  if ("path" in reference) {
    const root = /^#\/([a-z0-9-]+)(?:\/|$)/u.exec(reference.path)?.[1];
    return !!root && strings(active.descriptor.config["legacyRoots"]).includes(root) && reference.path.length <= 2048;
  }
  return !reference.hint || strings(active.descriptor.config["kinds"]).includes(reference.hint.split(":", 1)[0]!);
}

export function parseWikiMatches(value: unknown, active: ActiveBrowserContribution, routes: readonly ActiveBrowserContribution[], request: WikiRequest): readonly WikiMatch[] {
  const json = JSON.stringify(value);
  if (!json || new TextEncoder().encode(json).length > 48_000) throw new TypeError("Wiki response exceeds 48000 bytes");
  const model = object(JSON.parse(json), ["contractVersion", "matches"]);
  const limit = request.operation === "resolve" ? request.references.length : request.limit;
  if (model["contractVersion"] !== "wiki-links.v1" || !Array.isArray(model["matches"]) || model["matches"].length > limit) throw new TypeError("Invalid wiki response");
  const indices = new Set<number>();
  return model["matches"].map(raw => {
    const match = object(raw, ["index", "target", "label", "description"]), index = match["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= limit || indices.has(index)) throw new TypeError("Invalid wiki match index");
    indices.add(index);
    const target = object(match["target"], ["route", "query"]);
    const route = routes.find(item => item.addonId === active.addonId && item.generationId === active.generationId &&
      !item.signal.aborted && item.descriptor.id === target["route"] && ["element", "isolated-frame"].includes(item.binding.kind));
    if (!route || !Array.isArray(target["query"]) || target["query"].length > 32) throw new TypeError("Wiki target needs an active route in its generation");
    const query = new URLSearchParams();
    for (const pair of target["query"]) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError("Invalid wiki target query");
      query.append(text(pair[0], 64, true), text(pair[1], 1024));
    }
    const href = browserAddonRouteHash(route) + (query.size ? `?${query}` : "");
    if (!parseBrowserAddonLocation(href)) throw new TypeError("Invalid wiki target route");
    return { index, href, label: match["label"] === undefined && request.operation === "resolve" ? "" : text(match["label"], 200, true),
      description: match["description"] === undefined ? "" : text(match["description"], 500) };
  });
}

/** Only requested labels/hints or a search term cross this boundary, never article bodies. */
export async function requestWikiProvider(active: ActiveBrowserContribution, request: WikiRequest,
  routes: readonly ActiveBrowserContribution[], signal: AbortSignal, timeoutMs = 10_000): Promise<WikiResult> {
  const deadline = new AbortController(), combined = AbortSignal.any([signal, active.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let cancel: (() => void) | undefined;
  try {
    combined.throwIfAborted();
    if (active.binding.kind !== "model-provider") throw new TypeError("Wiki provider unavailable");
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new DOMException("Wiki request cancelled", "AbortError"));
      combined.addEventListener("abort", cancel, { once: true });
    });
    const value = await Promise.race([aborted, active.binding.provide(structuredClone(request), { signal: combined })]);
    combined.throwIfAborted();
    return { active, matches: parseWikiMatches(value, active, routes, request), failed: false };
  } catch { return { active, matches: [], failed: true }; }
  finally { clearTimeout(timer); if (cancel) combined.removeEventListener("abort", cancel); }
}

function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError("Unexpected wiki response fields");
  return value;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || required && !value.trim() || /\p{Cc}/u.test(value)) throw new TypeError("Invalid wiki text");
  return value;
}
