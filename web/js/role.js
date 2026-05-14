// ═══════════════════════════════════════════════════════════════
//  ROLE — client-side cache of the caller's effective role.
//
//  The server is the source of truth for visibility — the client
//  receives data that's already been filtered for its role. This
//  module exists to:
//    1. Cache `/api/auth` so the rest of the UI can branch on
//       Role.isDM() without spinning up a fetch every time.
//    2. Surface the "View as player" / "Back to DM" controls.
//    3. Stamp `body.is-dm` / `body.is-impersonating` classes so
//       CSS can hide DM-only chrome (edit toggle, DM dashboard
//       link, etc.) without per-element JS gating.
//
//  Reads are eventually consistent — a stale role triggers a 401
//  on the next write attempt, which the user resolves by logging in
//  again. The cache is repopulated on every `Store.load()` indirect
//  via `Role.refresh()` from app.js.
// ═══════════════════════════════════════════════════════════════

export const Role = (() => {
  // `role` is the EFFECTIVE role used for filtering — what the DM
  // sees right now. `realRole` is the underlying signed claim from
  // the cookie; a DM impersonating a player has `role='player'`
  // and `realRole='dm'`. Both are null for anonymous visitors.
  let _role     = null;
  let _realRole = null;
  let _loaded   = false;

  async function refresh() {
    try {
      const res = await fetch('/api/auth', { credentials: 'same-origin' });
      if (!res.ok) {
        _role = null; _realRole = null;
      } else {
        const data = await res.json();
        _role     = data.role     || null;
        _realRole = data.realRole || null;
      }
    } catch (_) {
      _role = null; _realRole = null;
    }
    _loaded = true;
    _applyBodyClasses();
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
  function isLoaded()        { return _loaded; }

  /** Switch the effective role to 'player' (DM only). Server re-issues
   *  the cookie with realRole='dm' preserved so we can flip back
   *  without re-entering the password. Returns the new role on success. */
  async function viewAsPlayer() {
    if (_realRole !== 'dm') return null;
    try {
      const res = await fetch('/api/view-as', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = await res.json();
      _role     = data.role     || null;
      _realRole = data.realRole || null;
      _applyBodyClasses();
      return _role;
    } catch (_) { return null; }
  }

  /** Flip back to effective role 'dm' from a player-impersonation state. */
  async function backToDM() {
    if (_realRole !== 'dm') return null;
    try {
      const res = await fetch('/api/view-as-dm', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = await res.json();
      _role     = data.role     || null;
      _realRole = data.realRole || null;
      _applyBodyClasses();
      return _role;
    } catch (_) { return null; }
  }

  /** Clear the session cookie. Logs the user out without prompting. */
  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) {}
    _role = null; _realRole = null;
    _applyBodyClasses();
  }

  return {
    refresh, get, getReal,
    isDM, isPlayer, isAnonymous, isImpersonating, isLoaded,
    viewAsPlayer, backToDM, logout,
  };
})();
