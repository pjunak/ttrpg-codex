// ═══════════════════════════════════════════════════════════════
//  APP — router + navigation state
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { EditMode } from './editmode.js';
import { Wiki } from './wiki.js';
import { CloudMap } from './cloudmap.js';
import { Timeline } from './timeline.js';
import { WorldMap } from './map.js';
import { Settings } from './settings.js';
import { Widgets } from './widgets/widgets.js';
import { GlobalSearch } from './search.js';
import { Role } from './role.js';
import { DmDashboard } from './dm_dashboard.js';
import { Sidebar } from './sidebar.js';
import { setWikiLinkResolver, norm, dataAction } from './utils.js';

// ── Action dispatcher (replaces inline `onclick="Module.method(...)"`) ──
// Buttons / anchors carry `data-action="Module.method"` plus an optional
// `data-args='[json,…]'`. A single capture-phase document listener parses
// the action, looks up the function via the local registry below (NOT
// `window.*`), and invokes it. Side effects:
//   1. Drops the eight global `window.*` exports the inline-onclick model
//      required — modules stay private to this entry point.
//   2. Lets the page run under `Content-Security-Policy: script-src 'self'`
//      because no inline event-handler attributes survive.
const ACTIONS = {
  Store, EditMode, Wiki, CloudMap, Timeline, WorldMap, Settings, GlobalSearch, Role, DmDashboard, Sidebar,
};
// Browser-built-in shortcuts that used to live inline (`history.back()`,
// `document.getElementById(slug).scrollIntoView(…)`, etc.). Element- /
// event-aware builtins pull what they need via the `$el` / `$ev`
// sentinels in the call site's args list — no per-handler magic.
const BUILTIN_ACTIONS = {
  back:           () => history.back(),
  scrollTo:       (slug) => document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  reload:         () => window.location.reload(),
  hashGoto:       (hash) => { window.location.hash = hash; },
  // Remove an ancestor of the dispatch element. Pass `$el` plus an
  // optional CSS selector; without a selector it removes the parent.
  removeAncestor: (el, selector) => (selector ? el?.closest(selector) : el?.parentElement)?.remove(),
  // Mirror one input's value into another by id. Replaces the colour-
  // picker / hex-text two-way binding that used inline oninput.
  copyValue:      (srcId, dstId) => {
    const src = document.getElementById(srcId);
    const dst = document.getElementById(dstId);
    if (src && dst) dst.value = src.value;
  },
  // Defer the call by one tick — used when navigating then asking the
  // newly-mounted view to do something (was `setTimeout(()=>X(),0)`).
  deferred:       (action, ...args) => setTimeout(() => _runAction(action, ...args), 0),
  // Enter inside a contenteditable blurs (and prevents a stray newline).
  // Replaces `onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"`.
  enterBlurs:     (ev) => {
    if (ev?.key === 'Enter') { ev.preventDefault(); ev.target?.blur(); }
  },
  // Hide an element. Used as `data-on-error="hide"` on <img> previews
  // whose source might 404. Replaces `onerror="this.style.display='none'"`.
  hide:           (el) => { if (el) el.style.display = 'none'; },
  // Toggle / remove a class on document.body. Mobile drawer + map-sheet
  // toggles in index.html used inline body.classList ops.
  bodyToggleClass: (cls) => document.body.classList.toggle(cls),
  bodyRemoveClass: (cls) => document.body.classList.remove(cls),
};
// Args may contain placeholder sentinels:
//   `$el`      → the element that carries the data-action
//   `$ev`      → the original Event
//   `$value`   → el.value (covers `this.value` in inline `onchange`/`oninput`)
//   `$text`    → el.textContent?.trim() (for contenteditable nodes)
//   `$checked` → el.checked (for checkbox / radio handlers)
// Lets templates pass the element / event / value to handlers that
// previously relied on inline `this` / `event` references.
/**
 * Resolve placeholder sentinels in a `data-args` array against the current
 * element + event so handlers can receive live values (rather than the
 * stringified snapshot stored at template time).
 *
 * @param {Array<*>} rawArgs - Args parsed out of the `data-args` JSON.
 * @param {Element} el - The element carrying the `data-action` attribute.
 * @param {Event} ev - The event that triggered dispatch.
 * @returns {Array<*>} New args with sentinels replaced.
 */
