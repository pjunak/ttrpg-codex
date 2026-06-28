// ═══════════════════════════════════════════════════════════════
//  WIKI — renders entity articles + list/grid pages + dashboard.
//
//  Uses Store for all data. Edit affordances are per-page, not
//  globally toggled: each article uses `_editingArticle` (set via
//  the in-header ✏ Upravit button) to decide between read view and
//  editor render. List pages surface clickable `.edit-card-overlay`
//  pencils on each card + an always-visible "+ Přidat" button in
//  the toolbar. Dashboard hero fields get per-field pens.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { EditMode } from './editmode.js';
import { Role } from './role.js';
import { norm, esc, renderMarkdown, extractOutline, humanTime, dataAction, dataOn } from './utils.js';
import { PIN_TYPES, WorldMap } from './map.js';
import { Addons } from './addons.js';
import { relLabel } from './data.js';
import { PARTY_FACTION_ID } from './constants.js';
import { I18n } from './i18n.js';

export const Wiki = (() => {

  // Knowledge-level labels are UI chrome (the 0–4 SVG sketch tiers).
  // Built lazily at use time so a live language switch re-resolves them.
  const KNOWLEDGE_LABEL_KEYS = [
    'wiki.knowledge0', 'wiki.knowledge1', 'wiki.knowledge2',
    'wiki.knowledge3', 'wiki.knowledge4',
  ];
  function _knowledgeLabel(lvl) {
    const k = KNOWLEDGE_LABEL_KEYS[lvl];
    return k ? I18n.t(k) : '?';
  }

  // ── Current-article tracking (for the wiki-link resolver) ───────
  // Each renderXxxArticle calls _setCurrentArticle({type, id}) at the
  // top so the resolver in app.js can break twin-naming ties using
  // the current article's visibility space as the preferred polarity.
  // Players have nothing to disambiguate — they only see one side —
  // so this is mostly a DM concern.
  let _currentArticle = null;
  function _setCurrentArticle(ctx) {
    _currentArticle = ctx && ctx.type && ctx.id ? { type: ctx.type, id: ctx.id } : null;
  }
  function _getCurrentArticle() { return _currentArticle; }

  // Wiki route prefix per collection — used by the twin facts row
  // to build the cross-jump link AND by the per-article edit button
  // to construct the route Wiki._editingArticle compares against.
  // Mirrors KIND_ROUTE in app.js.
  const _TWIN_LINK_ROUTE = {
    characters:       'postava',
    locations:        'misto',
    events:           'udalost',
    mysteries:        'zahada',
    factions:         'frakce',
    species:          'druh',
    pantheon:         'buh',
    artifacts:        'artefakt',
    historicalEvents: 'historicka-udalost',
  };

  // ── Per-article edit state ─────────────────────────────────────
  // Replaces the global EditMode.isActive() check that used to drive
  // article-vs-editor render branching. `_editingArticle` holds the
  // hash route currently in editor mode (e.g. '/postava/foo'), or
  // null when nothing is being edited. The article shell and each
  // renderXxxArticle test against this; navigate() in app.js clears
  // it on route change via Wiki.syncEditRoute.
  //
  // No persistence — edit state is intentionally session-only and
  // single-route. Toggling on for a route triggers a re-render.
  let _editingArticle = null;
  function _isCurrentArticleEditing() {
    if (!_editingArticle) return false;
    // Defence in depth: if the viewer is anonymous, never render the
    // editor — even if `_editingArticle` is stale from a session
    // where the viewer was authed (e.g. they logged out via Settings
    // while still on the article route, so `syncEditRoute` saw a
    // route-match and didn't clear the state). The Save action would
    // 401 anyway, but seeing an editor you can't use is a UX glitch.
    if (Role.isAnonymous()) return false;
    return ('#' + _editingArticle) === window.location.hash;
  }
  /** Enter edit state for `route` (e.g. `/postava/foo`) and re-render.
   *  If the user is anonymous, defers to EditMode.promptLogin which
   *  surfaces the login modal — after success the user can click ✏
   *  again. (Auto-resuming the edit after login is a future polish;
   *  the immediate UX is one extra click that's worth it for the
   *  simplicity of not threading "pending intent" state through the
   *  login flow.) */
  function startEditingArticle(route) {
    if (Role.isAnonymous()) {
      EditMode.promptLogin();   // shows the password prompt; user retries after login
      return;
    }
    _editingArticle = route;
    const target = '#' + route;
    if (window.location.hash === target) {
      window.dispatchEvent(new Event('hashchange'));
    } else {
      window.location.hash = target;
    }
  }
  /** Cancel the in-flight edit and re-render the article view. Bound
   *  to the editor header's `← Zrušit` button (replaces the bare
   *  history.back() of the previous global-mode design). */
  function cancelEditingArticle() {
    if (EditMode.isDirty && EditMode.isDirty() &&
        !confirm(I18n.t('wiki.discardChangesConfirm'))) return;
    if (_editingArticle) {
      _editingArticle = null;
      window.dispatchEvent(new Event('hashchange'));
    } else {
      // No article-edit state (e.g. cancelling a "new" entity creation)
      // — defer to the browser back behaviour the old "← Zpět" had.
      history.back();
    }
  }
  /** Called from app.js's navigate() on every route change. Clears
   *  edit state when the user navigates AWAY from the edited article
   *  so a stale `_editingArticle` doesn't surprise the next render. */
  function syncEditRoute(route) {
    if (_editingArticle && _editingArticle !== route) {
      _editingArticle = null;
    }
  }
  // EditMode fires `editmode:clean` after every successful save (in
  // `_markClean`). That's our cue to exit edit state on whatever
  // article we were on: the post-save `_refreshTo(...)` then lands on
  // the same hash route and the renderer picks the article view
  // because `_editingArticle` is now null. Decoupled via a window
  // event so we don't introduce a wiki.js → editmode.js → wiki.js
  // circular import.
  window.addEventListener('editmode:clean', () => {
    _editingArticle = null;
  });
  // QA-row shape helpers — used by mystery question rendering AND
  // character "Otevřené otázky" rendering. Defensive against legacy
  // string entries that haven't been migrated yet.
  function _qaText(q)   { return (q && typeof q === 'object') ? (q.text   || '') : String(q || ''); }
  function _qaAnswer(q) { return (q && typeof q === 'object') ? (q.answer || '') : ''; }

  /** Build the "✏ Upravit" button HTML for an article header. Always
   *  emits the button — clicking it as an anonymous viewer surfaces
   *  the login modal via `Wiki.startEditingArticle` →
   *  `EditMode.promptLogin`. The route format must match what
   *  startEditingArticle expects so the data-action round-trips. */
  function _articleEditButton(collection, id) {
    const prefix = _TWIN_LINK_ROUTE[collection];
    if (!prefix) return '';
    const route = '/' + prefix + '/' + id;
    return `<button type="button" class="article-edit-btn"
      title="${esc(I18n.t('wiki.editThisRecord'))}"
      ${dataAction('Wiki.startEditingArticle', route)}>✏ ${esc(I18n.t('action.edit'))}</button>`;
  }

  /** Build a `facts` row entry showing the linked twin, when present
   *  and the viewer is DM. Returns '' for non-DM or when no twin is
   *  set, so the row vanishes naturally (the facts list filters
   *  empty values).
   *
   *  @param {string} collection
   *  @param {object} entity
   *  @returns {{label: string, value: string}|null}
   */
  function _twinFactRow(collection, entity) {
    if (!Role.isDM()) return null;
    if (!entity || !entity.linkedTwinId) return null;
    const twin = Store.getTwin ? Store.getTwin(collection, entity) : null;
    const route = _TWIN_LINK_ROUTE[collection];
    if (!route) return null;
    const twinName = twin ? twin.name : entity.linkedTwinId;
    const polarity = twin
      ? (twin.visibility === 'dm' ? I18n.t('wiki.twinDm') : I18n.t('wiki.twinPlayer'))
      : (entity.visibility === 'dm' ? I18n.t('wiki.twinPlayer') : I18n.t('wiki.twinDm')); // best-guess if twin missing
    return {
      label: '🔗 ' + I18n.t('wiki.twin'),
      value: `<a href="#/${route}/${esc(entity.linkedTwinId)}" data-twin="${esc(polarity)}">${esc(twinName)} (${esc(polarity)}) →</a>`,
    };
  }

  // ── List-view UI state (search + sort) ─────────────────────────
  // Persisted so SSE re-renders and navigation keep the user's filter.
  // Search is multi-chip via TagFilter: values[] AND-matched against
  // a per-entity text blob (name + tags + type + description + …).
  const LS_LIST_KEY = 'wiki_list_state_v1';
  const _defaultListState = {
    postavy: { values: [], sort: 'faction', faction: null, attitude: null },
    mista:   { values: [], sort: 'type',    attitude: null },
    frakce:  { values: [], sort: 'default' },
  };
  function _migrateSlot(def, raw) {
    const slot = { ...def, ...(raw || {}) };
    // Back-compat: old shape used a single `q` string.
    if (typeof slot.q === 'string' && !Array.isArray(slot.values)) {
      slot.values = slot.q ? [slot.q] : [];
    }
    delete slot.q;
    if (!Array.isArray(slot.values)) slot.values = [];
    return slot;
  }
  let _listState = (() => {
    try {
      const s = JSON.parse(localStorage.getItem(LS_LIST_KEY) || '{}');
      return {
        postavy: _migrateSlot(_defaultListState.postavy, s.postavy),
        mista:   _migrateSlot(_defaultListState.mista,   s.mista),
        frakce:  _migrateSlot(_defaultListState.frakce,  s.frakce),
      };
    } catch { return JSON.parse(JSON.stringify(_defaultListState)); }
  })();
  function _persistListState() {
    try { localStorage.setItem(LS_LIST_KEY, JSON.stringify(_listState)); } catch {}
  }

  // AND-match: every chip must be a substring of the normalized blob.
  function _matchAll(values, blob) {
    if (!values || !values.length) return true;
    const b = norm(blob || '');
    return values.every(v => {
      const n = norm(v);
      return n ? b.includes(n) : true;
    });
  }

  // ── Attitude glow helpers ──────────────────────────────────────
  // Entities with attitudes toward the party render a `filter:
  // drop-shadow(...)` halo around their icon (portrait / location-pin
  // emoji / faction badge / map-pin marker). Stacking one drop-shadow
  // per active attitude blends colors additively, so a place that's
  // 100% neutral + 50% dangerous gets a strong-blue / weak-red mixed
  // halo for free. Empty array = no filter at all = "unknown" baseline.
  // Faction inheritance (character with empty own-attitudes uses the
  // faction's attitudes) lives in Store.getEffectiveAttitudes.
  // Outer halo blur for attitude glow on cards / portraits / faction
  // badges. The renderer also stacks a tighter inner-blur layer per
  // attitude (≈40% of the outer radius) so 100% strength reads as a
  // confident glow rather than a washed-out haze; both layers scale
  // by the entry's strength so 50% still looks proportionally subtle.
  const GLOW_BLUR_PX = 10;
  function _attitudeColorMap() {
    const map = {};
    for (const a of Store.getEnum('attitudes') || []) {
      map[a.id] = a.labelColor || a.bg || '#888';
    }
    // Synthetic 'party' entry — sourced from settings.playerParty so
    // the party glow stays editable in one place even though the
    // attitudes enum no longer carries a `party` row.
    const pp = Store.getPlayerParty();
    if (pp && pp.color && !map.party) map.party = pp.color;
    return map;
  }
  function _hexToRgba(hex, alpha) {
    let h = String(hex || '').trim();
    if (h.startsWith('#')) h = h.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6) return `rgba(136,136,136,${alpha})`;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return `rgba(136,136,136,${alpha})`;
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  // Returns a CSS filter string or '' when no entry has positive
  // strength. Each active attitude contributes TWO stacked drop-
  // shadows: a wide outer halo + a tighter inner glow ≈40% of the
  // outer blur. The double layer makes strength=1.0 read as a
  // confident glow rather than a washed-out haze; alpha = strength
  // on both layers so 50% still looks proportionally subtle.
  // Strength is sourced from the `attitudes` settings enum
  // (per-attitude), NOT from each entity entry — see
  // `_migrateStrengthFromEntityToEnum` in store.js.
  function _attitudeGlow(entries, colors, blurPx = GLOW_BLUR_PX) {
    if (!Array.isArray(entries) || !entries.length) return '';
    const enums = Store.getEnum('attitudes') || [];
    const strengthByEnum = Object.fromEntries(
      enums.map(a => [a.id, (typeof a.strength === 'number') ? a.strength : 1.0])
    );
    const layers = [];
    const innerBlur = Math.max(2, Math.round(blurPx * 0.4));
    for (const e of entries) {
      if (!e || !e.id) continue;
      const color = colors[e.id];
      if (!color) continue;
      const s = strengthByEnum[e.id] ?? 1.0;
      if (s <= 0) continue;
      const rgba = _hexToRgba(color, s);
      layers.push(`drop-shadow(0 0 ${blurPx}px ${rgba})`);
      layers.push(`drop-shadow(0 0 ${innerBlur}px ${rgba})`);
    }
    return layers.join(' ');
  }

  // Shared toolbar: TagFilter (name + tags, unified) + sort <select>.
  // Re-renders only the matching grid-host div via the delegated
  // tf-change listener / Wiki.set<Kind>Sort, so focus never jumps.
  function _listToolbar(kind, sortOpts) {
    const s = _listState[kind];
    const opts = sortOpts.map(([v, label]) =>
      `<option value="${v}" ${s.sort===v?'selected':''}>${label}</option>`
    ).join('');
    const Name = kind[0].toUpperCase() + kind.slice(1);
    return `
      <div class="list-toolbar">
        <div class="tf-mount list-search-tf"
             data-tf-id="wl-${kind}-tf"
             data-tf-placeholder="🔍 ${esc(I18n.t('wiki.searchPlaceholder'))}"
             data-tf-hint="${esc(I18n.t('wiki.searchHint'))}"
             data-tf-value="${esc((s.values || []).join(','))}"
             data-wl-kind="${kind}"></div>
        <label class="list-sort">
          <span class="list-sort-label">${esc(I18n.t('wiki.sortLabel'))}</span>
          <select class="list-sort-select"${dataOn('change', `Wiki.set${Name}Sort`, '$value')}>
            ${opts}
          </select>
        </label>
      </div>`;
  }

  // One-shot delegated listener: every tf-mount inside a list toolbar
  // reports chip changes here, and we route to the matching grid refresh.
  document.addEventListener('tf-change', (ev) => {
    const el = ev.target;
    if (!el || !el.classList || !el.classList.contains('list-search-tf')) return;
    const kind = el.dataset.wlKind;
    if (!kind || !_listState[kind]) return;
    _listState[kind].values = Array.isArray(ev.detail?.values) ? [...ev.detail.values] : [];
    _persistListState();
    if (kind === 'postavy') { _refreshPostavyGrid(); _refreshPostavyCount(); }
    else if (kind === 'mista')   { _refreshMistaGrid();   _refreshMistaCount(); }
    else if (kind === 'frakce')  { _refreshFrakceGrid();  _refreshFrakceCount(); }
  });

  // Czech-aware name compare. Falls back to default locale if `cs` not supported.
  const _czCompare = (a, b) => String(a||'').localeCompare(String(b||''), 'cs');

  // Null-safe: renders an "unknown faction" chip when the id doesn't
  // resolve to any faction (e.g. a character referencing a deleted
  // faction, or a fresh install with no factions seeded yet).
  function factionBadge(factionId) {
    const factions = Store.getFactions();
    const f = factions[factionId] || factions.neutral;
    if (!f) {
      const label = factionId ? esc(factionId) : esc(I18n.t('wiki.noFaction'));
      return `<span class="badge badge-faction" style="background:#55555522;color:#999;border:1px solid #55555555">⚐ ${label}</span>`;
    }
    return `<span class="badge badge-faction" style="background:${f.color}22;color:${f.textColor};border:1px solid ${f.color}55">
      ${f.badge} ${esc(f.name)}</span>`;
  }

  function statusBadge(statusId) {
    const s = Store.getStatusMap()[statusId] || Store.getStatusMap().unknown;
    return `<span class="badge badge-status-${statusId}">${s.icon} ${s.label}</span>`;
  }

  function knowledgeBadge(lvl) {
    return `<span class="badge badge-knowledge">👁 ${esc(_knowledgeLabel(lvl))}</span>`;
  }

  function relationLabel(type) { return relLabel(type); }

  // ── Portrait wrapper (knowledge + dead overlay + attitude glow) ─
  // The optional `glowFilter` is a CSS `filter:` value built by
  // `_attitudeGlow(entries, colors)`. It's applied on the wrapper
  // (not the img) so it composes with the `[data-knowledge="N"]
  // .portrait-img { filter: url(#sketch-N) }` rule rather than
  // overriding it. Drop-shadow follows the alpha of whatever's inside
  // the wrapper, so the glow hugs the portrait silhouette.
  function portraitWrap(c, extraClass, glowFilter) {
    const factions  = Store.getFactions();
    const deadHtml  = c.status === "dead" ? `<div class="dead-overlay">💀</div>` : "";
    // Party PCs use the playerParty badge; others fall back to their
    // faction badge or a generic 👤.
    const placeholderBadge = c.faction === PARTY_FACTION_ID
      ? (Store.getPlayerParty().badge || Store.getPlayerParty().icon || '🛡')
      : (factions[c.faction]?.badge || "👤");
    const imgHtml   = c.portrait
      ? `<img class="portrait-img" src="${esc(c.portrait)}" alt="${esc(c.name)}" loading="lazy">`
      : `<div class="portrait-placeholder">${placeholderBadge}</div>`;
    const styleAttr = glowFilter ? ` style="filter: ${glowFilter}"` : '';
    return `<div class="portrait-wrap${extraClass ? " "+extraClass : ""}" data-knowledge="${c.knowledge}" data-status="${c.status}"${styleAttr}>
      ${imgHtml}${deadHtml}
    </div>`;
  }

  // ── Edit overlay on cards (only visible in edit mode) ─────────
  // Pencil overlay on entity cards. Was decorative (no click handler —
  // the parent `<a>` did all the navigation, and the overlay was hidden
  // outside global edit mode). Now a real edit affordance: clicking
  // routes through Wiki.startEditingArticle so the article opens
  // straight into the editor. The dispatcher's preventDefault on
  // non-anchor [data-action] elements stops the click from bubbling up
  // to the parent `<a>` and triggering a read-view navigation, so the
  // card body still navigates to read view (no preventDefault) and the
  // pencil opens the editor — two distinct click targets in one card.
  function editOverlay(href) {
    const route = String(href || '').replace(/^#/, '');
    return `<span class="edit-card-overlay" title="${esc(I18n.t('action.edit'))}" role="button"
      ${dataAction('Wiki.startEditingArticle', route)}>✏</span>`;
  }

  // ── Empty-state onboarding card ───────────────────────────────
  // Rendered on list pages when the underlying collection is truly
  // empty (not filtered-to-empty). Shows a big icon, a short prompt
  // explaining what this collection is for, and a primary CTA that
  // auto-enables edit mode if it isn't already on.
  function _renderEmptyState({ icon, title, description, ctaLabel, ctaHref, ctaActionAttr }) {
    const actionAttr = ctaActionAttr || '';
    const cta = (ctaHref || actionAttr) ? `
      <a class="empty-cta" href="${ctaHref || '#'}"${actionAttr}>＋ ${esc(ctaLabel || I18n.t('wiki.createFirst'))}</a>` : '';
    return `
      <div class="empty-state">
        <div class="empty-state-icon">${icon || '✦'}</div>
        <div class="empty-state-title">${esc(title || I18n.t('wiki.emptyDefault'))}</div>
        <div class="empty-state-desc">${esc(description || '')}</div>
        ${cta}
      </div>`;
  }

  // ── Article shell helper ─────────────────────────────────────
  // Single-column wiki layout: head panel (visual + identity +
  // badges + facts) at the top, then freeform `sections` (chips,
  // fact lists, link rows) above the markdown `body` article.
  //
  //   _articleShell({
  //     visual:   '<div class="portrait-wrap">…</div>' | '<div class="ah-icon">🛕</div>' | null,
  //     title:    'Frulam Mondath',
  //     subtitle: 'Velitelka — Fialový Háv',
  //     chips:    [factionBadgeHtml, statusBadgeHtml, ...],
  //     facts:    [{ label: 'Místo', value: '<a …>' }, …],
  //     sections: [{ title: 'Vazby', html: '<chips>' }, …],
  //     body:     '<div class="md-view">…</div>',   // narrative markdown
  //   })
  //
  // The body comes last, after the structured data, matching
  // wiki convention: facts up front, prose at the bottom.
  /**
   * Shared two-column layout used by every entity article (character,
   * location, event, mystery, faction, species, deity, artifact,
   * historical event). Renders a sticky left side-card with the
   * portrait + title + chips + facts + auto-generated outline, and a
   * main column holding `sections` followed by the markdown body.
   *
   * @param {object} opts
   * @param {string|null} [opts.visual]   - HTML for the side-card visual.
   * @param {string} [opts.title]
   * @param {string} [opts.subtitle]
   * @param {Array<string>} [opts.chips]  - Pre-rendered badge HTML strings.
   * @param {Array<{label:string,value:string}>} [opts.facts]
   * @param {Array<{title:string,html:string}>} [opts.sections]
   * @param {string} [opts.body]          - Pre-rendered markdown HTML.
   * @param {string} [opts.outlineSource] - Raw markdown for TOC extraction.
   * @param {boolean} [opts.back=true]
   * @returns {string} Complete article HTML.
   */
  function _articleShell({
    visual = null, title = '', subtitle = '',
    chips = [], facts = [], sections = [], body = '',
    outlineSource = '',
    back = true,
    editButton = '',
    kind = '', entity = null,
  }) {
    const chipsHtml = (chips || []).filter(Boolean).join('');
    const factsHtml = (facts || []).filter(f => f && f.value).map(f =>
      `<div class="ah-fact"><span class="ah-fact-label">${esc(f.label)}</span>${f.value}</div>`
    ).join('');
    // Main column as an ordered, NAMED fragment list (Phase 6) so addons can
    // replace / hide / wrap / insert individual pieces with conflict-safe
    // arbitration. Core sections + addon-added sections (Phase 4a, additive) +
    // the body each become a fragment with a stable id; `Addons.applyFragments`
    // applies override claims before we join. Empty fragments collapse. With no
    // override addons installed the pipeline is a pass-through (zero cost).
    const _sectionBlock = (title, html) =>
      `<div class="char-section"><div class="char-section-title">${esc(title)}</div>${html}</div>`;
    const _frags = [];
    (sections || []).filter(Boolean).forEach((s, i) => {
      _frags.push({
        id:   `${kind || 'x'}:section:${s.id || ('s' + i)}`,
        html: (s.html && s.html.trim()) ? _sectionBlock(s.title, s.html) : '',
      });
    });
    (kind ? Addons.articleSections(kind, entity) : []).forEach((s) => {
      _frags.push({
        // `s.seq` is the section's ordinal within its own addon — stable across
        // load order, so a cross-addon override claim on this fragment id holds.
        id:   `${kind}:addon:${s.addonId}:${s.seq}`,
        html: (s.html && s.html.trim()) ? _sectionBlock(s.title, s.html) : '',
      });
    });
    _frags.push({ id: `${kind || 'x'}:body`, html: body ? `<div class="article-body">${body}</div>` : '' });
    const mainHtml = (kind ? Addons.applyFragments(kind, _frags, entity) : _frags)
      .map(f => f.html).filter(Boolean).join('');

    const sideCard = `
      <div class="wiki-side-card">
        ${visual ? `<div class="ah-visual">${visual}</div>` : ''}
        <div class="ah-meta">
          <h1>${title}</h1>
          ${subtitle ? `<div class="ah-subtitle">${subtitle}</div>` : ''}
          ${chipsHtml ? `<div class="ah-chips">${chipsHtml}</div>` : ''}
          ${factsHtml ? `<div class="ah-facts">${factsHtml}</div>` : ''}
        </div>
      </div>`;

    // Auto-generated outline from markdown headings in the article body.
    // Hidden when empty so short articles don't get a stub box.
    const outline = outlineSource ? extractOutline(outlineSource) : [];
    const outlineHtml = outline.length ? `
      <nav class="wiki-outline" aria-label="${esc(I18n.t('wiki.outlineLabel'))}">
        <div class="wiki-outline-title">${esc(I18n.t('wiki.outlineTitle'))}</div>
        <ul>
          ${outline.map(h =>
            `<li data-lvl="${h.level}"><a href="#${h.slug}"${dataAction('scrollTo', h.slug)}>${esc(h.text)}</a></li>`
          ).join('')}
        </ul>
      </nav>` : '';

    // Action bar above the article: back on the left, ✏ Upravit on
    // the right (when the renderer provided one). Empty bar still
    // renders so the visual rhythm of the page header stays stable
    // across articles regardless of whether the viewer can edit.
    const actionBar = (back || editButton) ? `
      <div class="article-actions">
        ${back ? `<button type="button" class="back-btn"${dataAction('back')}>← ${esc(I18n.t('action.back'))}</button>` : ''}
        ${editButton || ''}
      </div>` : '';

    return `
      ${actionBar}
      <div class="wiki-article">
        <aside class="wiki-side">
          ${sideCard}
          ${outlineHtml}
        </aside>
        <div class="wiki-main">
          ${mainHtml}
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════
  //  PETS (Mazlíčci) — shared card + page + article section
  // ══════════════════════════════════════════════════════════════
  // A pet card is a button (pets have no detail page) that opens the
  // editor modal. Anonymous clicks surface the login modal inside
  // EditMode.openPetEditor, so the affordance stays discoverable.
  function _petCardHtml(pet, opts = {}) {
    const cls = opts.cls || 'pet-card';
    const visual = pet.portrait
      ? `<img class="pet-card-img" src="${esc(pet.portrait)}" alt="${esc(pet.name)}" loading="lazy">`
      : `<span class="pet-card-emoji">${esc(pet.icon || '🐾')}</span>`;
    const species = pet.species ? `<span class="pet-card-species">${esc(pet.species)}</span>` : '';
    return `
      <button type="button" class="${cls}" title="${esc(I18n.t('wiki.petEdit'))}"
        ${dataAction('EditMode.openPetEditor', pet.id)}>
        <span class="pet-card-portrait">${visual}</span>
        <span class="pet-card-name">${esc(pet.name)}</span>
        ${species}
      </button>`;
  }

  /** Article section `{title, html}` for a faction/character's pets, or
   *  null when that owner has none — pages stay pristine until a pet is
   *  assigned. When pets exist, authed viewers also get an inline
   *  "＋ Mazlíček" to add another to the same owner. */
  function _petsArticleSection(ownerType, ownerId) {
    const pets = Store.getPetsForOwner(ownerType, ownerId);
    if (!pets.length) return null;
    const cards = pets.map(p => _petCardHtml(p, { cls: 'pet-card' })).join('');
    const addBtn = !Role.isAnonymous()
      ? `<div class="inline-create-row"><button class="inline-create-btn"
           ${dataAction('EditMode.openPetEditor', null, { ownerType, ownerId })}>＋ ${esc(I18n.t('wiki.petAdd'))}</button></div>`
      : '';
    return { title: '🐾 ' + I18n.t('nav.pets'), html: `<div class="pet-grid">${cards}</div>${addBtn}` };
  }

  // The Mazlíčci hub — every pet grouped by owner. Creation lives here
  // (and inline on owner pages); the sidebar link is toggleable via
  // Settings → Postranní panel.
  function renderPetsList() {
    const pets = Store.getPets();
    const addAttr = dataAction('EditMode.openPetEditor', null, { ownerType: 'none' });
    if (!pets.length) {
      return `
        <div class="page-header" style="display:flex;align-items:center;gap:1rem">
          <div style="flex:1"><h1>🐾 ${esc(I18n.t('nav.pets'))}</h1></div>
          <button class="list-item-new" ${addAttr}>＋ ${esc(I18n.t('wiki.petAdd'))}</button>
        </div>
        ${_renderEmptyState({
          icon: '🐾',
          title: I18n.t('wiki.petsEmptyTitle'),
          description: I18n.t('wiki.petsEmptyDesc'),
          ctaLabel: I18n.t('wiki.petNew'),
          ctaActionAttr: addAttr,
        })}`;
    }
    // Bucket every pet by owner, stable order: unassigned → party →
    // factions → characters. A pet whose owner was deleted collapses
    // into the unassigned bucket (defensive; deletes already reassign).
    // The display label/icon comes from Store.getPetOwner.
    const ORDER = { none: 0, party: 1, faction: 2, character: 3 };
    const ownerKey = (pet) => {
      const ot = pet.ownerType || 'none';
      if (ot === 'party') return { key: 'party', order: ORDER.party };
      if (ot === 'faction'   && Store.getFaction(pet.ownerId))   return { key: 'f:' + pet.ownerId, order: ORDER.faction };
      if (ot === 'character' && Store.getCharacter(pet.ownerId)) return { key: 'c:' + pet.ownerId, order: ORDER.character };
      return { key: 'none', order: ORDER.none };
    };
    const groupMap = new Map();
    for (const pet of pets) {
      const { key, order } = ownerKey(pet);
      if (!groupMap.has(key)) {
        const o = Store.getPetOwner(pet);
        groupMap.set(key, { label: `${o.icon} ${o.label}`, order, pets: [] });
      }
      groupMap.get(key).pets.push(pet);
    }
    const groups = [...groupMap.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'cs'));
    const groupsHtml = groups.map(g => `
      <div class="pet-group">
        <h2 class="pet-group-head">${esc(g.label)} <span class="pet-group-count">${g.pets.length}</span></h2>
        <div class="pet-grid">${g.pets.map(p => _petCardHtml(p, { cls: 'pet-card' })).join('')}</div>
      </div>`).join('');
    return `
      <div class="page-header" style="display:flex;align-items:center;gap:1rem">
        <div style="flex:1">
          <h1>🐾 ${esc(I18n.t('nav.pets'))}</h1>
          <div class="subtitle">${esc(I18n.plural('pets.count', pets.length))}</div>
        </div>
        <button class="list-item-new" ${addAttr}>＋ ${esc(I18n.t('wiki.petAdd'))}</button>
      </div>
      ${groupsHtml}`;
  }

  // ══════════════════════════════════════════════════════════════
  //  DASHBOARD
  //  Layout: Hero (editable campaign name + tagline) → Naše parta
  //  (responsive portrait grid) → Poslední sezení (events from the
  //  latest sitting) → Otevřené záhady (top 3 unsolved by priority).
  // ══════════════════════════════════════════════════════════════
  const PRIORITY_ORDER = { 'kritická': 0, 'vysoká': 1, 'střední': 2, 'nízká': 3 };

  function renderDashboard() {
    const campaign = Store.getCampaign();
    const party    = Store.getPartyMembers();
    // Edit affordances render unconditionally — clicking one as an
    // anonymous viewer surfaces the login modal via EditMode.promptLogin
    // (each action handler checks Role.isAnonymous itself). Hiding them
    // would make the "you can edit this" affordance undiscoverable.
    return `
      ${_dashHeroHtml(campaign)}
      ${_dashPartyHtml(party)}
      ${_dashLastSessionHtml()}
      ${_dashMysteriesHtml()}
    `;
  }

  function _dashHeroHtml(campaign) {
    // Per-field inline edit. Each hero line carries data-on-blur and
    // data-on-keydown wiring at all times — the handlers only fire when
    // the element becomes focusable, which happens only via
    // Wiki.startInlineEdit (which prompts login for anonymous viewers).
    const fieldAttrs = (field) => `
      ${dataOn('blur', 'Wiki.commitInlineEdit', field, '$text', '$el')}
      ${dataOn('keydown', 'Wiki.handleInlineEditKey', '$ev', '$el')}`;
    const editPen = (elId, label) => `
      <button type="button" class="dash-hero-pen" title="${esc(label)}"
        ${dataAction('Wiki.startInlineEdit', elId)}>✏</button>`;
    return `
      <div class="dash-hero">
        <div class="dash-hero-row">
          <h1 class="dash-hero-name" id="dash-hero-name" ${fieldAttrs('name')}>${esc(campaign.name)}</h1>
          ${editPen('dash-hero-name', I18n.t('wiki.editCampaignName'))}
        </div>
        <div class="dash-hero-row">
          <div class="dash-hero-tagline" id="dash-hero-tagline"
            data-placeholder="${esc(I18n.t('wiki.campaignTaglinePlaceholder'))}" ${fieldAttrs('tagline')}>${esc(campaign.tagline || '')}</div>
          ${editPen('dash-hero-tagline', I18n.t('wiki.editCampaignTagline'))}
        </div>
      </div>`;
  }

  function _dashPartyHtml(party) {
    // Section header gets a "+ Přidat" button always — clicking it as
    // an anonymous viewer surfaces the login modal via
    // EditMode.startNewCharacter → promptLogin. The trailing dashed
    // card on the party grid is gone (matches the list-page pattern).
    const addBtn = `
      <button class="dash-section-action dash-section-add"
        ${dataAction('EditMode.startNewCharacter', { faction: PARTY_FACTION_ID, knowledge: 4, status: 'alive' })}
        title="${esc(I18n.t('wiki.addPartyCharacterTitle'))}">＋ ${esc(I18n.t('action.add'))}</button>`;
    if (!party.length) {
      return `
        <div class="dash-section">
          <div class="dash-section-head">
            <h2>🛡 ${esc(I18n.t('wiki.ourParty'))}</h2>
            ${addBtn}
          </div>
          <div class="dash-empty">
            ${I18n.t('wiki.partyEmptyDash')}
          </div>
        </div>`;
    }
    const locNameOf = (id) => {
      if (!id) return '';
      const l = Store.getLocation(id);
      return l ? l.name : '';
    };
    const partyColors = _attitudeColorMap();
    const cards = party.map(c => {
      const locName = locNameOf(c.location);
      const locChip = locName
        ? `<div class="dash-party-loc" title="${esc(I18n.t('wiki.currentPosition'))}">📍 ${esc(locName)}</div>`
        : '';
      const titleLine = c.title ? `<div class="dash-party-title">${esc(c.title)}</div>` : '';
      const statusDot = `<span class="dash-party-status" data-status="${esc(c.status||'alive')}"></span>`;
      const glow = _attitudeGlow(Store.getEffectiveAttitudes(c, 'character'), partyColors);
      return `
        <a class="dash-party-card" href="#/postava/${c.id}">
          <div class="dash-party-portrait">${portraitWrap(c, '', glow)}</div>
          <div class="dash-party-body">
            <div class="dash-party-name">${statusDot}${esc(c.name)}</div>
            ${titleLine}
            ${locChip}
          </div>
        </a>`;
    }).join('');
    const grid = `<div class="dash-party-grid">${cards}</div>`;
    // Party-owned pets flank the grid — first card on the right, then
    // alternating left/right. Nothing renders when there are none, so
    // the dashboard is byte-for-byte unchanged until a party pet exists.
    const partyPets = Store.getPetsForOwner('party');
    let partyBody = grid;
    if (partyPets.length) {
      const left = [], right = [];
      partyPets.forEach((p, i) => (i % 2 === 0 ? right : left).push(p));
      const col = (list) => list.map(p => _petCardHtml(p, { cls: 'dash-pet-card' })).join('');
      partyBody = `
        <div class="dash-party-flank">
          <div class="dash-pets-col dash-pets-left">${col(left)}</div>
          ${grid}
          <div class="dash-pets-col dash-pets-right">${col(right)}</div>
        </div>`;
    }
    return `
      <div class="dash-section">
        <div class="dash-section-head">
          <h2>🛡 ${esc(I18n.t('wiki.ourParty'))}</h2>
          <a class="dash-section-action" href="#/parta">${esc(I18n.t('wiki.wholeParty'))} →</a>
          ${addBtn}
        </div>
        ${partyBody}
      </div>`;
  }

  function _dashLastSessionHtml() {
    const events = Store.dedupeShadowTwins('events', Store.getEvents());
    const maxSitting = events.reduce((m, e) => Math.max(m, Number(e.sitting) || 0), 0);
    if (maxSitting === 0) {
      // Empty-state nudge is rendered for everyone (the link target —
      // the timeline — is a public page; we just lose the "you can
      // add events here" nudge for anonymous, which is a fine trade).
      if (!Role.isAnonymous()) return `
        <div class="dash-section">
          <div class="dash-section-head"><h2>🕯 ${esc(I18n.t('wiki.lastSession'))}</h2></div>
          <div class="dash-empty">${I18n.t('wiki.lastSessionEmpty')}</div>
        </div>`;
      return '';
    }
    const sessionEvents = events
      .filter(e => Number(e.sitting) === maxSitting)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!sessionEvents.length) return '';
    const items = sessionEvents.map(e => {
      const charCount = (e.characters || []).length;
      const locCount  = (e.locations  || []).length;
      const meta = [
        charCount ? `👤 ${charCount}` : '',
        locCount  ? `📍 ${locCount}`  : '',
      ].filter(Boolean).join(' · ');
      return `
        <a class="dash-event-row" href="#/udalost/${e.id}">
          <div class="dash-event-name">${esc(e.name)}</div>
          ${e.short ? `<div class="dash-event-short">${esc(e.short)}</div>` : ''}
          ${meta ? `<div class="dash-event-meta">${meta}</div>` : ''}
        </a>`;
    }).join('');
    return `
      <div class="dash-section">
        <div class="dash-section-head">
          <h2>🕯 ${esc(I18n.t('wiki.lastSession'))} <span class="dash-session-badge">${esc(I18n.t('wiki.sessionBadge', { n: maxSitting }))}</span></h2>
          <a class="dash-section-action" href="#/casova-osa">${esc(I18n.t('wiki.wholeTimeline'))} →</a>
        </div>
        <div class="dash-event-list">${items}</div>
      </div>`;
  }

  function _dashMysteriesHtml() {
    const unsolved = Store.dedupeShadowTwins('mysteries', Store.getMysteries())
      .filter(m => !m.solved)
      .sort((a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)
        || _czCompare(a.name, b.name));
    if (!unsolved.length) return '';
    const top = unsolved.slice(0, 3);
    const items = top.map(m => {
      const prio = m.priority
        ? `<span class="mystery-priority priority-${esc(m.priority)}">${esc(m.priority.toUpperCase())}</span>`
        : '';
      // Surface the first OPEN question (or fall back to the first
      // entry if none are open, so a fully-solved mystery still shows
      // a hint of what it was about).
      const firstOpen = (Array.isArray(m.questions) ? m.questions : [])
        .find(q => !Store.isQuestionAnswered(q));
      const firstQ = firstOpen || (Array.isArray(m.questions) ? m.questions[0] : null);
      const questions = firstQ
        ? `<div class="dash-mystery-q">${esc(Store.questionText(firstQ))}</div>` : '';
      return `
        <a class="dash-mystery-row" href="#/zahada/${m.id}">
          <div class="dash-mystery-name">❓ ${esc(m.name)}</div>
          ${prio}
          ${questions}
        </a>`;
    }).join('');
    return `
      <div class="dash-section">
        <div class="dash-section-head">
          <h2>🗝 ${esc(I18n.t('wiki.openMysteries'))}</h2>
          <a class="dash-section-action" href="#/zahady">${esc(I18n.t('wiki.allMysteries'))} →</a>
        </div>
        <div class="dash-mystery-list">${items}</div>
      </div>`;
  }

  // Persist a single campaign field when the user blurs an editable
  /**
   * Persist a single campaign-metadata field (`name` or `tagline`) edited
   * inline from the dashboard hero. Bound to each contenteditable's
   * `onblur`. The server is idempotent so a no-op edit is harmless.
   *
   * @param {string} field - `'name'` or `'tagline'`.
   * @param {string} value
   */
  function saveCampaignField(field, value) {
    if (typeof field !== 'string' || !field) return;
    const patch = {};
    patch[field] = typeof value === 'string' ? value : '';
    Store.setCampaign(patch);
  }

  // ── Inline-edit helpers (dashboard hero campaign name + tagline) ──
  // Each editable field starts read-only. The pen icon next to it
  // calls `Wiki.startInlineEdit(elId)` which flips `contenteditable`
  // on and focuses. Blur commits via `commitInlineEdit` (wired through
  // the standard data-on-blur dispatcher). Esc cancels via
  // `handleInlineEditKey`. Replaces the global-edit-mode-driven
  // "everything in the hero is contenteditable" pattern.
  /**
   * Make the element with id `elId` editable + focus it. Anonymous
   * viewers see the pen icon too — clicking it surfaces the login
   * modal; after login the user clicks the pen again. Auto-resume
   * isn't wired because the cost (threading "pending intent" through
   * the login flow) outweighs one extra click.
   *
   * @param {string} elId
   */
  function startInlineEdit(elId) {
    if (Role.isAnonymous()) { EditMode.promptLogin(); return; }
    const el = document.getElementById(elId);
    if (!el) return;
    // Stash the pre-edit text so Esc can revert without round-tripping
    // through Store.setCampaign.
    el._inlineOriginal = el.textContent || '';
    el.setAttribute('contenteditable', 'plaintext-only');
    el.classList.add('is-editing-inline');
    el.focus();
    // Place caret at end of existing text (default focus selects all,
    // which is annoying when you want to append).
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }
  /** Persist the edited field and exit inline-edit state. Bound to each
   *  field's `data-on-blur` handler so a click outside or Enter (which
   *  blurs via `handleInlineEditKey`) commits. */
  function commitInlineEdit(field, value, el) {
    if (el && el.removeAttribute) {
      el.removeAttribute('contenteditable');
      el.classList.remove('is-editing-inline');
    }
    saveCampaignField(field, value);
  }
  /** Enter commits (by blurring), Escape reverts to the stashed
   *  original and blurs. Bound to each editable field via data-on-keydown. */
  function handleInlineEditKey(ev, el) {
    if (!ev || !el) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      el.blur();    // fires data-on-blur → commitInlineEdit
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      el.textContent = el._inlineOriginal || '';
      el.removeAttribute('contenteditable');
      el.classList.remove('is-editing-inline');
      el.blur();
    }
  }

  // Dashboard "Poslední úpravy" — top 5 most-recently edited entities
  // across every collection. Returns empty string if nothing has been
  // edited yet (i.e. fresh install with no updatedAt stamps anywhere).
  function _recentActivityBlock() {
    const items = Store.getRecentActivity(5);
    if (!items.length) return '';
    const ICONS = {
      postava:'👤', misto:'📍', udalost:'⏳', zahada:'❓',
      druh:'🧬', buh:'✨', artefakt:'🗝', frakce:'⬡',
    };
    const rows = items.map(it => `
      <a class="activity-row" href="${it.route === '#/frakce' ? '#/frakce/' + it.id : it.route + '/' + it.id}">
        <span class="activity-icon">${ICONS[it.kind] || '•'}</span>
        <span class="activity-name">${esc(it.name || it.id)}</span>
        <span class="activity-time">${esc(humanTime(it.updatedAt))}</span>
      </a>`).join('');
    return `
      <div class="dash-section-title" style="margin-top:2rem">${esc(I18n.t('wiki.recentEdits'))}</div>
      <div class="activity-list">${rows}</div>
    `;
  }

  // ══════════════════════════════════════════════════════════════
  //  CHARACTER LIST
  // ══════════════════════════════════════════════════════════════
  // Party sits first in the faction-sort order so PCs show up at the
  // top of the default grouped view. Subsequent ids mirror the rough
  // narrative arc of the current campaign.
  const FACTION_ORDER = [PARTY_FACTION_ID, "cult_high","cult_red","dragon","greenest","neutral","mystery"];
  const STATUS_ORDER  = { alive: 0, unknown: 1, dead: 2 };

  // Apply current search + sort to the character list. `filterFaction` is
  // the faction filter-bar selection (orthogonal to text search).
  function _postavyApply(filterFaction) {
    const s = _listState.postavy;
    // /postavy is the NPC roster — PCs live on the dashboard's "Naše
    // parta" strip and at /parta. Filter via Store.getNPCs(). The
    // dedupe step drops a public twin when its DM twin is also in
    // the list so each twin pair appears once.
    let chars = Store.dedupeShadowTwins('characters', Store.getNPCs());
    if (s.values && s.values.length) {
      chars = chars.filter(c => _matchAll(s.values,
        `${c.name||''} ${c.title||''} ${(c.tags||[]).join(' ')} ${c.description||''} ${c.species||''} ${c.gender||''}`));
    }
    if (filterFaction) chars = chars.filter(c => c.faction === filterFaction);
    if (s.attitude) {
      const a = s.attitude;
      chars = chars.filter(c =>
        Store.getEffectiveAttitudes(c, 'character').some(e => e.id === a));
    }
    chars = [...chars];
    switch (s.sort) {
      case 'name':
        chars.sort((a, b) => _czCompare(a.name, b.name));
        break;
      case 'status':
        chars.sort((a, b) =>
          (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
          || _czCompare(a.name, b.name));
        break;
      case 'knowledge':
        chars.sort((a, b) =>
          (b.knowledge ?? 0) - (a.knowledge ?? 0) || _czCompare(a.name, b.name));
        break;
      case 'faction':
      default:
        chars.sort((a, b) => {
          const ai = FACTION_ORDER.indexOf(a.faction);
          const bi = FACTION_ORDER.indexOf(b.faction);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
            || _czCompare(a.name, b.name);
        });
    }
    return chars;
  }

  function _postavyGridHtml(filterFaction) {
    const chars = _postavyApply(filterFaction);
    const s = _listState.postavy;
    // The trailing dashed "+ Nová postava" card used to live here, gated
    // by global edit mode. With per-page edit-mode removed, the create
    // affordance moved to the page-header "+ Přidat postavu" button —
    // visible to anyone who can edit (i.e. not anonymous).
    const newCard = "";
    const emptyMsg = chars.length === 0
      ? `<div class="list-empty">${esc(I18n.t('wiki.charNoMatch'))}</div>` : "";

    // Group by faction when the default grouped-sort is active and no
    // single-faction filter is pinned. All other sorts render a flat
    // grid (grouping would fight the intent of those sort orders).
    const grouped = (s.sort === 'faction') && !filterFaction && chars.length > 0;
    if (grouped) {
      const factions = Store.getFactions();
      const byFac = new Map();
      for (const c of chars) {
        const k = c.faction || '__nofac__';
        if (!byFac.has(k)) byFac.set(k, []);
        byFac.get(k).push(c);
      }
      const orderedKeys = [
        ...FACTION_ORDER.filter(id => byFac.has(id)),
        ...[...byFac.keys()].filter(k => !FACTION_ORDER.includes(k)),
      ];
      const sections = orderedKeys.map(fid => {
        const list = byFac.get(fid) || [];
        const f = factions[fid];
        let label;
        if (fid === PARTY_FACTION_ID) {
          const pp = Store.getPlayerParty();
          label = `${pp.badge || pp.icon || '🛡'} ${pp.name || I18n.t('wiki.ourParty')}`;
        } else if (f) {
          label = `${f.badge || '⬡'} ${f.name}`;
        } else if (fid === '__nofac__') {
          label = I18n.t('wiki.noFaction');
        } else if (fid === 'neutral') {
          label = '👤 ' + I18n.t('wiki.neutral');
        } else {
          label = fid;
        }
        return `
          <div class="list-group">
            <div class="list-group-title">${esc(label)} <span class="list-group-count">${list.length}</span></div>
            <div class="char-grid">${list.map(renderCharacterCard).join('')}</div>
          </div>`;
      }).join('');
      return `${sections}${newCard ? `<div class="char-grid">${newCard}</div>` : ''}${emptyMsg}`;
    }

    return `<div class="char-grid">${chars.map(renderCharacterCard).join("")}${newCard}${emptyMsg}</div>`;
  }

  function renderCharacterList(filterFaction) {
    // Preserve the previously-active faction filter when the caller
    // omits one (avoids tab-reset on sort change). Passing 'all' explicitly
    // clears it.
    if (filterFaction === 'all') filterFaction = null;
    if (filterFaction === undefined) filterFaction = _listState.postavy.faction || null;
    _listState.postavy.faction = filterFaction || null;
    _persistListState();

    const factions = Store.getFactions();
    const allChars = Store.getNPCs();

    // Truly-empty collection (not just filtered) → onboarding card.
    if (allChars.length === 0) {
      return `
        <div class="page-header"><h1>${esc(I18n.t('nav.characters'))}</h1></div>
        ${_renderEmptyState({
          icon: '👤',
          title: I18n.t('wiki.charEmptyTitle'),
          description: I18n.t('wiki.charEmptyDesc'),
          ctaLabel: I18n.t('wiki.charNew'), ctaHref: '#/postava/new',
        })}`;
    }

    // Faction filter chips. PCs are excluded from `allChars` (see above),
    // so the `party` chip naturally drops out via the count-0 guard.
    const factionFilters = Object.entries(factions).map(([id, f]) => {
      const count = allChars.filter(c => c.faction === id).length;
      if (count === 0) return "";
      return `<button class="filter-btn ${filterFaction === id ? "active" : ""}"
        ${dataAction('Wiki.renderPage', 'postavy', id)}>${f.badge} ${esc(f.name)} (${count})</button>`;
    }).join("");

    // Attitude filter chips — slice by stance toward the party. Counts
    // include faction-inherited stances (Store.getEffectiveAttitudes),
    // so a member of an `enemy` faction with empty own-attitudes shows
    // up under the Nepřítel filter without any explicit per-character
    // attitude. Party PCs always carry an effective `party` entry.
    const attEnum = Store.getEnum('attitudes') || [];
    const activeAtt = _listState.postavy.attitude || null;
    const attFilters = attEnum.map(a => {
      const n = allChars.filter(c =>
        Store.getEffectiveAttitudes(c, 'character').some(e => e.id === a.id)
      ).length;
      if (n === 0) return "";
      const color = a.labelColor || a.bg || '#888';
      return `<button class="filter-btn filter-btn-attitude ${activeAtt === a.id ? 'active' : ''}"
        style="--attitude-color: ${esc(color)}"
        ${dataAction('Wiki.setPostavyAttitude', a.id)}>●&nbsp;${esc(a.label)} (${n})</button>`;
    }).filter(Boolean).join('');

    const shown = _postavyApply(filterFaction);

    // "+ Nová postava" is always rendered. Anonymous click → login modal
    // via the renderer's short-circuit on `id === "new"` → editor save
    // gating in the action handlers.
    const newBtn = `
      <a href="#/postava/new" class="list-item-new" style="text-decoration:none">＋ ${esc(I18n.t('wiki.charNew'))}</a>`;

    return `
      <div class="page-header" style="display:flex;align-items:center;gap:1rem">
        <div style="flex:1">
          <h1>${esc(I18n.t('nav.characters'))}</h1>
          <div class="subtitle">${esc(I18n.t('wiki.recordsCount', { shown: shown.length, total: allChars.length }))}${filterFaction ? " · " + factions[filterFaction]?.name : ""}${activeAtt ? " · " + esc(attEnum.find(a=>a.id===activeAtt)?.label || activeAtt) : ""}</div>
        </div>
        ${newBtn}
      </div>
      <div class="filter-bar">
        <button class="filter-btn ${!filterFaction ? "active" : ""}"${dataAction('Wiki.renderPage', 'postavy', 'all')}>${esc(I18n.t('wiki.filterAll'))}</button>
        ${factionFilters}
      </div>
      ${attFilters ? `<div class="filter-bar filter-bar-attitudes">
        <button class="filter-btn ${!activeAtt ? 'active' : ''}"${dataAction('Wiki.setPostavyAttitude', '')}>${esc(I18n.t('wiki.attitudeAny'))}</button>
        ${attFilters}
      </div>` : ''}
      ${_listToolbar('postavy', [
        ['faction',   I18n.t('wiki.sortFactionGrouped')],
        ['name',      I18n.t('wiki.sortNameAsc')],
        ['status',    I18n.t('wiki.sortStatus')],
        ['knowledge', I18n.t('wiki.sortKnowledge')],
      ])}
      <div id="wl-postavy-grid">${_postavyGridHtml(filterFaction)}</div>
    `;
  }

  /**
   * Replace the Postavy list filter chips. Accepts an array of strings
   * (the canonical TagFilter shape) or a single string (treated as a
   * one-chip filter — easier when called from inline HTML).
   *
   * @param {string|string[]} v
   */
  function setPostavySearch(v) {
    const arr = Array.isArray(v) ? v : (v ? [String(v)] : []);
    _listState.postavy.values = arr;
    _persistListState();
    _refreshPostavyGrid();
    _refreshPostavyCount();
  }
  function setPostavySort(v) {
    _listState.postavy.sort = v || 'faction';
    _persistListState();
    _refreshPostavyGrid();
  }
  function setPostavyAttitude(v) {
    _listState.postavy.attitude = v || null;
    _persistListState();
    // Re-render the whole page so attitude chip highlights + subtitle update.
    Wiki.renderPage('postavy', _listState.postavy.faction || 'all');
  }
  function _refreshPostavyGrid() {
    const host = document.getElementById('wl-postavy-grid');
    if (host) host.innerHTML = _postavyGridHtml(_listState.postavy.faction);
  }
  function _refreshPostavyCount() {
    const total = Store.getCharacters().length;
    const shown = _postavyApply(_listState.postavy.faction).length;
    const sub = document.querySelector('.page-header .subtitle');
    if (!sub) return;
    const f = _listState.postavy.faction;
    const fLabel = f ? " · " + (Store.getFactions()[f]?.name || '') : "";
    sub.textContent = `${I18n.t('wiki.recordsCount', { shown, total })}${fLabel}`;
  }

  function renderCharacterCard(c) {
    // Always emit — the overlay is hidden for anonymous viewers via CSS
    // (body.is-anonymous .edit-card-overlay { display: none }) and
    // gently visible on hover for authed viewers. Click routes through
    // Wiki.startEditingArticle to open the editor for this entity only.
    const overlay = editOverlay(`#/postava/${c.id}`);
    const colors  = _attitudeColorMap();
    const entries = Store.getEffectiveAttitudes(c, 'character');
    const glow    = _attitudeGlow(entries, colors);
    const twinMark = _twinCardMarker(c);
    return `
      <a class="char-card" href="#/postava/${c.id}">
        ${portraitWrap(c, '', glow)}
        ${overlay}
        ${twinMark}
        <div class="char-card-info">
          <div class="char-card-name">${c.knowledge >= 1 ? esc(c.name) : "???"}</div>
          <div class="char-card-title">${c.knowledge >= 2 ? esc(c.title) : esc(I18n.t('wiki.unknownTitle'))}</div>
          <div class="char-card-badges">${statusBadge(c.status)}</div>
        </div>
      </a>
    `;
  }

  /** Small "🔗 twin" badge for cards whose entity is the surviving
   *  half of a twin pair. Empty string when entity has no linkedTwinId.
   *  CSS hides for non-DM viewers because the twin is irrelevant to
   *  them (they only ever see the public half anyway). */
  function _twinCardMarker(entity) {
    if (!entity || !entity.linkedTwinId) return '';
    return `<span class="card-twin-marker" title="${esc(I18n.t('wiki.twinMarkerTitle'))}">🔗</span>`;
  }

  // ══════════════════════════════════════════════════════════════
  //  CHARACTER ARTICLE
  // ══════════════════════════════════════════════════════════════
  function renderCharacterArticle(id) {
    if (id === "new") return EditMode.renderCharacterEditor(null);
    const c = Store.getCharacter(id);
    if (!c) return `<p>${esc(I18n.t('wiki.charNotFound', { id }))}</p>`;
    if (_isCurrentArticleEditing()) return EditMode.renderCharacterEditor(c);

    // ── View mode ────────────────────────────────────────────────
    const rels   = Store.getRelationships().filter(r => r.source === id || r.target === id);
    const chars  = Store.getCharacters();
    const events = Store.getEvents();

    const eventsInvolved = events.filter(e => (e.characters||[]).includes(id));

    // Profile chips: species/gender/age — only render if present and the
    // viewer knows enough about the character to see physical details.
    const profileBits = [];
    if (c.knowledge >= 2 && c.species) {
      const sp = Store.getSpeciesItem(c.species);
      const label = sp ? sp.name : c.species;
      profileBits.push(`<span class="profile-chip">🧬 ${esc(label)}</span>`);
    }
    if (c.knowledge >= 2 && c.gender) profileBits.push(`<span class="profile-chip">⚥ ${esc(c.gender)}</span>`);
    if (c.knowledge >= 2 && c.age)    profileBits.push(`<span class="profile-chip">⌛ ${esc(c.age)}</span>`);

    const locationLink = c.location ? (() => {
      const loc = Store.getLocation(c.location);
      return loc ? `<a href="#/misto/${loc.id}">📍 ${esc(loc.name)}</a>` : '';
    })() : '';

    const rankInfo = (() => {
      if (!c.rankChain || !c.rank) return '';
      const f = Store.getFaction(c.faction);
      const chain = (f?.rankChains || []).find(ch => ch.id === c.rankChain);
      if (!chain) return '';
      const idx = chain.ranks.indexOf(c.rank);
      return `${esc(chain.name)} — ${esc(c.rank)}${idx >= 0 ? ` (${idx + 1}/${chain.ranks.length})` : ''}`;
    })();

    const facts = [
      { label: I18n.t('wiki.factPlace'),         value: locationLink || '' },
      { label: I18n.t('wiki.factCircumstances'), value: (c.knowledge >= 2 && c.circumstances) ? esc(c.circumstances) : '' },
      { label: I18n.t('wiki.factRank'),          value: rankInfo },
      _twinFactRow('characters', c),
    ].filter(Boolean);

    _setCurrentArticle({ type: 'characters', id });

    const body = c.knowledge >= 2
      ? `<div class="md-view">${renderMarkdown(c.description)}</div>`
      : `<em>${esc(I18n.t('wiki.charLittleKnown'))}</em>`;

    // Attitude chips: one per active attitude (own or inherited from
    // faction). Strength % is shown when ≠ 100%. Party PCs always
    // carry the implicit `party` chip via getEffectiveAttitudes.
    let attitudeChips = '';
    const articleEntries = Store.getEffectiveAttitudes(c, 'character');
    if (c.knowledge >= 2) {
      const attEnum = Store.getEnum('attitudes') || [];
      attitudeChips = articleEntries.map(e => {
        const def = attEnum.find(a => a.id === e.id);
        if (!def) return '';
        const color = def.labelColor || def.bg || '#888';
        // Strength now lives on the enum item itself, not the entry.
        const s = (typeof def.strength === 'number') ? def.strength : 1.0;
        const pct = s === 1.0 ? '' : ` ${Math.round(s * 100)}%`;
        return `<span class="badge badge-attitude"
          style="background:${esc(color)}22;color:${esc(color)};border:1px solid ${esc(color)}66">●&nbsp;${esc(def.label)}${esc(pct)}</span>`;
      }).filter(Boolean).join(' ');
    }
    const articleGlow = _attitudeGlow(articleEntries, _attitudeColorMap());

    return _articleShell({
      editButton: _articleEditButton('characters', id),
      visual:   portraitWrap(c, '', articleGlow),
      title:    c.knowledge >= 1 ? esc(c.name) : esc(I18n.t('wiki.unknownCharacter')),
      subtitle: c.knowledge >= 2 && c.title ? esc(c.title) : '',
      chips:    [
        factionBadge(c.faction),
        attitudeChips,
        statusBadge(c.status),
        knowledgeBadge(c.knowledge),
        ...profileBits,
      ].filter(Boolean),
      facts,
      sections: [
        { id: 'vazby',    title: I18n.t('wiki.sectionRelations'),     html: rels.length          ? _relChipsHtml(rels, id, chars) : '' },
        { id: 'udalosti', title: I18n.t('wiki.sectionEventMentions'), html: eventsInvolved.length ? _eventListHtml(eventsInvolved) : '' },
        { id: 'znalosti', title: I18n.t('wiki.sectionKnown'),         html: (c.knowledge >= 2 && (c.known||[]).length)
                                                ? _factListHtml(c.known, 'fact-item')   : '' },
        { id: 'otazky',   title: I18n.t('wiki.sectionOpenQuestions'), html: _qaListHtmlSplit(c.unknown || []) },
        (() => { const ps = _petsArticleSection('character', id); return ps ? { id: 'mazlicci', ...ps } : null; })(),
      ],
      body,
      outlineSource: c.knowledge >= 2 ? c.description : '',
      kind: 'characters', entity: c,
    });
  }

  // Tiny formatter helpers used by the article shell above.
  function _relChipsHtml(rels, selfId, chars) {
    return `<div class="relation-chips">${rels.map(r => {
      const otherId = r.source === selfId ? r.target : r.source;
      const other   = chars.find(ch => ch.id === otherId);
      if (!other) return '';
      const dir = r.source === selfId ? '→' : '←';
      return `<a class="relation-chip" href="#/postava/${otherId}">
        <span>${esc(other.name)}</span>
        <span class="chip-label">${dir} ${esc(r.label || relationLabel(r.type))}</span>
      </a>`;
    }).join('')}</div>`;
  }
  function _eventListHtml(events) {
    return `<div class="fact-list">${events.map(e =>
      `<div class="fact-item"><a class="wiki-link" href="#/udalost/${e.id}">${esc(e.name)}</a>${e.short ? ` — ${esc(e.short)}` : ''}</div>`
    ).join('')}</div>`;
  }
  function _factListHtml(items, rowClass) {
    return `<div class="fact-list">${items.map(it =>
      `<div class="${rowClass}">${esc(it)}</div>`
    ).join('')}</div>`;
  }
  // Render a {text, answer} list for character "Otevřené otázky" /
  // mystery "Otázky" — splits the array into open vs answered and
  // renders each segment with its own row style. Returns '' if both
  // segments are empty (so the article-shell collapses the section).
  function _qaListHtmlSplit(items) {
    const arr = Array.isArray(items) ? items : [];
    if (!arr.length) return '';
    const open   = arr.filter(q => !Store.isQuestionAnswered(q));
    const closed = arr.filter(Store.isQuestionAnswered);
    if (!open.length && !closed.length) return '';
    const openHtml = open.length
      ? `<div class="fact-list">${open.map(q =>
          `<div class="unknown-item">${esc(_qaText(q))}</div>`).join('')}</div>`
      : '';
    const closedHtml = closed.length
      ? `<div class="fact-list">${closed.map(q => `
          <div class="qa-solved">
            <div class="qa-solved-q">✓ ${esc(_qaText(q))}</div>
            <div class="qa-solved-a">${esc(_qaAnswer(q))}</div>
          </div>`).join('')}</div>`
      : '';
    return openHtml + closedHtml;
  }

  // ══════════════════════════════════════════════════════════════
  //  LOCATION LIST & ARTICLE
  // ══════════════════════════════════════════════════════════════
  function _mistaApply() {
    const s = _listState.mista;
    let locs = Store.dedupeShadowTwins('locations', Store.getLocations());
    if (s.values && s.values.length) {
      locs = locs.filter(l => _matchAll(s.values,
        `${l.name||''} ${l.type||''} ${l.region||''} ${(l.tags||[]).join(' ')} ${l.description||''}`));
    }
    if (s.attitude) {
      locs = locs.filter(l =>
        Store.getEffectiveAttitudes(l, 'location').some(e => e.id === s.attitude));
    }
    locs = [...locs];
    switch (s.sort) {
      case 'type':
        locs.sort((a, b) => _czCompare(a.type, b.type) || _czCompare(a.name, b.name));
        break;
      case 'knowledge':
        locs.sort((a, b) =>
          (b.knowledge ?? 0) - (a.knowledge ?? 0) || _czCompare(a.name, b.name));
        break;
      case 'name':
      default:
        locs.sort((a, b) => _czCompare(a.name, b.name));
    }
    return locs;
  }

  function _renderLocCard(l, colors) {
    const pt = PIN_TYPES[l.pinType] || PIN_TYPES.custom || { icon: '📍', color: '#888' };
    const typeLabel = pt.label || l.type || '';
    const region = l.region ? `<div class="loc-card-sub">${esc(l.region)}</div>` : '';
    const editBtn = editOverlay(`#/misto/${l.id}`);
    // Glow follows the icon silhouette — drop-shadow blurs the alpha
    // channel of `.loc-card-icon`'s content so thin strokes get the
    // same halo as the bulk. Multiple attitudes layer additively.
    const glow = _attitudeGlow(Store.getEffectiveAttitudes(l, 'location'), colors);
    // Prefer a real artwork SVG (user-uploaded or bundled default)
    // over the emoji glyph, mirroring the map marker rendering.
    const iconUrl = WorldMap.resolveIconForLocation(l);
    const iconInner = iconUrl
      ? `<img class="loc-card-icon-img" src="${esc(iconUrl)}" alt="" ${dataOn('error', 'hide', '$el')}>`
      : esc(pt.icon);
    const iconStyle = glow
      ? `color:${pt.color};filter:${glow}`
      : `color:${pt.color}`;
    return `<a class="loc-card" href="#/misto/${l.id}" style="text-decoration:none;position:relative">
      ${editBtn}
      ${_twinCardMarker(l)}
      <div class="loc-card-icon" style="${iconStyle}">${iconInner}</div>
      <div class="loc-card-body">
        <div class="loc-card-name">${esc(l.name)}</div>
        <div class="loc-card-type">${esc(typeLabel)}</div>
        ${region}
      </div>
    </a>`;
  }

  function _mistaGridHtml() {
    const locs = _mistaApply();
    const s = _listState.mista;
    const colors = _attitudeColorMap();
    // Dashed "+ Nové místo" trailing card removed — the create
    // affordance is now the always-visible "+ Nové místo" button in
    // the page header (renderMistaList above). Kept the variable so
    // the appended-grid-string templates below stay identical and
    // we can collapse the markup in a follow-up pass.
    const newCard = "";

    if (locs.length === 0) {
      return `<div class="loc-grid"><div class="list-empty">${esc(I18n.t('wiki.locNoMatch'))}</div>${newCard}</div>`;
    }

    // Group by pinType when the default grouped-sort is active.
    // Group order follows the pinType's default `size` (bigger first
    // = more prominent place types head the page), with an "Ostatní"
    // bucket pinned to the end. Falls back to PIN_TYPES constant when
    // settings hasn't been edited.
    if (s.sort === 'type') {
      const pinEnum = Store.getEnum('pinTypes') || [];
      const sizeMap = new Map(pinEnum.map(p => [p.id, Number(p.size) || 0]));
      const byType = new Map();
      for (const l of locs) {
        const k = l.pinType || '__other__';
        if (!byType.has(k)) byType.set(k, []);
        byType.get(k).push(l);
      }
      const keys = [...byType.keys()];
      keys.sort((a, b) => {
        if (a === '__other__') return 1;
        if (b === '__other__') return -1;
        const sa = sizeMap.get(a) ?? (PIN_TYPES[a]?.size ?? 28);
        const sb = sizeMap.get(b) ?? (PIN_TYPES[b]?.size ?? 28);
        if (sa !== sb) return sb - sa;  // bigger size first
        const la = (PIN_TYPES[a]?.label) || a;
        const lb = (PIN_TYPES[b]?.label) || b;
        return _czCompare(la, lb);
      });
      const sections = keys.map(k => {
        const def = k === '__other__'
          ? { icon: '📦', label: I18n.t('wiki.locGroupOther') }
          : (PIN_TYPES[k] || { icon: '📍', label: k });
        const list = byType.get(k);
        return `
          <div class="list-group">
            <div class="list-group-title">${def.icon} ${esc(def.label)} <span class="list-group-count">${list.length}</span></div>
            <div class="loc-grid">${list.map(l => _renderLocCard(l, colors)).join('')}</div>
          </div>`;
      }).join('');
      return `${sections}${newCard ? `<div class="loc-grid">${newCard}</div>` : ''}`;
    }

    return `<div class="loc-grid">${locs.map(l => _renderLocCard(l, colors)).join('')}${newCard}</div>`;
  }

  function renderLocationList() {
    const total = Store.getLocations().length;
    const shown = _mistaApply().length;
    if (total === 0) {
      return `
        <div class="page-header"><h1>${esc(I18n.t('nav.locations'))}</h1></div>
        ${_renderEmptyState({
          icon: '📍',
          title: I18n.t('wiki.locEmptyTitle'),
          description: I18n.t('wiki.locEmptyDesc'),
          ctaLabel: I18n.t('wiki.locNew'), ctaHref: '#/misto/new',
        })}`;
    }
    // "+ Nové místo" — always rendered (anonymous click prompts login
    // via the editor's save handler).
    const newBtn = `
      <a href="#/misto/new" class="list-item-new" style="text-decoration:none">＋ ${esc(I18n.t('wiki.locNew'))}</a>`;

    // Attitude chip filter — same pattern as /postavy. Counts use
    // getEffectiveAttitudes so the filter agrees with what the cards
    // actually render (locations always use their own array; this is
    // really just a defensive equivalence).
    const attEnum = Store.getEnum('attitudes') || [];
    const activeAtt = _listState.mista.attitude || null;
    const allLocs = Store.getLocations();
    const attFilters = attEnum.map(a => {
      const count = allLocs.filter(l =>
        Store.getEffectiveAttitudes(l, 'location').some(e => e.id === a.id)
      ).length;
      if (count === 0) return '';
      const color = a.labelColor || a.bg || '#888';
      return `<button class="filter-btn filter-btn-attitude ${activeAtt === a.id ? 'active' : ''}"
        style="--attitude-color: ${esc(color)}"
        ${dataAction('Wiki.setMistaAttitude', a.id)}>●&nbsp;${esc(a.label)} (${count})</button>`;
    }).filter(Boolean).join('');

    return `
      <div class="page-header" style="display:flex;align-items:center;gap:1rem">
        <div style="flex:1">
          <h1>${esc(I18n.t('nav.locations'))}</h1>
          <div class="subtitle">${esc(I18n.t('wiki.locationsCount', { shown, total }))}${activeAtt ? " · " + esc(attEnum.find(a=>a.id===activeAtt)?.label || activeAtt) : ""}</div>
        </div>
        ${newBtn}
      </div>
      ${attFilters ? `<div class="filter-bar filter-bar-attitudes">
        <button class="filter-btn ${!activeAtt ? 'active' : ''}"${dataAction('Wiki.setMistaAttitude', '')}>${esc(I18n.t('wiki.attitudeAny'))}</button>
        ${attFilters}
      </div>` : ''}
      ${_listToolbar('mista', [
        ['type',      I18n.t('wiki.sortTypeGrouped')],
        ['name',      I18n.t('wiki.sortNameAsc')],
        ['knowledge', I18n.t('wiki.sortKnowledge')],
      ])}
      <div id="wl-mista-grid">${_mistaGridHtml()}</div>
    `;
  }

  function setMistaSearch(v) {
    const arr = Array.isArray(v) ? v : (v ? [String(v)] : []);
    _listState.mista.values = arr;
    _persistListState();
    _refreshMistaGrid();
    _refreshMistaCount();
  }
  function setMistaSort(v) {
    _listState.mista.sort = v || 'type';
    _persistListState();
    _refreshMistaGrid();
  }
  function setMistaAttitude(v) {
    _listState.mista.attitude = v || null;
    _persistListState();
    Wiki.renderPage('mista');
  }
  function _refreshMistaGrid() {
    const host = document.getElementById('wl-mista-grid');
    if (host) host.innerHTML = _mistaGridHtml();
  }
  function _refreshMistaCount() {
    const sub = document.querySelector('.page-header .subtitle');
    if (!sub) return;
    const total = Store.getLocations().length;
    const shown = _mistaApply().length;
    sub.textContent = I18n.t('wiki.locationsCount', { shown, total });
  }

  function renderLocationArticle(id) {
    if (id === "new") return EditMode.renderLocationEditor(null);
    const l = Store.getLocation(id);
    if (!l) return `<p>${esc(I18n.t('wiki.locNotFound', { id }))}</p>`;
    if (_isCurrentArticleEditing()) return EditMode.renderLocationEditor(l);

    const factions = Store.getFactions();
    const pp = Store.getPlayerParty();
    const chars = Store.getCharactersInLocation(id).map(c => {
      const badge = c.faction === PARTY_FACTION_ID
        ? (pp.badge || pp.icon || '🛡')
        : (factions[c.faction]?.badge || "👤");
      return `<a class="relation-chip" href="#/postava/${c.id}">${badge} ${esc(c.name)}</a>`;
    }).join("");

    // Hierarchy: ancestor breadcrumb + sub-locations.
    const ancestors = Store.getAncestorLocations(id).reverse();
    const breadcrumb = ancestors.length ? `
      <div class="location-breadcrumb">
        ${ancestors.map(a => `<a href="#/misto/${a.id}">📍 ${esc(a.name)}</a>`).join(' › ')}
        <span> › <strong>${esc(l.name)}</strong></span>
      </div>` : '';

    const subs = Store.getSubLocations(id);
    const subChips = subs.length ? `<div class="relation-chips">${subs.map(s => {
      const onMap = (typeof s.x === 'number' && typeof s.y === 'number');
      const dot = onMap ? '📍' : '·';
      return `<a class="relation-chip" href="#/misto/${s.id}">${dot} ${esc(s.name)}</a>`;
    }).join('')}</div>` : '';

    // World-map / local-map entry points.
    const placed = (typeof l.x === 'number' && typeof l.y === 'number');
    const mapButtons = [];
    if (placed) {
      mapButtons.push(
        `<button class="inline-create-btn"${dataAction('WorldMap.showPin', l.id)}>🧭 ${esc(I18n.t('wiki.findOnMap'))}</button>`
      );
    } else {
      // "📍 Umístit na mapu" — always rendered. WorldMap.startPlacingPin
      // checks Role.isAnonymous and prompts login if needed.
      mapButtons.push(
        `<button class="inline-create-btn"${dataAction('WorldMap.startPlacingPin', l.id)}>📍 ${esc(I18n.t('wiki.placeOnMap'))}</button>`
      );
    }
    if (l.localMap) {
      // Direct hash navigation — `#/mapa/local/<id>` routes via app.js
      // straight to WorldMap.render(parentId), so no deferred action
      // needed. Encoding parentId in the URL also keeps an edit-mode
      // toggle (synthetic hashchange) on the same sub-map.
      mapButtons.push(
        `<a class="inline-create-btn" href="#/mapa/local/${encodeURIComponent(l.id)}">🗺 ${esc(I18n.t('wiki.openLocalMap'))}</a>`
      );
    }
    const mapRow = mapButtons.length
      ? `<div class="inline-create-row">${mapButtons.join('')}</div>` : '';

    // Inline create affordances on the location article — let any
    // viewer spin up a character / event / sub-location pre-linked to
    // this place. Anonymous click → login modal via the action handlers.
    const inlineCreate = `
      <div class="inline-create-row">
        <button class="inline-create-btn"${dataAction('EditMode.startNewCharacterInLocation', l.id)}>＋ ${esc(I18n.t('wiki.characterHere'))}</button>
        <button class="inline-create-btn"${dataAction('EditMode.startNewEvent', { locations: [l.id] })}>＋ ${esc(I18n.t('wiki.eventHere'))}</button>
        <button class="inline-create-btn"${dataAction('EditMode.startNewLocation', { parentId: l.id })}>＋ ${esc(I18n.t('wiki.subLocation'))}</button>
      </div>`;

    const pt = PIN_TYPES[l.pinType] || PIN_TYPES.custom || { icon: '📍', label: l.type || '' };
    const chips = [];
    if (placed)     chips.push(`<span class="profile-chip">📍 ${esc(I18n.t('wiki.chipOnMap'))}</span>`);
    if (l.localMap) chips.push(`<span class="profile-chip">🗺 ${esc(I18n.t('wiki.chipLocalMap'))}</span>`);
    if (typeof l.knowledge === 'number') chips.push(knowledgeBadge(l.knowledge));

    // Attitude chips on the location article — one per active attitude
    // with strength % when ≠ 100.
    const locColors  = _attitudeColorMap();
    const locEntries = Store.getEffectiveAttitudes(l, 'location');
    const locAttEnum = Store.getEnum('attitudes') || [];
    for (const e of locEntries) {
      const def = locAttEnum.find(a => a.id === e.id);
      if (!def) continue;
      const color = def.labelColor || def.bg || '#888';
      const s = (typeof def.strength === 'number') ? def.strength : 1.0;
      const pct = s === 1.0 ? '' : ` ${Math.round(s * 100)}%`;
      chips.push(`<span class="badge badge-attitude"
        style="background:${esc(color)}22;color:${esc(color)};border:1px solid ${esc(color)}66">●&nbsp;${esc(def.label)}${esc(pct)}</span>`);
    }
    const locGlow = _attitudeGlow(locEntries, locColors);

    const events = Store.getEventsAtLocation(l.id) || [];

    // Prefer a real artwork SVG (user-uploaded or bundled default)
    // over the emoji glyph; matches the map markers + loc-card grid.
    const articleIconUrl = WorldMap.resolveIconForLocation(l);
    const articleIconInner = articleIconUrl
      ? `<img class="ah-icon-img" src="${esc(articleIconUrl)}" alt="" ${dataOn('error', 'hide', '$el')}>`
      : esc(pt.icon);
    _setCurrentArticle({ type: 'locations', id });
    return _articleShell({
      editButton: _articleEditButton('locations', id),
      visual:   `<div class="ah-icon"${locGlow ? ` style="filter:${locGlow}"` : ''}>${articleIconInner}</div>`,
      title:    esc(l.name),
      subtitle: esc(l.type || ''),
      chips,
      facts: [
        { label: I18n.t('wiki.factRegion'),       value: l.region ? esc(l.region) : '' },
        { label: I18n.t('wiki.factParentPlace'),  value: ancestors.length
                                           ? ancestors.map(a => `<a href="#/misto/${a.id}">📍 ${esc(a.name)}</a>`).join(' › ')
                                           : '' },
        _twinFactRow('locations', l),
      ].filter(Boolean),
      sections: [
        { title: I18n.t('wiki.sectionMap'),             html: mapRow },
        { title: I18n.t('wiki.sectionSubLocations'),    html: subChips },
        { title: I18n.t('wiki.sectionPresentChars'),    html: chars ? `<div class="relation-chips">${chars}</div>` : '' },
        { title: I18n.t('wiki.sectionEventsHere'),      html: events.length
          ? `<div class="fact-list">${events.map(e =>
              `<div class="fact-item"><a class="wiki-link" href="#/udalost/${e.id}">${esc(e.name)}</a>${e.short ? ` — ${esc(e.short)}` : ''}</div>`
            ).join('')}</div>`
          : '' },
        { title: '',                 html: inlineCreate },
      ],
      body: `
        ${breadcrumb}
        <div class="md-view">${renderMarkdown(l.description)}</div>
        ${l.notes ? `<div class="location-note md-view">${renderMarkdown(l.notes)}</div>` : ''}
      `,
      outlineSource: l.description || '',
      kind: 'locations', entity: l,
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  EVENT ARTICLE (list view lives under /casova-osa)
  // ══════════════════════════════════════════════════════════════
  function renderEventArticle(id) {
    if (id === "new") return EditMode.renderEventEditor(null);
    const e = Store.getEvent(id);
    if (!e) return `<p>${esc(I18n.t('wiki.eventNotFound', { id }))}</p>`;
    if (_isCurrentArticleEditing()) return EditMode.renderEventEditor(e);

    const chars = (e.characters || []).map(cid => {
      const c = Store.getCharacter(cid);
      return c ? `<a class="relation-chip" href="#/postava/${cid}">${esc(c.name)}</a>` : "";
    }).join("");

    const locs = (e.locations || []).map(lid => {
      const l = Store.getLocation(lid);
      return l ? `<a class="relation-chip" href="#/misto/${lid}">📍 ${esc(l.name)}</a>` : "";
    }).join("");

    const sittingLabel = e.sitting ? I18n.t('wiki.sessionBadge', { n: e.sitting }) : I18n.t('wiki.distantPast');
    const chips = [];
    if (e.priority) chips.push(`<span class="mystery-priority priority-${e.priority}">${e.priority.toUpperCase()}</span>`);
    if ((e.tags || []).length) {
      e.tags.forEach(t => chips.push(`<span class="profile-chip">${esc(t)}</span>`));
    }

    _setCurrentArticle({ type: 'events', id });
    return _articleShell({
      editButton: _articleEditButton('events', id),
      visual: null,
      title: esc(e.name),
      subtitle: sittingLabel,
      chips,
      facts: [
        { label: I18n.t('wiki.factDate'), value: e.date ? esc(e.date) : '' },
        _twinFactRow('events', e),
      ].filter(Boolean),
      sections: [
        { title: I18n.t('wiki.sectionInvolvedChars'), html: chars ? `<div class="relation-chips">${chars}</div>` : '' },
        { title: I18n.t('nav.locations'),             html: locs  ? `<div class="relation-chips">${locs}</div>`  : '' },
      ],
      outlineSource: e.description || '',
      kind: 'events', entity: e,
      body: `
        ${e.short ? `<div class="location-note md-view">${esc(e.short)}</div>` : ''}
        <div class="md-view">${renderMarkdown(e.description)}</div>
      `,
    });
  }

  // ── Aggregate "Všechny otevřené otázky" view ─────────────────
  // Flat list of every open question across all mysteries. Live
  // filtering on a plain input — diacritic-insensitive substring
  // match on the question text OR the parent mystery's name. State
  // is read at render time from `_zahadyQuestionFilter` so an SSE
  // re-render preserves the user's filter.
  let _zahadyQuestionFilter = '';
  function setZahadyQuestionFilter(value) {
    _zahadyQuestionFilter = String(value || '');
    const root = document.getElementById('zahady-questions-list');
    if (root) root.innerHTML = _openQuestionsRowsHtml();
  }
  // Per-source route prefix + display icon — used by the aggregate
  // questions row template. Centralised so adding a third question
  // source later (e.g. event open threads) is a one-place change.
  const _OQ_SOURCES = {
    mystery:   { route: 'zahada',  icon: '❓' },
    character: { route: 'postava', icon: '👤' },
  };
  function _openQuestionsRowsHtml() {
    const q = norm(_zahadyQuestionFilter);
    const rows = Store.getOpenQuestions()
      .map(item => ({
        ...item,
        // Build the search blob over both fields so chip filters hit
        // either the question text OR the parent entity's name.
        blob: norm((item.text || '') + ' ' + (item.sourceEntity?.name || '')),
      }))
      .filter(item => !q || item.blob.includes(q));
    if (!rows.length) {
      return `<div class="list-empty">${esc(_zahadyQuestionFilter
        ? I18n.t('wiki.openQNoMatch')
        : I18n.t('wiki.openQAllSolved'))}</div>`;
    }
    return rows.map(item => {
      const cfg     = _OQ_SOURCES[item.source] || _OQ_SOURCES.mystery;
      const entity  = item.sourceEntity || {};
      const route   = `/${cfg.route}/${entity.id}`;
      // Priority badge only applies to mystery-origin rows; characters
      // have no priority field. Empty for characters.
      const prioBadge = (item.source === 'mystery' && entity.priority)
        ? `<span class="mystery-priority priority-${esc(entity.priority)}">${esc(entity.priority)}</span>`
        : '';
      // Per-row edit pencil — opens the source entity straight into
      // its editor via the same affordance used by card pencils
      // (Wiki.startEditingArticle handles anonymous → login modal).
      const editBtn = `<button type="button" class="oq-edit"
        title="${esc(item.source === 'character' ? I18n.t('wiki.editCharacter') : I18n.t('wiki.editMystery'))}"
        ${dataAction('Wiki.startEditingArticle', route)}>✏</button>`;
      return `
        <div class="oq-row" data-source="${esc(item.source)}">
          <div class="oq-text">${esc(item.text)}</div>
          <a class="oq-mystery" href="#${route}">
            ${cfg.icon} ${esc(entity.name || entity.id || '—')}
            ${prioBadge}
          </a>
          ${editBtn}
        </div>`;
    }).join('');
  }
  function _openQuestionsBlock() {
    const total = Store.getOpenQuestions().length;
    if (total === 0) return '';
    return `
      <details class="oq-block" open>
        <summary class="oq-summary">
          <span class="oq-summary-label">📋 ${esc(I18n.t('wiki.allOpenQuestions'))}</span>
          <span class="oq-summary-count">${total}</span>
        </summary>
        <div class="oq-toolbar">
          <input type="search" class="edit-input oq-search"
            placeholder="🔍 ${esc(I18n.t('wiki.openQSearchPlaceholder'))}"
            value="${esc(_zahadyQuestionFilter)}"
            ${dataOn('input', 'Wiki.setZahadyQuestionFilter', '$value')}>
        </div>
        <div class="oq-list" id="zahady-questions-list">${_openQuestionsRowsHtml()}</div>
      </details>`;
  }

  // ══════════════════════════════════════════════════════════════
  //  MYSTERIES LIST + ALL-OPEN-QUESTIONS view
  // ══════════════════════════════════════════════════════════════
  // Listed first: every mystery card (existing layout). Then below,
  // a flat list of every open question across all mysteries with
  // TagFilter search — answers the user's "convenient search for all
  // questions" need without making the cards harder to scan.
  function renderMysteries() {
    const mysteries = Store.dedupeShadowTwins('mysteries', Store.getMysteries());
    // If there are no mysteries AND no open character questions either,
    // show the onboarding card. Open character questions alone should
    // still surface the aggregate block so they're discoverable from
    // /zahady (the user can navigate to the character to answer them).
    const openQs = Store.getOpenQuestions();
    if (mysteries.length === 0 && openQs.length === 0) {
      return `
        <div class="page-header"><h1>❓ ${esc(I18n.t('nav.mysteries'))}</h1></div>
        ${_renderEmptyState({
          icon: '❓',
          title: I18n.t('wiki.mysteryEmptyTitle'),
          description: I18n.t('wiki.mysteryEmptyDesc'),
          ctaLabel: I18n.t('wiki.mysteryNew'), ctaHref: '#/zahada/new',
        })}`;
    }
    const sorted = [...mysteries].sort((a,b) => {
      const order = { kritická: 0, vysoká: 1, střední: 2 };
      return (order[a.priority] || 9) - (order[b.priority] || 9);
    });
    const unsolvedCount = mysteries.filter(m => !Store.isMysterySolved(m)).length;

    const newBtn = `
      <a href="#/zahada/new" class="list-item-new" style="text-decoration:none">＋ ${esc(I18n.t('wiki.mysteryNew'))}</a>`;

    return `
      <div class="page-header" style="display:flex;align-items:center;gap:1rem">
        <div style="flex:1">
          <h1>❓ ${esc(I18n.t('wiki.mysteriesHeader'))}</h1>
          <div class="subtitle">${esc(I18n.t('wiki.mysteriesUnsolvedCount', { unsolved: unsolvedCount, total: mysteries.length }))}</div>
        </div>
        ${newBtn}
      </div>
      <div class="mystery-list">
        ${_openQuestionsBlock()}
        ${sorted.map(m => {
          const editBtn = editOverlay(`#/zahada/${m.id}`);
          const openCnt  = (m.questions || []).filter(q => !Store.isQuestionAnswered(q)).length;
          const totalCnt = (m.questions || []).length;
          const solved   = Store.isMysterySolved(m);
          const qBadge   = totalCnt > 0
            ? `<span class="mystery-qcount" title="${esc(I18n.t('wiki.openQuestionsOfTotal'))}">${esc(I18n.t('wiki.questionsCount', { open: openCnt, total: totalCnt }))}</span>`
            : '';
          const solvedBadge = solved ? `<span class="profile-chip" style="margin-left:0.4rem">✓ ${esc(I18n.t('wiki.solved'))}</span>` : '';
          // Card body is a <div> (can't be an <a> because it nests
          // relation-chips which are themselves <a>). Title becomes a
          // wiki-link so the user can still click into the detail page.
          return `<div class="mystery-card">
            <div class="mystery-name" style="display:flex;align-items:center;justify-content:space-between;gap:0.4rem">
              <a href="#/zahada/${m.id}" style="text-decoration:none;color:inherit">❓ ${esc(m.name)} ${_twinCardMarker(m)}${solvedBadge}</a>
              ${editBtn}
            </div>
            <div class="mystery-priority priority-${m.priority}">${esc(I18n.t('wiki.priorityLabel'))}: ${m.priority.toUpperCase()} ${qBadge}</div>
            <div class="mystery-desc md-view" style="margin-top:0.5rem">${renderMarkdown(m.description)}</div>
            ${(m.characters||[]).length ? `
              <div style="margin-top:0.75rem">
                <div class="char-section-title" style="font-size:0.7rem;margin-bottom:0.4rem">${esc(I18n.t('wiki.linkedCharsUpper'))}</div>
                <div class="relation-chips">
                  ${m.characters.map(cid => {
                    const c = Store.getCharacter(cid);
                    return c ? `<a class="relation-chip" href="#/postava/${cid}">${esc(c.name)}</a>` : "";
                  }).join("")}
                </div>
              </div>` : ""}
          </div>`;
        }).join("")}
      </div>
    `;
  }

  // ══════════════════════════════════════════════════════════════
  //  MYSTERY DETAIL / EDIT (route: #/zahada/{id})
  // ══════════════════════════════════════════════════════════════
  function renderMysteryArticle(id) {
    if (id === "new") return EditMode.renderMysteryEditor(null);
    const m = Store.getMystery(id);
    if (!m) return `<p>${esc(I18n.t('wiki.mysteryNotFound', { id }))}</p>`;
    if (_isCurrentArticleEditing()) return EditMode.renderMysteryEditor(m);

    const charChips = (m.characters || []).map(cid => {
      const c = Store.getCharacter(cid);
      return c ? `<a class="relation-chip" href="#/postava/${cid}">${esc(c.name)}</a>` : '';
    }).join('');

    // Split questions into open vs answered. `_qaText` / `_qaAnswer`
    // handle both the legacy string shape and the {text, answer}
    // object shape; the migration on load normalises everything to
    // objects, so legacy handling is defence-in-depth.
    const allQs = Array.isArray(m.questions) ? m.questions : [];
    const openQs    = allQs.filter(q => !Store.isQuestionAnswered(q));
    const solvedQs  = allQs.filter(Store.isQuestionAnswered);
    const solvedAll = Store.isMysterySolved(m);

    const openQHtml = openQs.length
      ? `<div class="fact-list">${openQs.map(q =>
          `<div class="unknown-item">${esc(_qaText(q))}</div>`).join('')}</div>`
      : '';
    const solvedQHtml = solvedQs.length
      ? `<div class="fact-list">${solvedQs.map(q => `
          <div class="qa-solved">
            <div class="qa-solved-q">✓ ${esc(_qaText(q))}</div>
            <div class="qa-solved-a">${esc(_qaAnswer(q))}</div>
          </div>`).join('')}</div>`
      : '';

    _setCurrentArticle({ type: 'mysteries', id });
    return _articleShell({
      editButton: _articleEditButton('mysteries', id),
      visual: `<div class="ah-icon">❓</div>`,
      title: esc(m.name),
      subtitle: `${I18n.t('wiki.priorityLabelCap')}: ${m.priority}`,
      chips: [
        `<span class="mystery-priority priority-${m.priority}">${m.priority.toUpperCase()}</span>`,
        solvedAll
          ? `<span class="profile-chip">✓ ${esc(I18n.t('wiki.solved'))}</span>`
          : `<span class="profile-chip">⧗ ${esc(I18n.t('wiki.open'))}</span>`,
      ],
      facts: [_twinFactRow('mysteries', m)].filter(Boolean),
      sections: [
        { title: I18n.t('wiki.sectionOpenQuestions'),   html: openQHtml },
        { title: I18n.t('wiki.sectionSolvedQuestions'), html: solvedQHtml },
        { title: I18n.t('wiki.sectionClues'),           html: (m.clues||[]).length
          ? `<div class="fact-list">${m.clues.map(c => `<div class="fact-item">${esc(c)}</div>`).join('')}</div>` : '' },
        { title: I18n.t('wiki.sectionLinkedChars'),     html: charChips ? `<div class="relation-chips">${charChips}</div>` : '' },
      ],
      outlineSource: m.description || '',
      kind: 'mysteries', entity: m,
      body: `
        <div class="md-view">${renderMarkdown(m.description)}</div>
        <div style="margin-top:1.5rem">
          <a href="#/zahady" class="wiki-link">← ${esc(I18n.t('wiki.backToMysteries'))}</a>
        </div>
      `,
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  FACTION LIST
  // ══════════════════════════════════════════════════════════════
  function _frakceApply() {
    const s = _listState.frakce;
    const factions = Store.getFactions();
    const chars    = Store.getCharacters();

    // Dedupe shadow twins. getCollection('factions') returns
    // id-stamped values (factions are keyed-object on disk, so the
    // raw values from `Store.getFactions()` lack an `id` field —
    // passing those into dedupeShadowTwins would collapse the
    // resulting Map under a single `undefined` key and filter every
    // faction out).
    const allFactions  = Store.getCollection('factions');
    const survivingIds = new Set(
      Store.dedupeShadowTwins('factions', allFactions).map(f => f.id)
    );
    let entries = Object.entries(factions)
      .filter(([id]) => survivingIds.has(id))
      .map(([id, f]) => ({
        id, f,
        memberCount: chars.filter(c => c.faction === id).length,
      }));

    if (s.values && s.values.length) {
      entries = entries.filter(({ id, f }) =>
        _matchAll(s.values, `${id} ${f.name||''} ${f.description||''}`)
      );
    }

    switch (s.sort) {
      case 'name':
        entries.sort((a, b) => _czCompare(a.f.name, b.f.name));
        break;
      case 'members':
        entries.sort((a, b) =>
          b.memberCount - a.memberCount || _czCompare(a.f.name, b.f.name));
        break;
      case 'default':
      default:
        // Preserve insertion order from data.js / storage.
    }
    return entries;
  }

  function _frakceGridHtml() {
    const entries = _frakceApply();
    if (entries.length === 0) {
      return `<div class="list-empty">${esc(I18n.t('wiki.factionNoMatch'))}</div>`;
    }
    return entries.map(({ id, f, memberCount }) => {
      const rankCount = (f.rankChains || []).reduce((s, ch) => s + ch.ranks.length, 0);
      const ovl = editOverlay(`#/frakce/${id}`);
      return `
        <a class="faction-card" href="#/frakce/${id}" style="text-decoration:none;position:relative;border-color:${f.color}55">
          ${ovl}
          ${_twinCardMarker(f)}
          <div class="faction-card-header" style="background:${f.color}22;border-bottom:1px solid ${f.color}33">
            <span class="faction-card-badge">${f.badge}</span>
            <span class="faction-card-name" style="color:${f.textColor}">${esc(f.name)}</span>
          </div>
          <div class="faction-card-meta">
            <span>👤 ${esc(I18n.t('wiki.membersCount', { n: memberCount }))}</span>
            ${rankCount ? `<span>⚔ ${esc(I18n.t('wiki.ranksCount', { n: rankCount }))}</span>` : ""}
          </div>
        </a>`;
    }).join("");
  }

  function renderFactionList() {
    const total = Object.keys(Store.getFactions()).length;
    const shown = _frakceApply().length;
    if (total === 0) {
      return `
        <div class="page-header"><h1>⬡ ${esc(I18n.t('nav.factions'))}</h1></div>
        ${_renderEmptyState({
          icon: '⬡',
          title: I18n.t('wiki.factionEmptyTitle'),
          description: I18n.t('wiki.factionEmptyDesc'),
          ctaLabel: I18n.t('wiki.factionNew'), ctaHref: '#/frakce/new',
        })}`;
    }
    return `
      <div class="page-header" style="display:flex;align-items:center;gap:1rem">
        <div style="flex:1">
          <h1>⬡ ${esc(I18n.t('nav.factions'))}</h1>
          <div class="subtitle">${esc(I18n.t('wiki.factionsCount', { shown, total }))}</div>
        </div>
        <a href="#/frakce/new" class="list-item-new" style="text-decoration:none">＋ ${esc(I18n.t('wiki.factionNew'))}</a>
      </div>
      ${_listToolbar('frakce', [
        ['default', I18n.t('wiki.sortDefault')],
        ['name',    I18n.t('wiki.sortNameAsc')],
        ['members', I18n.t('wiki.sortMemberCount')],
      ])}
      <div class="faction-grid" id="wl-frakce-grid">${_frakceGridHtml()}</div>
    `;
  }

  function setFrakceSearch(v) {
    const arr = Array.isArray(v) ? v : (v ? [String(v)] : []);
    _listState.frakce.values = arr;
    _persistListState();
    _refreshFrakceGrid();
    _refreshFrakceCount();
  }
  function setFrakceSort(v) {
    _listState.frakce.sort = v || 'default';
    _persistListState();
    _refreshFrakceGrid();
  }
  function _refreshFrakceGrid() {
    const host = document.getElementById('wl-frakce-grid');
    if (host) host.innerHTML = _frakceGridHtml();
  }
  function _refreshFrakceCount() {
    const sub = document.querySelector('.page-header .subtitle');
    if (!sub) return;
    const total = Object.keys(Store.getFactions()).length;
    const shown = _frakceApply().length;
    sub.textContent = I18n.t('wiki.factionsCount', { shown, total });
  }

  // ══════════════════════════════════════════════════════════════
  //  FACTION ARTICLE
  // ══════════════════════════════════════════════════════════════
  function renderFactionArticle(id) {
    if (id === "new") return EditMode.renderFactionEditor(null, "new");
    // Party left the factions collection — point the user at Settings.
    if (id === PARTY_FACTION_ID) {
      return `
        <div class="page-header"><h1>🛡 ${esc(I18n.t('wiki.ourParty'))}</h1></div>
        <p>${I18n.t('wiki.partyManagedVia')}</p>
        <p><a class="wiki-link" href="#/parta">→ ${esc(I18n.t('wiki.openMemberList'))}</a></p>`;
    }
    const factions = Store.getFactions();
    const f = factions[id];
    if (!f) return `<p>${esc(I18n.t('wiki.factionNotFound', { id }))}</p>`;
    if (_isCurrentArticleEditing()) return EditMode.renderFactionEditor(f, id);

    const chars = Store.getCharacters().filter(c => c.faction === id);

    const _charChip = c => `<a class="relation-chip" href="#/postava/${c.id}">${esc(c.name)}</a>`;
    const chainSections = (f.rankChains || []).map(chain => {
      const chainMembers = chars.filter(c => c.rankChain === chain.id);
      const rows = chain.ranks.map(rank => ({
        label:   rank,
        members: chainMembers.filter(c => c.rank === rank).map(_charChip).join(''),
      }));
      const unrankedMembers = chainMembers.filter(c => !chain.ranks.includes(c.rank));
      const footer = unrankedMembers.length
        ? { label: I18n.t('wiki.unknownRank'), members: unrankedMembers.map(_charChip).join('') }
        : null;
      return renderRankChain({
        title:     chain.name,
        color:     f.color,
        textColor: f.textColor,
        rows,
        footer,
      });
    }).join('');

    const unchained = chars.filter(c =>
      !c.rankChain || !(f.rankChains || []).find(ch => ch.id === c.rankChain)
    );

    const inlineCreate = `
      <div class="inline-create-row">
        <button class="inline-create-btn"${dataAction('EditMode.startNewCharacter', { faction: id })}>＋ ${esc(I18n.t('wiki.newCharacterInFaction'))}</button>
      </div>`;

    const rankCount = (f.rankChains || []).reduce((s, ch) => s + ch.ranks.length, 0);
    const chips = [
      `<span class="profile-chip">👤 ${esc(I18n.t('wiki.membersCount', { n: chars.length }))}</span>`,
      ...(rankCount ? [`<span class="profile-chip">⚔ ${esc(I18n.t('wiki.ranksCount', { n: rankCount }))}</span>`] : []),
    ];
    // Faction-level attitude chips + glow on the badge.
    const facColors  = _attitudeColorMap();
    const facEntries = Store.getEffectiveAttitudes(f, 'faction');
    const facAttEnum = Store.getEnum('attitudes') || [];
    for (const e of facEntries) {
      const def = facAttEnum.find(a => a.id === e.id);
      if (!def) continue;
      const color = def.labelColor || def.bg || '#888';
      const s = (typeof def.strength === 'number') ? def.strength : 1.0;
      const pct = s === 1.0 ? '' : ` ${Math.round(s * 100)}%`;
      chips.push(`<span class="badge badge-attitude"
        style="background:${esc(color)}22;color:${esc(color)};border:1px solid ${esc(color)}66">●&nbsp;${esc(def.label)}${esc(pct)}</span>`);
    }
    const facGlow = _attitudeGlow(facEntries, facColors);
    const visualStyle = `background:${f.color}33;color:${f.textColor}${facGlow ? ';filter:'+facGlow : ''}`;

    _setCurrentArticle({ type: 'factions', id });
    return _articleShell({
      editButton: _articleEditButton('factions', id),
      visual: `<div class="ah-icon" style="${visualStyle}">${f.badge}</div>`,
      title: `<span style="color:${f.textColor}">${f.badge} ${esc(f.name)}</span>`,
      subtitle: '',
      chips,
      facts: [
        (f.rankChains || []).length
          ? { label: I18n.t('wiki.factChains'), value: (f.rankChains || []).map(ch => esc(ch.name)).join(', ') }
          : null,
        _twinFactRow('factions', f),
      ].filter(Boolean),
      sections: [
        { title: '',                          html: inlineCreate },
        { title: I18n.t('wiki.sectionRankChains'), html: (f.rankChains || []).length ? chainSections : '' },
        { title: I18n.t('wiki.sectionMembers'),    html: unchained.length
          ? `<div class="relation-chips">${unchained.map(c => `<a class="relation-chip" href="#/postava/${c.id}">${esc(c.name)}</a>`).join('')}</div>`
          : '' },
        _petsArticleSection('faction', id),
      ],
      outlineSource: f.description || '',
      kind: 'factions', entity: f,
      body: `
        ${f.description ? `<div class="md-view">${renderMarkdown(f.description)}</div>` : ''}
        <div style="margin-top:1.5rem">
          <a href="#/frakce" class="wiki-link">← ${esc(I18n.t('wiki.backToFactions'))}</a>
        </div>
      `,
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  PARTY (Parta) — dedicated page for `faction:'party'` PCs.
  //  Same character model as NPCs, but richer card layout (larger
  //  portrait, species/gender/age inline, circumstances prominent)
  //  because party members are always fully known to themselves.
  // ══════════════════════════════════════════════════════════════
  function renderPartyList() {
    const party = Store.getPartyMembers();

    if (party.length === 0) {
      return `
        <div class="page-header"><h1>🛡 ${esc(I18n.t('nav.party'))}</h1></div>
        ${_renderEmptyState({
          icon: '🛡',
          title: I18n.t('wiki.partyEmptyTitle'),
          description: I18n.t('wiki.partyEmptyDesc'),
          ctaLabel: I18n.t('wiki.partyNewMember'),
          ctaActionAttr: dataAction('EditMode.startNewCharacter', { faction: PARTY_FACTION_ID, knowledge: 4, status: 'alive' }),
        })}`;
    }

    // Trailing dashed card removed; the create affordance is a header
    // button (always visible to authed viewers, hidden for anonymous).
    const empty = party.length === 0
      ? `<div class="list-empty">${esc(I18n.t('wiki.partyEmptyInline'))}</div>` : '';

    const count = party.length;
    const newBtn = `
      <button class="list-item-new"
        ${dataAction('EditMode.startNewCharacter', { faction: PARTY_FACTION_ID, knowledge: 4, status: 'alive' })}>＋ ${esc(I18n.t('wiki.partyNewMember'))}</button>`;

    return `
      <div class="page-header" style="display:flex;align-items:center;gap:1rem">
        <div style="flex:1">
          <h1>🛡 ${esc(I18n.t('nav.party'))}</h1>
          <div class="subtitle">${esc(I18n.plural('wiki.memberCount', count))}</div>
        </div>
        ${newBtn}
      </div>
      <div class="char-grid">
        ${party.map(renderCharacterCard).join('')}
        ${empty}
      </div>
    `;
  }

  // ══════════════════════════════════════════════════════════════
  //  RANK CHAIN — reusable themed hierarchy list
  //  Renders a card with a title strip and a series of numbered rows
  //  tinted to a single colour (faction color by default). Useful for
  //  rank chains, pantheon tiers, command hierarchies — anything where
  //  a short ordered list of buckets needs a themed wrapper.
  //
  //  Shape:
  //    renderRankChain({
  //      title:    "Dračí spáry",         // strip title
  //      color:    "#A0291C",             // accent base; derives all surfaces
  //      textColor:"#ffb6a8",             // optional — contrasted title text
  //      rows: [
  //        { label: "Velmistr", members: "<chips html>" },  // members = html
  //        { label: "Učeň",     members: "" }                // empty → "Nikdo"
  //      ],
  //      footer: { label: "Neznámá hodnost", members: "<chips>" } // optional
  //    })
  // ══════════════════════════════════════════════════════════════
  function renderRankChain({ title, color, textColor, rows, footer }) {
    const accent = color || '#C9A14B';
    const label  = textColor || accent;
    const rowsHtml = (rows || []).map((r, i) => `
      <div class="rank-row">
        <div class="rank-row-label">
          <span class="rank-dot">${i + 1}</span>
          <span class="rank-row-name">${esc(r.label)}</span>
        </div>
        <div class="rank-row-members">
          ${r.members && r.members.trim()
            ? r.members
            : `<span class="rank-row-empty">${esc(I18n.t('wiki.nobody'))}</span>`}
        </div>
      </div>`).join('');
    const footerHtml = footer ? `
      <div class="rank-row rank-row-unranked">
        <div class="rank-row-label">
          <span class="rank-dot rank-dot-unknown">?</span>
          <span class="rank-row-name">${esc(footer.label)}</span>
        </div>
        <div class="rank-row-members">${footer.members || ''}</div>
      </div>` : '';
    return `
      <div class="rank-chain" style="--chain-color:${accent};--chain-text:${label}">
        <div class="rank-chain-title">${esc(title)}</div>
        ${rowsHtml}${footerHtml}
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════
  //  SPECIES / PANTHEON / ARTIFACTS
  // ══════════════════════════════════════════════════════════════
  function _simpleListHeader(title, subtitle, newHref, newLabel) {
    const newBtn = newHref
      ? `<a href="${newHref}" class="list-item-new" style="text-decoration:none">＋ ${newLabel}</a>` : '';
    return `
      <div class="page-header" style="display:flex;align-items:center;gap:1rem">
        <div style="flex:1">
          <h1>${title}</h1>
          <div class="subtitle">${subtitle}</div>
        </div>
        ${newBtn}
      </div>`;
  }

  function _firstParagraph(md) {
    const txt = String(md || '').trim();
    if (!txt) return '';
    const line = txt.split(/\n\s*\n/)[0];
    return esc(line.length > 180 ? line.slice(0, 180) + '…' : line);
  }

  // ── Species (Druhy) ─────────────────────────────────────────────
  function renderSpeciesList() {
    const items = Store.dedupeShadowTwins('species', Store.getSpecies()).slice()
      .sort((a, b) => _czCompare(a.name, b.name));
    if (items.length === 0) {
      return `
        <div class="page-header"><h1>🧬 ${esc(I18n.t('nav.species'))}</h1></div>
        ${_renderEmptyState({
          icon: '🧬',
          title: I18n.t('wiki.speciesEmptyTitle'),
          description: I18n.t('wiki.speciesEmptyDesc'),
          ctaLabel: I18n.t('wiki.speciesNew'), ctaHref: '#/druh/new',
        })}`;
    }
    const grid = items.map(s => {
          const editBtn = editOverlay(`#/druh/${s.id}`);
          return `<a class="loc-card" href="#/druh/${s.id}" style="text-decoration:none;position:relative">
            ${editBtn}
            ${_twinCardMarker(s)}
            <div class="loc-card-icon">🧬</div>
            <div class="loc-card-body">
              <div class="loc-card-name">${esc(s.name)}</div>
              <div class="loc-card-type">${_firstParagraph(s.description)}</div>
            </div>
          </a>`;
        }).join('');
    return `
      ${_simpleListHeader('🧬 ' + I18n.t('nav.species'), I18n.plural('wiki.recordCount', items.length), '#/druh/new', I18n.t('wiki.speciesNew'))}
      <div class="loc-grid">${grid}</div>
    `;
  }

  function renderSpeciesArticle(id) {
    if (id === 'new') return EditMode.renderSpeciesEditor(null);
    const s = Store.getSpeciesItem(id);
    if (!s) return `<p>${esc(I18n.t('wiki.speciesNotFound', { id }))}</p>`;
    if (_isCurrentArticleEditing()) return EditMode.renderSpeciesEditor(s);

    // Characters of this species.
    const chars = Store.getCharacters().filter(c =>
      c.species === id || c.species === s.name
    );
    const charChips = chars.length
      ? `<div class="relation-chips">${chars.map(c =>
          `<a class="relation-chip" href="#/postava/${c.id}">${esc(c.name)}</a>`
        ).join('')}</div>` : '';

    _setCurrentArticle({ type: 'species', id });
    return _articleShell({
      editButton: _articleEditButton('species', id),
      visual: `<div class="ah-icon">🧬</div>`,
      title: esc(s.name),
      chips: [`<span class="profile-chip">👤 ${chars.length}</span>`],
      facts: [_twinFactRow('species', s)].filter(Boolean),
      sections: [
        { title: I18n.t('wiki.sectionCharsOfSpecies'), html: charChips },
      ],
      body: `<div class="md-view">${renderMarkdown(s.description)}</div>`,
      outlineSource: s.description || '',
    });
  }

  // ── Pantheon (Panteon) ──────────────────────────────────────────
  function renderPantheonList() {
    const items = Store.dedupeShadowTwins('pantheon', Store.getPantheon()).slice()
      .sort((a, b) => _czCompare(a.name, b.name));
    if (items.length === 0) {
      return `
        <div class="page-header"><h1>✨ ${esc(I18n.t('nav.pantheon'))}</h1></div>
        ${_renderEmptyState({
          icon: '✨',
          title: I18n.t('wiki.pantheonEmptyTitle'),
          description: I18n.t('wiki.pantheonEmptyDesc'),
          ctaLabel: I18n.t('wiki.deityNew'), ctaHref: '#/buh/new',
        })}`;
    }
    const grid = items.map(g => {
          const editBtn = editOverlay(`#/buh/${g.id}`);
          const sub = [g.domain, g.alignment].filter(Boolean).map(esc).join(' · ');
          return `<a class="loc-card" href="#/buh/${g.id}" style="text-decoration:none;position:relative">
            ${editBtn}
            ${_twinCardMarker(g)}
            <div class="loc-card-icon">${esc(g.symbol || '✨')}</div>
            <div class="loc-card-body">
              <div class="loc-card-name">${esc(g.name)}</div>
              <div class="loc-card-type">${sub}</div>
            </div>
          </a>`;
        }).join('');
    return `
      ${_simpleListHeader('✨ ' + I18n.t('nav.pantheon'), I18n.plural('wiki.deityCount', items.length), '#/buh/new', I18n.t('wiki.deityNew'))}
      <div class="loc-grid">${grid}</div>
    `;
  }

  function renderBuhArticle(id) {
    if (id === 'new') return EditMode.renderBuhEditor(null);
    const g = Store.getBuh(id);
    if (!g) return `<p>${esc(I18n.t('wiki.deityNotFound', { id }))}</p>`;
    if (_isCurrentArticleEditing()) return EditMode.renderBuhEditor(g);

    _setCurrentArticle({ type: 'pantheon', id });
    return _articleShell({
      editButton: _articleEditButton('pantheon', id),
      visual: `<div class="ah-icon">${esc(g.symbol || '✨')}</div>`,
      title: esc(g.name),
      subtitle: [g.domain, g.alignment].filter(Boolean).map(esc).join(' · '),
      chips: [],
      facts: [
        { label: I18n.t('wiki.factDomain'),    value: g.domain    ? esc(g.domain)    : '' },
        { label: I18n.t('wiki.factAlignment'), value: g.alignment ? esc(g.alignment) : '' },
        _twinFactRow('pantheon', g),
      ].filter(Boolean),
      body: `<div class="md-view">${renderMarkdown(g.description)}</div>`,
      outlineSource: g.description || '',
    });
  }

  // ── Artifacts (Artefakty) ───────────────────────────────────────
  function renderArtifactList() {
    const items = Store.dedupeShadowTwins('artifacts', Store.getArtifacts()).slice()
      .sort((a, b) => _czCompare(a.name, b.name));
    if (items.length === 0) {
      return `
        <div class="page-header"><h1>🗝 ${esc(I18n.t('nav.artifacts'))}</h1></div>
        ${_renderEmptyState({
          icon: '🗝',
          title: I18n.t('wiki.artifactEmptyTitle'),
          description: I18n.t('wiki.artifactEmptyDesc'),
          ctaLabel: I18n.t('wiki.artifactNew'), ctaHref: '#/artefakt/new',
        })}`;
    }
    const grid = items.map(a => {
          const editBtn = editOverlay(`#/artefakt/${a.id}`);
          return `<a class="loc-card" href="#/artefakt/${a.id}" style="text-decoration:none;position:relative">
            ${editBtn}
            ${_twinCardMarker(a)}
            <div class="loc-card-icon">🗝</div>
            <div class="loc-card-body">
              <div class="loc-card-name">${esc(a.name)}</div>
            </div>
          </a>`;
        }).join('');
    return `
      ${_simpleListHeader('🗝 ' + I18n.t('nav.artifacts'), I18n.plural('wiki.artifactCount', items.length), '#/artefakt/new', I18n.t('wiki.artifactNew'))}
      <div class="loc-grid">${grid}</div>
    `;
  }

  function renderArtifactArticle(id) {
    if (id === 'new') return EditMode.renderArtifactEditor(null);
    const a = Store.getArtifact(id);
    if (!a) return `<p>${esc(I18n.t('wiki.artifactNotFound', { id }))}</p>`;
    if (_isCurrentArticleEditing()) return EditMode.renderArtifactEditor(a);

    const owner = a.ownerCharacterId ? Store.getCharacter(a.ownerCharacterId) : null;
    const loc   = a.locationId       ? Store.getLocation(a.locationId)        : null;

    _setCurrentArticle({ type: 'artifacts', id });
    return _articleShell({
      editButton: _articleEditButton('artifacts', id),
      visual: `<div class="ah-icon">🗝</div>`,
      title: esc(a.name),
      subtitle: '',
      chips: [],
      facts: [
        { label: I18n.t('wiki.factHolder'),   value: owner ? `<a class="relation-chip" href="#/postava/${owner.id}">🎒 ${esc(owner.name)}</a>` : '' },
        { label: I18n.t('wiki.factLocation'), value: loc   ? `<a class="relation-chip" href="#/misto/${loc.id}">📍 ${esc(loc.name)}</a>` : '' },
        _twinFactRow('artifacts', a),
      ].filter(Boolean),
      body: `<div class="md-view">${renderMarkdown(a.description)}</div>`,
      outlineSource: a.description || '',
    });
  }

  // ── Historical events (Historie) ────────────────────────────────
  // Separate from campaign `events` — this is worldbuilding background
  // that can span years or epochs. Each record has start/end year
  // strings, a short summary, and a long markdown body.
  function _historyRange(h) {
    const s = (h.start || '').trim();
    const e = (h.end   || '').trim();
    if (s && e && s !== e) return `${esc(s)} – ${esc(e)}`;
    return esc(s || e || '');
  }

  function renderHistoryList() {
    const items = Store.dedupeShadowTwins('historicalEvents', Store.getHistoricalEvents()).slice();
    // Sort by start (then name) — numeric-aware so "1347 DR" beats "980 DR".
    items.sort((a, b) => {
      const sa = String(a.start || '');
      const sb = String(b.start || '');
      const cmp = sa.localeCompare(sb, 'cs', { numeric: true, sensitivity: 'base' });
      return cmp !== 0 ? cmp : _czCompare(a.name, b.name);
    });
    if (items.length === 0) {
      return `
        <div class="page-header"><h1>📜 ${esc(I18n.t('nav.history'))}</h1></div>
        ${_renderEmptyState({
          icon: '📜',
          title: I18n.t('wiki.historyEmptyTitle'),
          description: I18n.t('wiki.historyEmptyDesc'),
          ctaLabel: I18n.t('wiki.historyNew'), ctaHref: '#/historicka-udalost/new',
        })}`;
    }
    const grid = items.map(h => {
      const editBtn = editOverlay(`#/historicka-udalost/${h.id}`);
      const range = _historyRange(h);
      const sub = [range, _firstParagraph(h.summary)].filter(Boolean).join(' · ');
      return `<a class="loc-card" href="#/historicka-udalost/${h.id}" style="text-decoration:none;position:relative">
        ${editBtn}
        <div class="loc-card-icon">📜</div>
        <div class="loc-card-body">
          <div class="loc-card-name">${esc(h.name)}</div>
          <div class="loc-card-type">${sub}</div>
        </div>
      </a>`;
    }).join('');
    return `
      ${_simpleListHeader('📜 ' + I18n.t('nav.history'), I18n.plural('wiki.eventCount', items.length), '#/historicka-udalost/new', I18n.t('wiki.historyNew'))}
      <div class="loc-grid">${grid}</div>
    `;
  }

  function renderHistoryArticle(id) {
    if (id === 'new') return EditMode.renderHistoricalEventEditor(null);
    const h = Store.getHistoricalEvent(id);
    if (!h) return `<p>${esc(I18n.t('wiki.historyNotFound', { id }))}</p>`;
    if (_isCurrentArticleEditing()) return EditMode.renderHistoricalEventEditor(h);

    const chars = (h.characters || []).map(cid => Store.getCharacter(cid)).filter(Boolean);
    const locs  = (h.locations  || []).map(lid => Store.getLocation(lid)).filter(Boolean);
    const charChips = chars.length
      ? `<div class="relation-chips">${chars.map(c =>
          `<a class="relation-chip" href="#/postava/${c.id}">${esc(c.name)}</a>`
        ).join('')}</div>` : '';
    const locChips = locs.length
      ? `<div class="relation-chips">${locs.map(l =>
          `<a class="relation-chip" href="#/misto/${l.id}">📍 ${esc(l.name)}</a>`
        ).join('')}</div>` : '';

    _setCurrentArticle({ type: 'historicalEvents', id });
    return _articleShell({
      editButton: _articleEditButton('historicalEvents', id),
      visual: `<div class="ah-icon">📜</div>`,
      title:  esc(h.name),
      subtitle: _historyRange(h),
      facts: [
        { label: I18n.t('wiki.factStart'), value: esc(h.start || '') },
        { label: I18n.t('wiki.factEnd'),   value: esc(h.end   || '') },
        _twinFactRow('historicalEvents', h),
      ].filter(Boolean),
      sections: [
        h.summary ? { title: I18n.t('wiki.sectionSummary'),    html: `<div class="md-view">${renderMarkdown(h.summary)}</div>` } : null,
        charChips ? { title: I18n.t('nav.characters'),         html: charChips } : null,
        locChips  ? { title: I18n.t('nav.locations'),          html: locChips  } : null,
      ].filter(Boolean),
      body: `<div class="md-view">${renderMarkdown(h.body)}</div>`,
      outlineSource: h.body || '',
    });
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Render the named wiki page into `#main-content`. Dispatched from
   * `app.js`'s router. The optional `param` is the entity id (or for
   * the lists, an attitude / faction filter id depending on the page).
   *
   * @param {string} page - Page key, e.g. `'dashboard'`, `'postava'`.
   * @param {string} [param] - Entity id or filter argument.
   */
  function renderPage(page, param) {
    const el = document.getElementById("main-content");
    if (!el) return;

    let html = "";
    switch (page) {
      case "dashboard":  html = renderDashboard(); break;
      case "parta":      html = renderPartyList(); break;
      case "postavy":    html = renderCharacterList(param); break;
      case "postava":    html = renderCharacterArticle(param); break;
      case "mista":      html = renderLocationList(); break;
      case "misto":      html = renderLocationArticle(param); break;
      case "udalost":    html = renderEventArticle(param); break;
      case "zahady":     html = renderMysteries(); break;
      case "zahada":     html = renderMysteryArticle(param); break;
      case "frakce":     html = renderFactionList(); break;
      case "frakce-id":  html = renderFactionArticle(param); break;
      case "mazlicci":   html = renderPetsList(); break;
      case "druhy":      html = renderSpeciesList(); break;
      case "druh":       html = renderSpeciesArticle(param); break;
      case "panteon":    html = renderPantheonList(); break;
      case "buh":        html = renderBuhArticle(param); break;
      case "artefakty":  html = renderArtifactList(); break;
      case "artefakt":   html = renderArtifactArticle(param); break;
      case "historie":           html = renderHistoryList(); break;
      case "historicka-udalost": html = renderHistoryArticle(param); break;
      default:
        html = Addons.hasPageRenderer(page) ? Addons.renderPage(page, param) : renderDashboard();
    }
    el.innerHTML = html;
    el.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  return {
    renderPage,
    renderRankChain,
    setPostavySearch, setPostavySort, setPostavyAttitude,
    setMistaSearch,   setMistaSort,   setMistaAttitude,
    setFrakceSearch,  setFrakceSort,
    saveCampaignField,
    // Per-article edit state. `startEditingArticle` opens the editor
    // for one entity; `cancelEditingArticle` is the editor's ← Zrušit
    // button; `syncEditRoute` is called from app.js navigate() to drop
    // stale state when the user navigates away. Save flow uses the
    // `editmode:clean` window event (no explicit "stop" call needed).
    startEditingArticle, cancelEditingArticle, syncEditRoute,
    // /zahady aggregate-questions live filter.
    setZahadyQuestionFilter,
    // Dashboard hero per-field inline edit.
    startInlineEdit, commitInlineEdit, handleInlineEditKey,
    // Polarity-aware wiki-link tie-breaker uses this (in app.js):
    getCurrentArticle: _getCurrentArticle,
  };
})();
