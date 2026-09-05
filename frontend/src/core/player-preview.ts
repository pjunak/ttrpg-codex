const storageKey = "codex_player_preview";
const marker = "playerPreview";
const header = "X-Codex-Player-Preview";
const tokenPattern = /^[A-Za-z0-9_-]{32,512}$/u;
let token: string | undefined;

// Keep a non-secret URL marker so cleared/unavailable tab storage fails closed.
// Bootstrap credentials travel in the fragment, never in an HTTP request URL.
export function initializePlayerPreview(scope: Pick<Window, "location" | "history" | "sessionStorage"> = window): void {
  token = undefined;
  const url = new URL(scope.location.href);
  const bootstrap = url.hash.startsWith("#player-preview=");
  let stored: string | null = null;
  try { stored = scope.sessionStorage.getItem(storageKey); } catch { /* The URL marker preserves preview mode without storage. */ }
  if (!bootstrap && !url.searchParams.has(marker) && stored === null) return;
  token = "";
  if (bootstrap) {
    const supplied = url.hash.slice("#player-preview=".length);
    token = tokenPattern.test(supplied) ? supplied : "";
    url.hash = "#/";
    url.searchParams.set(marker, "1");
    scope.history.replaceState(null, "", url.href);
    try { scope.sessionStorage.setItem(storageKey, token); } catch { /* This page remains scoped; reload fails closed. */ }
  } else {
    token = stored !== null && tokenPattern.test(stored) ? stored : "";
    if (!url.searchParams.has(marker)) {
      url.searchParams.set(marker, "1");
      scope.history.replaceState(null, "", url.href);
    }
  }
}

export function isPlayerPreview(): boolean { return token !== undefined; }

export function playerPreviewURL(previewToken: string, source = window.location.href): string {
  if (!tokenPattern.test(previewToken)) throw new Error("Invalid player preview token");
  const url = new URL(source);
  url.search = "";
  url.hash = `player-preview=${previewToken}`;
  return url.href;
}

function sameOriginAPI(input: RequestInfo | URL): URL | undefined {
  if (typeof location === "undefined") return undefined;
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  return url.origin === location.origin && url.pathname.startsWith("/api/") ? url : undefined;
}

/** Shared default transport for core clients and host-issued add-on facades. */
export const sessionFetch: typeof fetch = (input, init) => {
  if (token === undefined || sameOriginAPI(input) === undefined) return fetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(header, token);
  return fetch(input, { ...init, headers, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
};

// EventSource and image requests cannot attach the preview header. Apply this
// only at rendering/transport boundaries; persisted media URLs stay canonical.
export function previewResourceURL<T extends string | undefined>(input: T): T {
  if (input === undefined || token === undefined) return input;
  const url = sameOriginAPI(input);
  if (url === undefined || !(url.pathname === "/api/events" || url.pathname.startsWith("/api/media/"))) return input;
  url.searchParams.set("playerPreviewToken", token);
  const path = input.split(/[?#]/u, 1)[0];
  return `${path}${url.search}${url.hash}` as T;
}
