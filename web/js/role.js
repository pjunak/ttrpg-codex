// ═══════════════════════════════════════════════════════════════
//  ROLE — client-side cache of the caller's effective role.
//
//  The server is the source of truth for visibility — the client
//  receives data that's already been filtered for its role. This
//  module exists to:
//    1. Cache `/api/auth` so the rest of the UI can branch on
//       Role.isDM() without spinning up a fetch every time.
//    2. Surface the isolated player-preview controls.
//    3. Stamp `body.is-dm` / `body.is-impersonating` classes so
//       CSS can hide DM-only chrome (edit toggle, DM dashboard
//       link, etc.) without per-element JS gating.
//
//  Reads are eventually consistent — a stale role triggers a 401
//  on the next write attempt, which the user resolves by logging in
//  again. The cache is repopulated on every `Store.load()` indirect
//  via `Role.refresh()` from app.js.
// ═══════════════════════════════════════════════════════════════

import { PlayerPreview } from './player-preview.js';

export const Role = (() => {
  // `role` is the EFFECTIVE role used for filtering — what the DM
  // sees right now. `realRole` is the underlying signed claim from
  // the cookie; a DM impersonating a player has `role='player'`
  // and `realRole='dm'`. Both are null for anonymous visitors.
  let _role     = null;
  let _realRole = null;
  let _loaded   = false;

  async function refresh() {
    let role = null, realRole = null;
    try {
      const res = await fetch('/api/auth', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        role     = data.role     || null;
        realRole = data.realRole || null;
      }
    } catch (_) { /* swallow — role stays null */ }
    _loaded = true;
    _setRole(role, realRole);   // fires `role:changed` only if it actually changed
    return { role: _role, realRole: _realRole };
  }

  function _applyBodyClasses() {
    document.body.classList.toggle('is-dm',           _role === 'dm');
    document.body.classList.toggle('is-player',       _role === 'player');
    document.body.classList.toggle('is-anonymous',    _role === null);
    document.body.classList.toggle('is-impersonating', _role !== _realRole && _realRole === 'dm');
  }

  /** Effective role. Null for anonymous. */
  function get() { return _role; }

  /** Underlying signed role from the cookie. Null for anonymous. */
  function getReal() { return _realRole; }

  function isDM()            { return _role === 'dm'; }
  function isPlayer()        { return _role === 'player'; }
  function isAnonymous()     { return _role === null; }
  function isImpersonating() { return _role !== _realRole && _realRole === 'dm'; }
  function isPlayerPreview()  { return PlayerPreview.isActive(); }
  function isLoaded()        { return _loaded; }

  // Update _role / _realRole, restamp body classes, and fire
  // `role:changed` if anything actually changed. Used by every state
  // transition below so subscribers (sidebar badge, data refetch) get
  // a single signal regardless of which API was called.
  function _setRole(role, realRole) {
    const changed = (_role !== role) || (_realRole !== realRole);
    _role = role; _realRole = realRole;
    _applyBodyClasses();
    if (changed) {
      try {
        window.dispatchEvent(new CustomEvent('role:changed', {
          detail: { role: _role, realRole: _realRole },
        }));
      } catch (_) {}
    }
  }

  /** Switch the effective role to 'player' (DM only). Server re-issues
   *  the cookie with realRole='dm' preserved so we can flip back
   *  without re-entering the password. Returns the new role on success. */
  async function viewAsPlayer() {
    if (_realRole !== 'dm') return null;
    try {
      const res = await fetch('/api/view-as', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = await res.json();
      _setRole(data.role || null, data.realRole || null);
      return _role;
    } catch (_) { return null; }
  }

  /** Open an isolated player-only session in a new tab. Its short-lived
   *  credential is stored in that tab's sessionStorage, so the DM cookie in
   *  this tab is never replaced. */
  async function openPlayerPreview() {
    if (!isDM() || typeof window === 'undefined') return null;
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) return null;
    try { previewWindow.opener = null; } catch (_) {}
    try {
      const res = await fetch('/api/player-preview', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) throw new Error('player preview unavailable');
      const data = await res.json();
      if (!data?.token) throw new Error('player preview token missing');
      previewWindow.location.replace(PlayerPreview.buildUrl(data.token));
      return true;
    } catch (_) {
      try { previewWindow.close(); } catch (_) {}
      return null;
    }
  }

  function closePlayerPreview() {
    if (!PlayerPreview.isActive()) return;
    PlayerPreview.close();
  }

  /** Flip back to effective role 'dm' from a player-impersonation state. */
  async function backToDM() {
    if (_realRole !== 'dm') return null;
    try {
      const res = await fetch('/api/view-as-dm', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = await res.json();
      _setRole(data.role || null, data.realRole || null);
      return _role;
    } catch (_) { return null; }
  }

  /** Clear the session cookie. Logs the user out without prompting. */
  async function logout() {
    if (PlayerPreview.isActive()) {
      PlayerPreview.close();
      return;
    }
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) {}
    _setRole(null, null);
  }

  return {
    refresh, get, getReal,
    isDM, isPlayer, isAnonymous, isImpersonating, isPlayerPreview, isLoaded,
    openPlayerPreview, closePlayerPreview,
    viewAsPlayer, backToDM, logout,
  };
})();