function _resolveArgs(rawArgs, el, ev) {
  return rawArgs.map(a =>
    a === '$el'      ? el :
    a === '$ev'      ? ev :
    a === '$value'   ? el?.value :
    a === '$text'    ? el?.textContent?.trim() :
    a === '$checked' ? !!el?.checked :
    a
  );
}
/**
 * Look up and invoke an action by string name. Names of the form
 * `Module.method` resolve against the `ACTIONS` registry; bare names
 * resolve against `BUILTIN_ACTIONS`. Unknown names log a warning.
 *
 * @param {string} actionStr - Either `Module.method` or a built-in name.
 * @param  {...*} args - Already-resolved args to forward to the handler.
 * @returns {*} Whatever the handler returns.
 */
function _runAction(actionStr, ...args) {
  if (!actionStr) return;
  const dot = actionStr.indexOf('.');
  if (dot > 0) {
    const mod = ACTIONS[actionStr.slice(0, dot)];
    const fn  = mod?.[actionStr.slice(dot + 1)];
    if (typeof fn === 'function') return fn.apply(mod, args);
  } else {
    const fn = BUILTIN_ACTIONS[actionStr];
    if (typeof fn === 'function') return fn(...args);
  }
  console.warn('Unknown data-action:', actionStr);
}
function _dispatch(el, ev, attr, argsAttr, opts = {}) {
  const action = el.dataset[attr];
  if (!action) return;
  let raw = [];
  const argsJson = el.dataset[argsAttr];
  if (argsJson !== undefined) {
    try { raw = JSON.parse(argsJson); }
    catch (err) { console.warn('Bad JSON on', el, argsJson, err); return; }
  }
  const args = _resolveArgs(raw, el, ev);
  // Click + submit get default preventDefault — most converted onclick
  // handlers wanted that. Change/input/blur/keydown don't, so typing
  // and form-validation fire-and-go behaviour stays intact; if the
  // handler needs to suppress, it asks via `$ev` and `.preventDefault()`.
  if (opts.preventDefault) ev.preventDefault();
  _runAction(action, ...args);
}
// Capture-phase so we run before component-level handlers AND before
// the dirty-form click guard in editmode.js (which only checks `<a>`
// hash navigations — data-action triggers never reach hash routing).
//
// preventDefault rule:
//   - <button> and <a href="#"> / <a href="#anchor"> → suppress default
//     (the action fully replaces the link's intent — most converted
//     onclick handlers ended in `event.preventDefault()`).
//   - <a href="#/route"> → KEEP default, so hash-routing still fires
//     after the action runs (e.g. close-panel + navigate to detail).
//   - Modifier-click on a real href → fall through to the browser
//     entirely, so middle-click / Ctrl-click open in a new tab.
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const href = el.tagName === 'A' ? el.getAttribute('href') : null;
  if (href && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1)) return;
  const isHashRoute = !!(href && href.startsWith('#/'));
  _dispatch(el, ev, 'action', 'args', { preventDefault: !isHashRoute });
}, true);

// Convention for non-click events. Each pair is `data-on-<kind>` +
// `data-<kind>-args` (JSON array of args, with `$el`/`$ev`/`$value`
// sentinels). Listeners use `focusout` instead of `blur` because
// `blur` doesn't bubble and we need a single document-level listener.
document.addEventListener('submit',   (ev) => {
  const el = ev.target.closest('[data-on-submit]');
  if (el) _dispatch(el, ev, 'onSubmit', 'submitArgs', { preventDefault: true });
}, true);
document.addEventListener('change',   (ev) => {
  const el = ev.target.closest('[data-on-change]');
  if (el) _dispatch(el, ev, 'onChange', 'changeArgs');
}, true);
document.addEventListener('input',    (ev) => {
  const el = ev.target.closest('[data-on-input]');
  if (el) _dispatch(el, ev, 'onInput', 'inputArgs');
}, true);
document.addEventListener('focusout', (ev) => {
  const el = ev.target.closest('[data-on-blur]');
  if (el) _dispatch(el, ev, 'onBlur', 'blurArgs');
}, true);
document.addEventListener('keydown',  (ev) => {
  const el = ev.target.closest('[data-on-keydown]');
  if (el) _dispatch(el, ev, 'onKeydown', 'keydownArgs');
}, true);
// Error events don't bubble, so capture phase is the only way to catch
// `<img onerror="…">` via delegation. Used by the world-map preview to
// hide a broken thumbnail.
document.addEventListener('error',    (ev) => {
  const el = ev.target;
  if (el?.dataset?.onError) _dispatch(el, ev, 'onError', 'errorArgs');
}, true);


