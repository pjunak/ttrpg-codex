const QUERY_PARAM = 'playerPreview';
const API_QUERY_PARAM = 'playerPreviewToken';
const API_HEADER = 'X-Codex-Player-Preview';

let token = '';

function currentOrigin() {
  try { return window.location.origin; } catch (_) { return ''; }
}

function isSameOriginApi(input) {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.href);
    return url.origin === currentOrigin() && url.pathname.startsWith('/api/');
  } catch (_) {
    return false;
  }
}

function bootstrap() {
  try {
    const url = new URL(window.location.href);
    const supplied = url.searchParams.get(QUERY_PARAM);
    if (supplied) {
      sessionStorage.setItem(QUERY_PARAM, supplied);
      url.searchParams.delete(QUERY_PARAM);
      history.replaceState(history.state, '', url.href);
    }
    token = sessionStorage.getItem(QUERY_PARAM) || '';
  } catch (_) {
    token = '';
  }
}

function installFetchScope() {
  const nativeFetch = globalThis.fetch;
  if (!token || typeof nativeFetch !== 'function') return;
  globalThis.fetch = function playerPreviewFetch(input, init = {}) {
    if (!isSameOriginApi(input)) return nativeFetch.call(this, input, init);
    const sourceHeaders = init.headers || (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(sourceHeaders);
    headers.set(API_HEADER, token);
    return nativeFetch.call(this, input, { ...init, headers });
  };
}

bootstrap();
installFetchScope();

export const PlayerPreview = Object.freeze({
  isActive: () => !!token,

  apiUrl(path) {
    if (!token) return path;
    const url = new URL(path, window.location.href);
    url.searchParams.set(API_QUERY_PARAM, token);
    return `${url.pathname}${url.search}${url.hash}`;
  },

  buildUrl(previewToken, source = window.location.href) {
    const url = new URL(source, window.location.href);
    url.searchParams.set(QUERY_PARAM, previewToken);
    return url.href;
  },

  close() {
    try { window.close(); } catch (_) {}
  },
});