(function () {

  // ── Register Cytoscape plugins ──────────────────────────────
  if (typeof cytoscape !== "undefined" && typeof dagre !== "undefined") {
    try { cytoscape.use(cytoscapeDagre); } catch(e) {}
  }

  // ── Wiki-link resolver for `[[Name]]` syntax in prose ───────
  // Looks up `label` across every entity collection and returns
  // `{ kind, id }` for the first exact-name match. The `hint`
  // form supports manual disambiguation:
  //     [[Frulam|postava:frulam_a7b3c9]]       (explicit id)
  //     [[Frulam|postava]]                     (scope search)
  const KIND_ROUTE = {
    characters:'postava', locations:'misto',      events:'udalost',
    mysteries: 'zahada',  species:'druh',         pantheon:'buh',
    artifacts:'artefakt', historicalEvents:'historicka-udalost',
  };
  // Polarity-aware tie-breaker for the twin model. When DM and
  // more than one entity in the same collection matches `label`
  // (typical case: a public + DM twin sharing a name), prefer the
  // candidate whose `visibility` matches the CURRENT article's
  // space. That makes copy-pasted prose between twins resolve to
  // the right counterpart by default. Players are unaffected —
  // they only ever see one side, so the tie never happens.
  function _pickByPolarity(matches, getEntity) {
    if (!matches || matches.length < 2 || !Role.isDM()) return matches[0];
    const ctx = (typeof Wiki?.getCurrentArticle === 'function') ? Wiki.getCurrentArticle() : null;
    if (!ctx) return matches[0];
    const ctxEntity = getEntity ? getEntity(ctx.id) : null;
    const ctxVis    = (ctxEntity && ctxEntity.visibility === 'dm') ? 'dm' : 'public';
    const polarityHit = matches.find(m => (m.visibility === 'dm' ? 'dm' : 'public') === ctxVis);
    return polarityHit || matches[0];
  }
  // Per-collection lookup function map, used by _pickByPolarity to
  // resolve the current-article entity without churning the
  // resolver signature.
  const _STORE_GETTER_BY_COLLECTION = {
    characters:       (id) => Store.getCharacter?.(id),
    locations:        (id) => Store.getLocation?.(id),
    events:           (id) => Store.getEvent?.(id),
    mysteries:        (id) => Store.getMystery?.(id),
    species:          (id) => Store.getSpeciesItem?.(id),
    pantheon:         (id) => Store.getBuh?.(id),
    artifacts:        (id) => Store.getArtifact?.(id),
    historicalEvents: (id) => Store.getHistoricalEvent?.(id),
    factions:         (id) => Store.getFaction?.(id),
  };
  setWikiLinkResolver((label, hint) => {
    if (!label) return null;
    // Explicit disambiguation `[[X|kind:id]]`
    if (hint && hint.includes(':')) {
      const [kind, id] = hint.split(':');
      return { kind, id };
    }
    // Scoped search `[[X|postava]]`
    const scopeRoute = hint || '';
    const all = Store.searchAll ? Store.searchAll(label) : null;
    if (!all) return null;
    const targetN = norm(label);
    const order = ['characters','locations','events','mysteries','species','pantheon','artifacts','historicalEvents'];
    // Current-article polarity for the tie-breaker.
    const ctx = (typeof Wiki?.getCurrentArticle === 'function') ? Wiki.getCurrentArticle() : null;
    for (const k of order) {
      const route = KIND_ROUTE[k];
      if (scopeRoute && route !== scopeRoute) continue;
      const candidates = (all[k] || []).filter(e => norm(e.name) === targetN);
      if (candidates.length === 0) continue;
      const getter = _STORE_GETTER_BY_COLLECTION[k];
      const ctxGetter = ctx ? _STORE_GETTER_BY_COLLECTION[ctx.type] : null;
      const pick = _pickByPolarity(candidates, ctxGetter && ctx ? ((id) => ctxGetter(ctx.id)) : null);
      if (pick) return { kind: route, id: pick.id };
    }
    // Faction special-case — factions aren't in searchAll, hit them by name.
    if (!scopeRoute || scopeRoute === 'frakce') {
      const factions = Store.getFactions ? Store.getFactions() : {};
      const facMatches = [];
      for (const [id, f] of Object.entries(factions)) {
        if (norm(f.name) === targetN) facMatches.push({ id, ...f });
      }
      if (facMatches.length) {
        const ctxGetter = ctx ? _STORE_GETTER_BY_COLLECTION[ctx.type] : null;
        const pick = _pickByPolarity(facMatches, ctxGetter && ctx ? ((id) => ctxGetter(ctx.id)) : null);
        if (pick) return { kind: 'frakce', id: pick.id };
      }
    }
    return null;
  });

  // ── Router ──────────────────────────────────────────────────

  /**
   * Read the current route from `window.location.hash`. Returns `"/"` for
   * the empty hash so callers can treat it as the dashboard route.
   *
   * @returns {string} The path component of the hash (no leading `#`).
   */
  function getRoute() {
    return window.location.hash.replace(/^#/, "") || "/";
  }

  /**
   * Render the page for `route`. Dispatches to the right module
   * (`Wiki`, `WorldMap`, `CloudMap`, `Timeline`, `Settings`), keeps the
   * sidebar / bottom-nav active states in sync, mounts widgets and any
   * EasyMDE textareas in the freshly-rendered subtree, and closes the
   * mobile drawer if it was open. Called for hashchange and on boot.
   *
   * @param {string} route - The current hash route (from `getRoute()`).
   */
  function navigate(route) {
    // Schedule widget mount after the page renders. Runs for every route so
    // any cb-mount/ms-mount placeholders in newly-rendered HTML get wired up.
    // EasyMDE is initialised for any textarea.md-easy in the same pass.
    // Scope: only #main-content changes between routes — the sidebar /
    // bottom-nav / map-sheet have no widget mount points, so walking
    // the whole document is wasted work. Modules that inject widgets
    // dynamically (e.g. relTypeChanged, faction add) call
    // `Widgets.mountAll(scopedRoot)` with a tighter root themselves.
    requestAnimationFrame(() => {
      const root = document.getElementById('main-content') || document.body;
      Widgets.mountAll(root);
      EditMode.mountEasyMDE(root);
    });

    // Close the mobile drawer if navigating via a sidebar link.
    document.body.classList.remove('mobile-nav-open');

    // Top-right login chip visibility is route-dependent (dashboard only).
    // Render here so leaving / returning to Přehled hides / re-shows the chip
    // without waiting for a role transition.
    _renderTopbarLogin();

    // Clear any per-article edit state if we're leaving the article it
    // belongs to. Without this, navigating away mid-edit and then back
    // would re-open the editor unexpectedly.
    Wiki.syncEditRoute(route);

    // Anonymous route guard. The +Add buttons / pencils / inline-edit
    // affordances are visible to everyone; clicking surfaces the login
    // modal via the action handler. But "+ Nová" links jump straight to
    // a /new entity-creation route bypassing those handlers, so we
    // intercept the navigation here. Same for /nastaveni — the user
    // explicitly asked that anonymous access prompt for login.
    if (Role.isAnonymous() &&
        (route === '/nastaveni' || route.endsWith('/new'))) {
      EditMode.promptLogin();
      const main = document.getElementById('main-content');
      if (main) {
        main.innerHTML = `
          <div class="page-header"><h1>🔒 Vyžaduje přihlášení</h1></div>
          <p style="color:var(--text-muted);max-width:540px;margin:1rem 0 1.4rem">
            ${route === '/nastaveni'
              ? 'Pro přístup k nastavení se prosím přihlas — DM nebo hráčským heslem.'
              : 'Pro vytvoření nového záznamu se prosím přihlas — DM nebo hráčským heslem.'}
          </p>
          <button class="inline-create-btn" ${dataAction('EditMode.promptLogin')}>🔑 Přihlásit</button>
          <button class="inline-create-btn" style="margin-left:0.5rem" ${dataAction('back')}>← Zpět</button>`;
      }
      return;
    }

    // Mind-map sub-routes that all belong to Myšlenkový Palác
    const PALAC_ROUTES = new Set(["/mapa/palac", "/mapa/frakce", "/mapa/vztahy", "/mapa/tajemstvi"]);

    // Sync sidebar active state
    document.querySelectorAll("[data-route]").forEach(el => {
      const r = el.dataset.route;
      let active = r === route || r === "/" + route.split("/")[1] || route.startsWith(r + "/");
      // Highlight Myšlenkový Palác for all mind-map sub-routes
      if (r === "/mapa/palac" && PALAC_ROUTES.has(route)) active = true;
      // Local sub-maps share the world-map sidebar entry.
      if (r === "/mapa/svet" && route.startsWith("/mapa/local/")) active = true;
      el.classList.toggle("active", active);
    });

    // Sync bottom nav active state
    document.querySelectorAll(".bottom-item[data-route]").forEach(el => {
      const r = el.dataset.route;
      el.classList.toggle("active",
        route === r || ("/" + route.split("/")[1]) === r || route.startsWith(r.replace(/^\//, "") + "/")
      );
    });

    const parts   = route.split("/").filter(Boolean);
    const section = parts[0] || "";
    // IDs saved via Store.generateId are ASCII, but legacy data may carry
    // diacritics (e.g. "chrám_chantone"). The browser percent-encodes them
    // in the hash, so decode before handing to renderers.
    const subRaw  = parts[1] || "";
    let sub;
    try { sub = decodeURIComponent(subRaw); } catch { sub = subRaw; }

    // Timeline — own top-level section (was nested under /mapa/casova-osa)
    if (section === "casova-osa") {
      Timeline.render();
      return;
    }

    // Maps — full-screen layout
    if (section === "mapa") {
      if (sub === "svet") {
        WorldMap.render(null);
      } else if (sub === "local") {
        // Local sub-map of a Location. Third path component is the
        // location id. Encoding it in the URL means an edit-mode
        // toggle (which dispatches a synthetic hashchange) preserves
        // the map context instead of dumping the user back to world.
        let locId = parts[2] || '';
        try { locId = decodeURIComponent(locId); } catch {}
        WorldMap.render(locId || null);
      } else if (sub === "palac" || sub === "frakce" || sub === "vztahy" || sub === "tajemstvi") {
        CloudMap.render(sub === "palac" ? "frakce" : sub);
      } else {
        CloudMap.render("frakce");
      }
      return;
    }

    // Ensure main content is visible
    const main = document.getElementById("main-content");
    if (main) main.style.display = "";

    switch (section) {
      case "":
      case "dashboard":
        Wiki.renderPage("dashboard"); break;
      case "parta":
        Wiki.renderPage("parta"); break;
      case "postavy":
        Wiki.renderPage("postavy"); break;
      case "postava":
        Wiki.renderPage("postava", sub); break;
      case "mista":
        Wiki.renderPage("mista"); break;
      case "misto":
        Wiki.renderPage("misto", sub); break;
      case "udalosti":
        window.location.hash = "#/casova-osa"; return;
      case "udalost":
        Wiki.renderPage("udalost", sub); break;
      case "zahady":
        Wiki.renderPage("zahady"); break;
      case "zahada":
        Wiki.renderPage("zahada", sub); break;
      case "frakce":
        if (sub) Wiki.renderPage("frakce-id", sub);
        else     Wiki.renderPage("frakce");
        break;
      case "mazlicci":
        Wiki.renderPage("mazlicci"); break;
      case "druhy":
        Wiki.renderPage("druhy"); break;
      case "druh":
        Wiki.renderPage("druh", sub); break;
      case "panteon":
        Wiki.renderPage("panteon"); break;
      case "buh":
        Wiki.renderPage("buh", sub); break;
      case "artefakty":
        Wiki.renderPage("artefakty"); break;
      case "artefakt":
        Wiki.renderPage("artefakt", sub); break;
      case "historie":
        Wiki.renderPage("historie"); break;
      case "historicka-udalost":
        Wiki.renderPage("historicka-udalost", sub); break;
      case "nastaveni":
        // Settings is reachable for any authenticated viewer — the
        // page itself routes role-aware: Account works for any role
        // (logout + role chip), Záloha shows read-only ops for non-DM
        // (download + create-snapshot), the enum-editor tabs render
        // for anyone but saves silently fail for non-DM (server-side
        // DM_ONLY_WRITE_TYPES gate). Anonymous visitors are caught
        // by the route guard at the top of navigate() and shown the
        // login modal instead.
        Settings.render(); break;
      case "dm":
        // DM-only section. The dashboard renderer short-circuits to
        // a "jen pro DM" stub if Role.isDM() is false; the sidebar
        // already hides the link for non-DM users.
        DmDashboard.render(); break;
      default:
        Wiki.renderPage("dashboard");
    }
  }

  // ── Collaborative sync via SSE ──────────────────────────────
  // Subscribe to /api/events; the server pushes a `data-changed` event
  // after every successful write and the client refetches + re-renders
  // in well under a second (no polling).
  //
  // If the user has unsaved edits in a form (`EditMode.isDirty()`) the
  // re-render is deferred and a banner appears — re-rendering would
  // replace the EasyMDE/CodeMirror DOM and silently destroy in-progress
  // text. The banner clears automatically once the user saves (which
  // fires `editmode:clean`) or they can dismiss/refresh on demand.
  let _lastHash    = null;
  let _pendingHash = null;   // latest hash seen while dirty; null = nothing pending
  let _es          = null;
  let _esRetryMs   = 1000;

  /**
   * Apply a remote `data-changed` notification: refetch the dataset, re-
   * apply sidebar visibility, and re-render the current route. Skipped
   * when `hash` matches the last-applied hash (a duplicate event).
   *
   * Special case: while the Settings page is mid-self-commit (slider
   * drag still in progress), we keep the data fresh but skip the
   * wholesale re-render so the slider DOM isn't torn out from under
   * the user. Genuine third-party edits during that ~1.5 s window get
   * one missed re-render at worst — the next change re-renders cleanly.
   *
   * @param {string|null} hash - Server-computed dataset hash, or null
   *                             to "refetch unconditionally".
   * @returns {Promise<void>}
   */
  async function _applyRemoteChange(hash) {
    // Skip only if we already have this exact hash; null means "unknown, refetch anyway"
    if (hash !== null && _lastHash !== null && hash === _lastHash) return;
    if (hash !== null) _lastHash = hash;
    await Store.load();
    Sidebar.render();
    Settings.applyBranding();
    _renderTopbarLogin();
    _renderImpersonationBanner();
    // Self-originated SSE echoes (e.g. the Mapy zoom-scale slider's
    // own PATCH) shouldn't replace the entire Settings DOM —
    // doing so kills any in-flight slider drag. The Settings module
    // sets `isPendingSelfCommit()` for ~1.5 s after committing
    // its own write; during that window we keep the data fresh
    // (`Store.load()` above) and update `_lastHash` (preventing
    // a queued duplicate from re-firing) but skip the wholesale
    // re-render. Genuine remote edits during the window get one
    // missed re-render at worst — the next remote change re-renders
    // normally.
    if (getRoute() === '/nastaveni' && Settings.isPendingSelfCommit?.()) return;
    // Don't wholesale-re-render (which rebuilds the settings page) while
    // the DM is mid-edit in the sidebar layout editor — it would yank
    // focus out of a label/icon input. The live sidebar already
    // refreshed via Sidebar.render() above; the editor re-renders itself
    // on each edit and on the next tab entry.
    const _ae = document.activeElement;
    if (_ae && _ae.closest && _ae.closest('#sidebar-layout-editor')) return;
    navigate(getRoute());
  }

  function _showRemoteBanner() {
    let banner = document.getElementById('remote-change-banner');
    if (banner) return;
    banner = document.createElement('div');
    banner.id = 'remote-change-banner';
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9998',
      'background:#3a4f6c', 'color:#fff', 'font-size:13px',
      'padding:8px 16px', 'text-align:center',
      'font-family:system-ui,sans-serif', 'letter-spacing:0.02em',
      'display:flex', 'align-items:center', 'justify-content:center', 'gap:12px',
    ].join(';');
    banner.innerHTML = `
      <span>📡 Někdo jiný upravil data. Tvoje rozepsané změny zatím nejsou ztracené.</span>
      <button type="button" id="remote-change-banner-refresh"
              style="background:#1a2738;color:#fff;border:1px solid #5a7090;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px">
        Načíst (zahodit moje změny)
      </button>
      <button type="button" id="remote-change-banner-dismiss"
              style="background:transparent;color:#fff;border:1px solid #5a7090;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px">
        Zavřít
      </button>
    `;
    document.body.prepend(banner);
    document.getElementById('remote-change-banner-refresh').addEventListener('click', () => {
      const h = _pendingHash;
      _pendingHash = null;
      banner.remove();
      _applyRemoteChange(h);
    });
    document.getElementById('remote-change-banner-dismiss').addEventListener('click', () => {
      _pendingHash = null;
      banner.remove();
    });
  }
  function _hideRemoteBanner() {
    document.getElementById('remote-change-banner')?.remove();
  }

  function _startSync() {
    try { _es?.close(); } catch (_) {}
    const es = new EventSource('/api/events');
    _es = es;

    es.addEventListener('hello', ev => {
      try {
        const { hash } = JSON.parse(ev.data);
        if (_lastHash === null) _lastHash = hash;
        _esRetryMs = 1000;  // reset backoff on successful connect
      } catch (_) {}
    });

    es.addEventListener('data-changed', ev => {
      let hash = null;
      try { hash = JSON.parse(ev.data).hash; } catch (_) {}
      if (EditMode.isDirty()) {
        _pendingHash = hash;
        _showRemoteBanner();
        return;
      }
      _applyRemoteChange(hash);
    });

    es.onerror = () => {
      // EventSource auto-reconnects, but if the server went away
      // cleanly (connection closed) it sometimes needs a manual kick.
      // Close + reopen with backoff up to 30 s.
      try { es.close(); } catch (_) {}
      _es = null;
      const delay = _esRetryMs;
      _esRetryMs = Math.min(_esRetryMs * 2, 30_000);
      setTimeout(_startSync, delay);
    };
  }

  // Once the active form is saved (or discarded), flush any deferred
  // remote change. This is what makes "save" feel responsive when
  // someone else just edited — no manual refresh needed.
  window.addEventListener('editmode:clean', () => {
    _hideRemoteBanner();
    if (_pendingHash !== null) {
      const h = _pendingHash;
      _pendingHash = null;
      _applyRemoteChange(h);
    }
  });

  // ── Init ────────────────────────────────────────────────────
  window.addEventListener("hashchange", () => navigate(getRoute()));

  // ── Server availability banner ──────────────────────────────
  // Shown when the server is unreachable at startup or a save fails mid-session.
  function _showServerBanner(msg) {
    let banner = document.getElementById("server-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "server-banner";
      banner.style.cssText = [
        "position:fixed", "top:0", "left:0", "right:0", "z-index:9999",
        "background:#8B0000", "color:#fff", "font-size:13px",
        "padding:8px 16px", "text-align:center",
        "font-family:system-ui,sans-serif", "letter-spacing:0.02em",
      ].join(";");
      document.body.prepend(banner);
    }
    banner.textContent = msg;
  }

  window.addEventListener("store:server-unavailable", () => {
    _showServerBanner("⚠ Server není dostupný — zobrazují se výchozí data. Změny nebudou uloženy.");
  });
  window.addEventListener("store:save-failed", () => {
    _showServerBanner("⚠ Uložení na server selhalo — zkontrolujte připojení a znovu načtěte stránku.");
  });

  // ── Top-right login chip ────────────────────────────────────
  // Floats top-right, but ONLY on the Přehled (dashboard) route AND
  // only when the visitor is anonymous. Everywhere else, login is
  // on-demand — clicking ✏ Úpravy or any per-entity edit affordance
  // triggers the same password prompt. Logout + role switching live
  // in Settings → Účet (so authed users have no persistent chrome).
  //
  // Called from `role:changed`, from `navigate()` (route changes
  // affect visibility), and from boot. The chip itself is a single
  // button — no role indicator, since the impersonation banner
  // handles that case and the rest is implicit (you're either logged
  // in and seeing edit affordances, or you aren't).
  function _renderTopbarLogin() {
    const route  = getRoute();
    const onDash = (route === '/' || route === '/dashboard');
    const show   = Role.isAnonymous() && onDash;

    let chip = document.getElementById('topbar-login');
    if (!show) {
      if (chip) chip.remove();
      return;
    }
    if (chip) return;  // already showing the right thing

    chip = document.createElement('button');
    chip.id   = 'topbar-login';
    chip.type = 'button';
    chip.className = 'topbar-login';
    chip.title = 'Přihlásit a začít editovat';
    chip.setAttribute('data-action', 'EditMode.promptLogin');
    chip.innerHTML = '<span class="topbar-login-icon">🔑</span> <span class="topbar-login-label">Přihlásit</span>';
    document.body.appendChild(chip);
  }

  function _renderImpersonationBanner() {
    let banner = document.getElementById('impersonation-banner');
    const impersonating = Role.isImpersonating();
    if (!impersonating) {
      if (banner) banner.remove();
      return;
    }
    if (banner) return; // already shown
    banner = document.createElement('div');
    banner.id = 'impersonation-banner';
    banner.className = 'impersonation-banner';
    banner.innerHTML = `
      <span>👁 Pohled hráče — DM obsah je skrytý. Tohle vidí hráči.</span>
      <button type="button" data-action="Role.backToDM">← Zpět na DM</button>
    `;
    document.body.prepend(banner);
  }

  // The dataset the client holds was fetched under the previous role.
  // After a role flip (login from editmode, view-as toggle, logout)
  // we must refetch the data and re-render so the new server-side
  // filter takes effect. Role.refresh fires `role:changed` whenever
  // its cached state actually changes, so this listener covers every
  // pathway in one place. Cosmetic UI (top-right login chip + the
  // impersonation banner) goes here too. The chip is re-rendered
  // again by navigate() so route changes affect its visibility, but
  // we also render here so login/logout transitions repaint without
  // waiting for the subsequent navigate.
  let _roleChangeInflight = false;
  window.addEventListener('role:changed', async () => {
    if (_roleChangeInflight) return;     // protect against re-entry while await Store.load() runs
    _roleChangeInflight = true;
    try {
      _renderTopbarLogin();
      _renderImpersonationBanner();
      await Store.load();
      Sidebar.render();
      Settings.applyBranding();
      navigate(getRoute());
    } finally {
      _roleChangeInflight = false;
    }
  });
  // Role.viewAsPlayer / backToDM / logout all internally call refresh
  // via dispatching `role:changed`. We don't need to wrap them — but
  // they do return new state directly, which keeps the data-action
  // call sites simple (`data-action="Role.viewAsPlayer"` just works).

  window.addEventListener("DOMContentLoaded", async () => {
    // Paint the sidebar immediately from the default layout (a constant,
    // needs no data) so there's no empty-sidebar flash; it re-renders
    // below once role + settings have loaded.
    Sidebar.render();
    // Resolve the caller's role first — render paths branch on
    // Role.isDM(), so body.is-dm must be stamped before the first paint.
    await Role.refresh();
    // Load data from server before first render. Whatever comes back
    // is already filtered for the caller's role.
    await Store.load();

    // Re-render the data-driven sidebar now that role + settings are
    // loaded (the early render above used the default layout).
    Sidebar.render();
    // Push the configured logo / wordmark / favicon onto the chrome.
    Settings.applyBranding();
    // Render the top-right login chip (anonymous + dashboard only)
    // and any impersonation banner once we know the role. navigate()
    // re-runs _renderTopbarLogin on every route change too.
    _renderTopbarLogin();
    _renderImpersonationBanner();

    // Remove loading screen
    const loading = document.getElementById("loading");
    if (loading) loading.remove();

    // Backup button is a plain <a href="/api/backup"> — no JS wiring needed.
    // It's only visible in edit mode (CSS .edit-only-btn).

    // Mobile map sheet
    const mapItems = document.querySelectorAll('.bottom-item[data-route="/mapa/frakce"]');
    mapItems.forEach(item => {
      item.addEventListener("click", e => {
        if (!getRoute().startsWith("/mapa")) { e.preventDefault(); showMapSheet(); }
      });
    });

    const backdrop = document.getElementById("map-backdrop");
    if (backdrop) backdrop.addEventListener("click", hideMapSheet);

    const sheet = document.getElementById("map-sheet");
    if (sheet) {
      sheet.querySelectorAll(".map-sheet-item").forEach(el =>
        el.addEventListener("click", () => hideMapSheet())
      );
    }

    navigate(getRoute());
    _startSync();
  });

  function showMapSheet() {
    document.getElementById("map-sheet"   )?.removeAttribute("hidden");
    document.getElementById("map-backdrop")?.removeAttribute("hidden");
  }
  function hideMapSheet() {
    document.getElementById("map-sheet"   )?.setAttribute("hidden", "");
    document.getElementById("map-backdrop")?.setAttribute("hidden", "");
  }

})();
