// ═══════════════════════════════════════════════════════════════
//  WIKI — renders character, location and event articles.
//  Uses Store for all data. Checks EditMode.isActive() to switch
//  between read-only view and inline edit forms.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { EditMode } from './editmode.js';
import { norm, esc, renderMarkdown, extractOutline, humanTime, dataAction, dataOn } from './utils.js';
import { PIN_TYPES, WorldMap } from './map.js';
import { relLabel } from './data.js';
import { PARTY_FACTION_ID } from './constants.js';

export const Wiki = (() => {

  const KNOWLEDGE_LABELS = ["Neznámý","Tušený","Základní","Dobře znám","Plně zmapován"];

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
             data-tf-placeholder="🔍 Napiš a stiskni Enter…"
             data-tf-hint="Jméno, tagy, typ — víc chipů = všechny musí sedět"
             data-tf-value="${esc((s.values || []).join(','))}"
             data-wl-kind="${kind}"></div>
        <label class="list-sort">
          <span class="list-sort-label">Řadit</span>
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
      const label = factionId ? esc(factionId) : 'bez frakce';
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
    return `<span class="badge badge-knowledge">👁 ${KNOWLEDGE_LABELS[lvl] || "?"}</span>`;
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
    const imgHtml   = c.portrait
      ? `<img class="portrait-img" src="${esc(c.portrait)}" alt="${esc(c.name)}" loading="lazy">`
      : `<div class="portrait-placeholder">${factions[c.faction]?.badge || "👤"}</div>`;
    const styleAttr = glowFilter ? ` style="filter: ${glowFilter}"` : '';
    return `<div class="portrait-wrap${extraClass ? " "+extraClass : ""}" data-knowledge="${c.knowledge}" data-status="${c.status}"${styleAttr}>
      ${imgHtml}${deadHtml}
    </div>`;
  }

  // ── Edit overlay on cards (only visible in edit mode) ─────────
  function editOverlay(href) {
    return `<span class="edit-card-overlay" title="Upravit">✏</span>`;
  }

  // ── Empty-state onboarding card ───────────────────────────────
  // Rendered on list pages when the underlying collection is truly
  // empty (not filtered-to-empty). Shows a big icon, a short prompt
  // explaining what this collection is for, and a primary CTA that
  // auto-enables edit mode if it isn't already on.
  function _renderEmptyState({ icon, title, description, ctaLabel, ctaHref, ctaActionAttr }) {
    const actionAttr = ctaActionAttr || '';
    const cta = (ctaHref || actionAttr) ? `
      <a class="empty-cta" href="${ctaHref || '#'}"${actionAttr}>＋ ${esc(ctaLabel || 'Vytvořit první')}</a>` : '';
    return `
      <div class="empty-state">
        <div class="empty-state-icon">${icon || '✦'}</div>
        <div class="empty-state-title">${esc(title || 'Zatím prázdné')}</div>
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
  function _articleShell({
    visual = null, title = '', subtitle = '',
    chips = [], facts = [], sections = [], body = '',
    outlineSource = '',           // raw markdown used to build the TOC
    back = true,
  }) {
    const chipsHtml = (chips || []).filter(Boolean).join('');
    const factsHtml = (facts || []).filter(f => f && f.value).map(f =>
      `<div class="ah-fact"><span class="ah-fact-label">${esc(f.label)}</span>${f.value}</div>`
    ).join('');
    const sectionsHtml = (sections || []).filter(Boolean).map(s => {
      if (!s.html || !s.html.trim()) return '';
      return `
        <div class="char-section">
          <div class="char-section-title">${esc(s.title)}</div>
          ${s.html}
        </div>`;
    }).join('');

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
      <nav class="wiki-outline" aria-label="Obsah článku">
        <div class="wiki-outline-title">Obsah</div>
        <ul>
          ${outline.map(h =>
            `<li data-lvl="${h.level}"><a href="#${h.slug}"${dataAction('scrollTo', h.slug)}>${esc(h.text)}</a></li>`
          ).join('')}
        </ul>
      </nav>` : '';

    return `
      ${back ? `<button class="back-btn"${dataAction('back')}>← Zpět</button>` : ''}
      <div class="wiki-article">
        <aside class="wiki-side">
          ${sideCard}
          ${outlineHtml}
        </aside>
        <div class="wiki-main">
          ${sectionsHtml}
          ${body ? `<div class="article-body">${body}</div>` : ''}
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════
  //  DASHBOARD
  //  Layout: Hero (editable campaign name + tagline) → Naše parta
  //  (responsive portrait grid) → Poslední sezení (events from the
  //  latest sitting) → Otevřené záhady (top 3 unsolved by priority).
  // ══════════════════════════════════════════════════════════════
  const PRIORITY_ORDER = { 'kritická': 0, 'vysoká': 1, 'střední': 2, 'nízká': 3 };

  function renderDashboard() {
    const editing  = EditMode.isActive();
    const campaign = Store.getCampaign();
    const party    = Store.getCharacters().filter(c => c.faction === PARTY_FACTION_ID);

    return `
      ${_dashHeroHtml(campaign, editing)}
      ${_dashPartyHtml(party, editing)}
      ${_dashLastSessionHtml(editing)}
      ${_dashMysteriesHtml()}
    `;
  }

  function _dashHeroHtml(campaign, editing) {
    // In edit mode the name + tagline become plaintext-only
    // contenteditable regions that commit on blur. Enter blurs (so the
    // user can't accidentally insert a newline in the title).
    const nameAttrs = editing
      ? `contenteditable="plaintext-only"
         ${dataOn('blur', 'Wiki.saveCampaignField', 'name', '$text')}
         ${dataOn('keydown', 'enterBlurs', '$ev')}
         title="Klikni pro úpravu"`
      : '';
    const taglineAttrs = editing
      ? `contenteditable="plaintext-only"
         ${dataOn('blur', 'Wiki.saveCampaignField', 'tagline', '$text')}
         ${dataOn('keydown', 'enterBlurs', '$ev')}
         title="Klikni pro úpravu"
         data-placeholder="Podtitul kampaně — klikni pro úpravu"`
      : '';
    return `
      <div class="dash-hero ${editing ? 'is-editing' : ''}">
        <h1 class="dash-hero-name" ${nameAttrs}>${esc(campaign.name)}</h1>
        <div class="dash-hero-tagline" ${taglineAttrs}>${esc(campaign.tagline || '')}</div>
      </div>`;
  }

  function _dashPartyHtml(party, editing) {
    const addCard = editing ? `
      <a class="dash-party-card dash-party-card-new" href="#/postava/new"
         title="Přidat novou postavu">
        <div class="dash-party-add">＋</div>
        <div class="dash-party-name">Nová postava</div>
      </a>` : '';
    if (!party.length) {
      return `
        <div class="dash-section">
          <div class="dash-section-head"><h2>🛡 Naše parta</h2></div>
          <div class="dash-empty">
            Zatím tu není žádný PC. V režimu úprav přidej postavu a přiřaď jí frakci <em>Parta</em>.
          </div>
          ${editing ? `<div class="dash-party-grid">${addCard}</div>` : ''}
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
        ? `<div class="dash-party-loc" title="Aktuální pozice">📍 ${esc(locName)}</div>`
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
    return `
      <div class="dash-section">
        <div class="dash-section-head">
          <h2>🛡 Naše parta</h2>
          <a class="dash-section-action" href="#/parta">Celá parta →</a>
        </div>
        <div class="dash-party-grid">${cards}${addCard}</div>
      </div>`;
  }

  function _dashLastSessionHtml(editing) {
    const events = Store.getEvents();
    const maxSitting = events.reduce((m, e) => Math.max(m, Number(e.sitting) || 0), 0);
    if (maxSitting === 0) {
      if (editing) return `
        <div class="dash-section">
          <div class="dash-section-head"><h2>🕯 Poslední sezení</h2></div>
          <div class="dash-empty">Zatím nejsou žádné události s přiřazeným sezením. Přidej událost v <a href="#/casova-osa">Časové ose</a>.</div>
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
          <h2>🕯 Poslední sezení <span class="dash-session-badge">Sezení ${maxSitting}</span></h2>
          <a class="dash-section-action" href="#/casova-osa">Celá časová osa →</a>
        </div>
        <div class="dash-event-list">${items}</div>
      </div>`;
  }

  function _dashMysteriesHtml() {
    const unsolved = Store.getMysteries()
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
      const questions = Array.isArray(m.questions) && m.questions.length
        ? `<div class="dash-mystery-q">${esc(m.questions[0])}</div>` : '';
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
          <h2>🗝 Otevřené záhady</h2>
          <a class="dash-section-action" href="#/zahady">Všechny záhady →</a>
        </div>
        <div class="dash-mystery-list">${items}</div>
      </div>`;
  }

  // Persist a single campaign field when the user blurs an editable
  // hero region. No-op if the user didn't change anything (Store will
  // still fire a sync, but the server is idempotent).
  function saveCampaignField(field, value) {
    if (typeof field !== 'string' || !field) return;
    const patch = {};
    patch[field] = typeof value === 'string' ? value : '';
    Store.setCampaign(patch);
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
      <div class="dash-section-title" style="margin-top:2rem">Poslední úpravy</div>
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
    // Party is included now — PCs share the Postavy list with NPCs.
    // The dashboard's party strip is the at-a-glance view; this list is
    // the full roster with filtering and grouping.
    let chars = Store.getCharacters().slice();
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
    const newCard = EditMode.isActive() ? `
      <a class="char-card char-card-new" href="#/postava/new" style="text-decoration:none">
        <div class="char-card-new-icon">＋</div>
        <div class="char-card-new-label">Nová postava</div>
      </a>` : "";
    const emptyMsg = chars.length === 0
      ? `<div class="list-empty">Žádná postava neodpovídá hledání.</div>` : "";

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
        const label = f ? `${f.badge || '⬡'} ${f.name}` : (fid === '__nofac__' ? 'Bez frakce' : fid);
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
    const allChars = Store.getCharacters();

    // Truly-empty collection (not just filtered) → onboarding card.
    if (allChars.length === 0) {
      return `
        <div class="page-header"><h1>Postavy</h1></div>
        ${_renderEmptyState({
          icon: '👤',
          title: 'Zatím žádné postavy',
          description: 'PCs, spojenci a nepřátelé, které parta potkává. Přidej první postavu a začni budovat svět.',
          ctaLabel: 'Nová postava', ctaHref: '#/postava/new',
        })}`;
    }

    // Faction filter chips — party is now part of the list, so its
    // chip appears here too when any PCs exist.
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

    return `
      <div class="page-header">
        <h1>Postavy</h1>
        <div class="subtitle">${shown.length} / ${allChars.length} záznamů${filterFaction ? " · " + factions[filterFaction]?.name : ""}${activeAtt ? " · " + esc(attEnum.find(a=>a.id===activeAtt)?.label || activeAtt) : ""}</div>
      </div>
      <div class="filter-bar">
        <button class="filter-btn ${!filterFaction ? "active" : ""}"${dataAction('Wiki.renderPage', 'postavy', 'all')}>Všechny</button>
        ${factionFilters}
      </div>
      ${attFilters ? `<div class="filter-bar filter-bar-attitudes">
        <button class="filter-btn ${!activeAtt ? 'active' : ''}"${dataAction('Wiki.setPostavyAttitude', '')}>Libovolný postoj</button>
        ${attFilters}
      </div>` : ''}
      ${_listToolbar('postavy', [
        ['faction',   'Frakce (seskupeno)'],
        ['name',      'Jméno (A→Z)'],
        ['status',    'Status'],
        ['knowledge', 'Znalost (nejvíc)'],
      ])}
      <div id="wl-postavy-grid">${_postavyGridHtml(filterFaction)}</div>
    `;
  }

  // Legacy shim: old callers passed a single string. Treat as a
  // one-chip filter so inline-HTML that survived the refactor still works.
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
    sub.textContent = `${shown} / ${total} záznamů${fLabel}`;
  }

  function renderCharacterCard(c) {
    const overlay = EditMode.isActive() ? editOverlay(`#/postava/${c.id}`) : "";
    const colors  = _attitudeColorMap();
    const entries = Store.getEffectiveAttitudes(c, 'character');
    const glow    = _attitudeGlow(entries, colors);
    return `
      <a class="char-card" href="#/postava/${c.id}">
        ${portraitWrap(c, '', glow)}
        ${overlay}
        <div class="char-card-info">
          <div class="char-card-name">${c.knowledge >= 1 ? esc(c.name) : "???"}</div>
          <div class="char-card-title">${c.knowledge >= 2 ? esc(c.title) : "Neznámá"}</div>
          <div class="char-card-badges">${statusBadge(c.status)}</div>
        </div>
      </a>
    `;
  }

  // ══════════════════════════════════════════════════════════════
  //  CHARACTER ARTICLE
  // ══════════════════════════════════════════════════════════════
  function renderCharacterArticle(id) {
    if (id === "new") return EditMode.renderCharacterEditor(null);
    const c = Store.getCharacter(id);
    if (!c) return `<p>Postava '${id}' nenalezena.</p>`;
    if (EditMode.isActive()) return EditMode.renderCharacterEditor(c);

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
      { label: 'Místo',    value: locationLink || '' },
      { label: 'Okolnosti',value: (c.knowledge >= 2 && c.circumstances) ? esc(c.circumstances) : '' },
      { label: 'Hodnost',  value: rankInfo },
    ];

    const body = c.knowledge >= 2
      ? `<div class="md-view">${renderMarkdown(c.description)}</div>`
      : `<em>O této postavě toho víme jen velmi málo.</em>`;

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
      visual:   portraitWrap(c, '', articleGlow),
      title:    c.knowledge >= 1 ? esc(c.name) : 'Neznámá Postava',
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
        { title: 'Vazby',               html: rels.length          ? _relChipsHtml(rels, id, chars) : '' },
        { title: 'Zmínky v Událostech', html: eventsInvolved.length ? _eventListHtml(eventsInvolved) : '' },
        { title: 'Co víme',             html: (c.knowledge >= 2 && (c.known||[]).length)
                                                ? _factListHtml(c.known, 'fact-item')   : '' },
        { title: 'Otevřené Otázky',     html: (c.unknown||[]).length
                                                ? _factListHtml(c.unknown, 'unknown-item') : '' },
      ],
      body,
      outlineSource: c.knowledge >= 2 ? c.description : '',
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

  // ══════════════════════════════════════════════════════════════
  //  LOCATION LIST & ARTICLE
  // ══════════════════════════════════════════════════════════════
  function _mistaApply() {
    const s = _listState.mista;
    let locs = Store.getLocations();
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
    const editBtn = EditMode.isActive()
      ? `<span class="list-edit-btn" title="Upravit" style="position:absolute;top:0.4rem;right:0.4rem">✏</span>` : '';
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
    const newCard = EditMode.isActive() ? `
      <a class="loc-card loc-card-new" href="#/misto/new" style="text-decoration:none">
        <div class="loc-card-new-icon">＋</div>
        <div class="loc-card-new-label">Nové místo</div>
      </a>` : "";

    if (locs.length === 0) {
      return `<div class="loc-grid"><div class="list-empty">Žádné místo neodpovídá hledání.</div>${newCard}</div>`;
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
          ? { icon: '📦', label: 'Ostatní' }
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
        <div class="page-header"><h1>Místa</h1></div>
        ${_renderEmptyState({
          icon: '📍',
          title: 'Zatím žádná místa',
          description: 'Lokace v kampani — města, dungeons, divočina, místa na mapě.',
          ctaLabel: 'Nové místo', ctaHref: '#/misto/new',
        })}`;
    }
    const newBtn = EditMode.isActive() ? `
      <a href="#/misto/new" class="list-item-new" style="text-decoration:none">＋ Nové místo</a>` : "";

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
          <h1>Místa</h1>
          <div class="subtitle">${shown} / ${total} lokací${activeAtt ? " · " + esc(attEnum.find(a=>a.id===activeAtt)?.label || activeAtt) : ""}</div>
        </div>
        ${newBtn}
      </div>
      ${attFilters ? `<div class="filter-bar filter-bar-attitudes">
        <button class="filter-btn ${!activeAtt ? 'active' : ''}"${dataAction('Wiki.setMistaAttitude', '')}>Libovolný postoj</button>
        ${attFilters}
      </div>` : ''}
      ${_listToolbar('mista', [
        ['type',      'Typ (seskupeno)'],
        ['name',      'Jméno (A→Z)'],
        ['knowledge', 'Znalost (nejvíc)'],
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
    sub.textContent = `${shown} / ${total} lokací`;
  }

  function renderLocationArticle(id) {
    if (id === "new") return EditMode.renderLocationEditor(null);
    const l = Store.getLocation(id);
    if (!l) return `<p>Místo '${id}' nenalezeno.</p>`;
    if (EditMode.isActive()) return EditMode.renderLocationEditor(l);

    const factions = Store.getFactions();
    const chars = Store.getCharactersInLocation(id).map(c =>
      `<a class="relation-chip" href="#/postava/${c.id}">${factions[c.faction]?.badge || "👤"} ${esc(c.name)}</a>`
    ).join("");

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
        `<button class="inline-create-btn"${dataAction('WorldMap.showPin', l.id)}>🧭 Najít na mapě</button>`
      );
    } else if (EditMode.isActive()) {
      mapButtons.push(
        `<button class="inline-create-btn"${dataAction('WorldMap.startPlacingPin', l.id)}>📍 Umístit na mapu</button>`
      );
    }
    if (l.localMap) {
      // Direct hash navigation — `#/mapa/local/<id>` routes via app.js
      // straight to WorldMap.render(parentId), so no deferred action
      // needed. Encoding parentId in the URL also keeps an edit-mode
      // toggle (synthetic hashchange) on the same sub-map.
      mapButtons.push(
        `<a class="inline-create-btn" href="#/mapa/local/${encodeURIComponent(l.id)}">🗺 Otevřít místní mapu</a>`
      );
    }
    const mapRow = mapButtons.length
      ? `<div class="inline-create-row">${mapButtons.join('')}</div>` : '';

    const inlineCreate = EditMode.isActive() ? `
      <div class="inline-create-row">
        <button class="inline-create-btn"${dataAction('EditMode.startNewCharacterInLocation', l.id)}>＋ Postava zde</button>
        <button class="inline-create-btn"${dataAction('EditMode.startNewEvent', { locations: [l.id] })}>＋ Událost zde</button>
        <button class="inline-create-btn"${dataAction('EditMode.startNewLocation', { parentId: l.id })}>＋ Dílčí místo</button>
      </div>` : "";

    const pt = PIN_TYPES[l.pinType] || PIN_TYPES.custom || { icon: '📍', label: l.type || '' };
    const chips = [];
    if (placed)     chips.push(`<span class="profile-chip">📍 Na mapě</span>`);
    if (l.localMap) chips.push(`<span class="profile-chip">🗺 Místní mapa</span>`);
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
    return _articleShell({
      visual:   `<div class="ah-icon"${locGlow ? ` style="filter:${locGlow}"` : ''}>${articleIconInner}</div>`,
      title:    esc(l.name),
      subtitle: esc(l.type || ''),
      chips,
      facts: [
        { label: 'Region',          value: l.region ? esc(l.region) : '' },
        { label: 'Nadřazené místo', value: ancestors.length
                                           ? ancestors.map(a => `<a href="#/misto/${a.id}">📍 ${esc(a.name)}</a>`).join(' › ')
                                           : '' },
      ],
      sections: [
        { title: 'Mapa',             html: mapRow },
        { title: 'Dílčí místa',      html: subChips },
        { title: 'Přítomné Postavy', html: chars ? `<div class="relation-chips">${chars}</div>` : '' },
        { title: 'Události zde',     html: events.length
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
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  EVENT ARTICLE (list view lives under /casova-osa)
  // ══════════════════════════════════════════════════════════════
  function renderEventArticle(id) {
    if (id === "new") return EditMode.renderEventEditor(null);
    const e = Store.getEvent(id);
    if (!e) return `<p>Událost '${id}' nenalezena.</p>`;
    if (EditMode.isActive()) return EditMode.renderEventEditor(e);

    const chars = (e.characters || []).map(cid => {
      const c = Store.getCharacter(cid);
      return c ? `<a class="relation-chip" href="#/postava/${cid}">${esc(c.name)}</a>` : "";
    }).join("");

    const locs = (e.locations || []).map(lid => {
      const l = Store.getLocation(lid);
      return l ? `<a class="relation-chip" href="#/misto/${lid}">📍 ${esc(l.name)}</a>` : "";
    }).join("");

    const sittingLabel = e.sitting ? `Sezení ${e.sitting}` : 'Dávná minulost';
    const chips = [];
    if (e.priority) chips.push(`<span class="mystery-priority priority-${e.priority}">${e.priority.toUpperCase()}</span>`);
    if ((e.tags || []).length) {
      e.tags.forEach(t => chips.push(`<span class="profile-chip">${esc(t)}</span>`));
    }

    return _articleShell({
      visual: null,
      title: esc(e.name),
      subtitle: sittingLabel,
      chips,
      facts: [
        { label: 'Datum', value: e.date ? esc(e.date) : '' },
      ],
      sections: [
        { title: 'Zúčastněné postavy', html: chars ? `<div class="relation-chips">${chars}</div>` : '' },
        { title: 'Místa',              html: locs  ? `<div class="relation-chips">${locs}</div>`  : '' },
      ],
      outlineSource: e.description || '',
      body: `
        ${e.short ? `<div class="location-note md-view">${esc(e.short)}</div>` : ''}
        <div class="md-view">${renderMarkdown(e.description)}</div>
      `,
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  MYSTERIES LIST
  // ══════════════════════════════════════════════════════════════
  function renderMysteries() {
    const mysteries = Store.getMysteries();
    if (mysteries.length === 0) {
      return `
        <div class="page-header"><h1>❓ Záhady</h1></div>
        ${_renderEmptyState({
          icon: '❓',
          title: 'Žádné záhady',
          description: 'Otevřené otázky kampaně — co není známo, co je třeba odhalit, co parta zkoumá.',
          ctaLabel: 'Nová záhada', ctaHref: '#/zahada/new',
        })}`;
    }
    const sorted = [...mysteries].sort((a,b) => {
      const order = { kritická: 0, vysoká: 1, střední: 2 };
      return (order[a.priority] || 9) - (order[b.priority] || 9);
    });

    const newBtn = EditMode.isActive() ? `
      <a href="#/zahada/new" class="list-item-new" style="text-decoration:none">＋ Nová záhada</a>` : "";

    return `
      <div class="page-header" style="display:flex;align-items:center;gap:1rem">
        <div style="flex:1">
          <h1>❓ Záhady &amp; Otevřené Otázky</h1>
          <div class="subtitle">${mysteries.length} nevyřešených záhad</div>
        </div>
        ${newBtn}
      </div>
      <div class="mystery-list">
        ${sorted.map(m => {
          const editBtn = EditMode.isActive()
            ? `<a class="list-edit-btn" href="#/zahada/${m.id}" title="Upravit" style="float:right;margin-left:0.5rem">✏</a>` : "";
          return `<div class="mystery-card">
            <div class="mystery-name" style="display:flex;align-items:center;justify-content:space-between">
              <span>❓ ${esc(m.name)}</span>
              ${editBtn}
            </div>
            <div class="mystery-priority priority-${m.priority}">PRIORITA: ${m.priority.toUpperCase()}</div>
            <div class="mystery-desc md-view" style="margin-top:0.5rem">${renderMarkdown(m.description)}</div>
            ${(m.characters||[]).length ? `
              <div style="margin-top:0.75rem">
                <div class="char-section-title" style="font-size:0.7rem;margin-bottom:0.4rem">SPOJENÉ POSTAVY</div>
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
    if (!m) return `<p>Záhada '${id}' nenalezena.</p>`;
    if (EditMode.isActive()) return EditMode.renderMysteryEditor(m);

    const charChips = (m.characters || []).map(cid => {
      const c = Store.getCharacter(cid);
      return c ? `<a class="relation-chip" href="#/postava/${cid}">${esc(c.name)}</a>` : '';
    }).join('');

    return _articleShell({
      visual: `<div class="ah-icon">❓</div>`,
      title: esc(m.name),
      subtitle: `Priorita: ${m.priority}`,
      chips: [
        `<span class="mystery-priority priority-${m.priority}">${m.priority.toUpperCase()}</span>`,
        m.solved
          ? `<span class="profile-chip">✓ Vyřešeno</span>`
          : `<span class="profile-chip">⧗ Otevřená</span>`,
      ],
      facts: [],
      sections: [
        { title: 'Otázky', html: (m.questions||[]).length
          ? `<div class="fact-list">${m.questions.map(q => `<div class="unknown-item">${esc(q)}</div>`).join('')}</div>` : '' },
        { title: 'Stopy',  html: (m.clues||[]).length
          ? `<div class="fact-list">${m.clues.map(c => `<div class="fact-item">${esc(c)}</div>`).join('')}</div>` : '' },
        { title: 'Spojené postavy', html: charChips ? `<div class="relation-chips">${charChips}</div>` : '' },
      ],
      outlineSource: m.description || '',
      body: `
        <div class="md-view">${renderMarkdown(m.description)}</div>
        <div style="margin-top:1.5rem">
          <a href="#/zahady" class="wiki-link">← Zpět na seznam záhad</a>
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

    // Entries with pre-computed member count for sort "members" option.
    let entries = Object.entries(factions).map(([id, f]) => ({
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
      return `<div class="list-empty">Žádná frakce neodpovídá hledání.</div>`;
    }
    return entries.map(({ id, f, memberCount }) => {
      const rankCount = (f.rankChains || []).reduce((s, ch) => s + ch.ranks.length, 0);
      const ovl = EditMode.isActive() ? editOverlay(`#/frakce/${id}`) : "";
      return `
        <a class="faction-card" href="#/frakce/${id}" style="text-decoration:none;position:relative;border-color:${f.color}55">
          ${ovl}
          <div class="faction-card-header" style="background:${f.color}22;border-bottom:1px solid ${f.color}33">
            <span class="faction-card-badge">${f.badge}</span>
            <span class="faction-card-name" style="color:${f.textColor}">${esc(f.name)}</span>
          </div>
          <div class="faction-card-meta">
            <span>👤 ${memberCount} postav</span>
            ${rankCount ? `<span>⚔ ${rankCount} hodností</span>` : ""}
          </div>
        </a>`;
    }).join("");
  }

  function renderFactionList() {
    const total = Object.keys(Store.getFactions()).length;
    const shown = _frakceApply().length;
    if (total === 0) {
      return `
        <div class="page-header"><h1>⬡ Frakce</h1></div>
        ${_renderEmptyState({
          icon: '⬡',
          title: 'Žádné frakce',
          description: 'Organizace, spolky, armády — definují barvy, hodnosti a příslušnost postav. Povinné pro hodnostní řetězce.',
          ctaLabel: 'Nová frakce', ctaHref: '#/frakce/new',
        })}`;
    }
    return `
      <div class="page-header" style="display:flex;align-items:center;gap:1rem">
        <div style="flex:1">
          <h1>⬡ Frakce</h1>
          <div class="subtitle">${shown} / ${total} frakcí</div>
        </div>
        ${EditMode.isActive() ? `<a href="#/frakce/new" class="list-item-new" style="text-decoration:none">＋ Nová frakce</a>` : ""}
      </div>
      ${_listToolbar('frakce', [
        ['default', 'Výchozí'],
        ['name',    'Jméno (A→Z)'],
        ['members', 'Počet postav'],
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
    sub.textContent = `${shown} / ${total} frakcí`;
  }

  // ══════════════════════════════════════════════════════════════
  //  FACTION ARTICLE
  // ══════════════════════════════════════════════════════════════
  function renderFactionArticle(id) {
    if (id === "new") return EditMode.renderFactionEditor(null, "new");
    const factions = Store.getFactions();
    const f = factions[id];
    if (!f) return `<p>Frakce '${id}' nenalezena.</p>`;
    if (EditMode.isActive()) return EditMode.renderFactionEditor(f, id);

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
        ? { label: 'Neznámá hodnost', members: unrankedMembers.map(_charChip).join('') }
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

    const inlineCreate = EditMode.isActive() ? `
      <div class="inline-create-row">
        <button class="inline-create-btn"${dataAction('EditMode.startNewCharacter', { faction: id })}>＋ Nová postava ve frakci</button>
      </div>` : "";

    const rankCount = (f.rankChains || []).reduce((s, ch) => s + ch.ranks.length, 0);
    const chips = [
      `<span class="profile-chip">👤 ${chars.length} postav</span>`,
      ...(rankCount ? [`<span class="profile-chip">⚔ ${rankCount} hodností</span>`] : []),
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

    return _articleShell({
      visual: `<div class="ah-icon" style="${visualStyle}">${f.badge}</div>`,
      title: `<span style="color:${f.textColor}">${f.badge} ${esc(f.name)}</span>`,
      subtitle: '',
      chips,
      facts: (f.rankChains || []).length
        ? [{ label: 'Řetězce', value: (f.rankChains || []).map(ch => esc(ch.name)).join(', ') }]
        : [],
      sections: [
        { title: '',                  html: inlineCreate },
        { title: 'Hodnostní Řetězce', html: (f.rankChains || []).length ? chainSections : '' },
        { title: 'Členové',           html: unchained.length
          ? `<div class="relation-chips">${unchained.map(c => `<a class="relation-chip" href="#/postava/${c.id}">${esc(c.name)}</a>`).join('')}</div>`
          : '' },
      ],
      outlineSource: f.description || '',
      body: `
        ${f.description ? `<div class="md-view">${renderMarkdown(f.description)}</div>` : ''}
        <div style="margin-top:1.5rem">
          <a href="#/frakce" class="wiki-link">← Zpět na frakce</a>
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
    const party = Store.getCharacters()
      .filter(c => c.faction === PARTY_FACTION_ID)
      .sort((a, b) => _czCompare(a.name, b.name));

    if (party.length === 0) {
      return `
        <div class="page-header"><h1>🛡 Parta</h1></div>
        ${_renderEmptyState({
          icon: '🛡',
          title: 'Parta je zatím prázdná',
          description: 'Aktivní hráčské postavy v kampani. Přidej prvního člena — hráči, družina, PCs.',
          ctaLabel: 'Nový člen party',
          ctaActionAttr: dataAction('EditMode.startNewCharacter', { faction: PARTY_FACTION_ID, knowledge: 4, status: 'alive' }),
        })}`;
    }

    const newCard = EditMode.isActive() ? `
      <a class="char-card char-card-new"
         href="#/postava/new"
         ${dataAction('EditMode.startNewCharacter', { faction: 'party', knowledge: 4, status: 'alive' })}
         style="text-decoration:none">
        <div class="char-card-new-icon">＋</div>
        <div class="char-card-new-label">Nový člen party</div>
      </a>` : '';

    const empty = party.length === 0
      ? `<div class="list-empty">Parta je zatím prázdná. Přidej prvního člena.</div>` : '';

    const count = party.length;
    const countLabel = count === 1 ? 'člen' : (count >= 2 && count <= 4 ? 'členové' : 'členů');

    return `
      <div class="page-header">
        <h1>🛡 Parta</h1>
        <div class="subtitle">${count} ${countLabel}</div>
      </div>
      <div class="char-grid">
        ${party.map(renderCharacterCard).join('')}
        ${empty}
        ${newCard}
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
            : `<span class="rank-row-empty">Nikdo</span>`}
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
    const newBtn = EditMode.isActive() && newHref
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
    const items = Store.getSpecies().slice()
      .sort((a, b) => _czCompare(a.name, b.name));
    if (items.length === 0) {
      return `
        <div class="page-header"><h1>🧬 Druhy</h1></div>
        ${_renderEmptyState({
          icon: '🧬',
          title: 'Žádné druhy',
          description: 'Rasy a druhy bytostí — Člověk, Elf, Dračizeň… Postavy odkazují na druh z této kolekce.',
          ctaLabel: 'Nový druh', ctaHref: '#/druh/new',
        })}`;
    }
    const grid = items.map(s => {
          const editBtn = EditMode.isActive()
            ? `<span class="list-edit-btn" title="Upravit" style="position:absolute;top:0.4rem;right:0.4rem">✏</span>` : '';
          return `<a class="loc-card" href="#/druh/${s.id}" style="text-decoration:none;position:relative">
            ${editBtn}
            <div class="loc-card-icon">🧬</div>
            <div class="loc-card-body">
              <div class="loc-card-name">${esc(s.name)}</div>
              <div class="loc-card-type">${_firstParagraph(s.description)}</div>
            </div>
          </a>`;
        }).join('');
    return `
      ${_simpleListHeader('🧬 Druhy', `${items.length} záznamů`, '#/druh/new', 'Nový druh')}
      <div class="loc-grid">${grid}</div>
    `;
  }

  function renderSpeciesArticle(id) {
    if (id === 'new') return EditMode.renderSpeciesEditor(null);
    const s = Store.getSpeciesItem(id);
    if (!s) return `<p>Druh '${id}' nenalezen.</p>`;
    if (EditMode.isActive()) return EditMode.renderSpeciesEditor(s);

    // Characters of this species.
    const chars = Store.getCharacters().filter(c =>
      c.species === id || c.species === s.name
    );
    const charChips = chars.length
      ? `<div class="relation-chips">${chars.map(c =>
          `<a class="relation-chip" href="#/postava/${c.id}">${esc(c.name)}</a>`
        ).join('')}</div>` : '';

    return _articleShell({
      visual: `<div class="ah-icon">🧬</div>`,
      title: esc(s.name),
      chips: [`<span class="profile-chip">👤 ${chars.length}</span>`],
      sections: [
        { title: 'Postavy tohoto druhu', html: charChips },
      ],
      body: `<div class="md-view">${renderMarkdown(s.description)}</div>`,
      outlineSource: s.description || '',
    });
  }

  // ── Pantheon (Panteon) ──────────────────────────────────────────
  function renderPantheonList() {
    const items = Store.getPantheon().slice()
      .sort((a, b) => _czCompare(a.name, b.name));
    if (items.length === 0) {
      return `
        <div class="page-header"><h1>✨ Panteon</h1></div>
        ${_renderEmptyState({
          icon: '✨',
          title: 'Žádná božstva',
          description: 'Bohové, jejich domény, rituály a kněží — panteon, ve který postavy věří nebo ne.',
          ctaLabel: 'Nové božstvo', ctaHref: '#/buh/new',
        })}`;
    }
    const grid = items.map(g => {
          const editBtn = EditMode.isActive()
            ? `<span class="list-edit-btn" title="Upravit" style="position:absolute;top:0.4rem;right:0.4rem">✏</span>` : '';
          const sub = [g.domain, g.alignment].filter(Boolean).map(esc).join(' · ');
          return `<a class="loc-card" href="#/buh/${g.id}" style="text-decoration:none;position:relative">
            ${editBtn}
            <div class="loc-card-icon">${esc(g.symbol || '✨')}</div>
            <div class="loc-card-body">
              <div class="loc-card-name">${esc(g.name)}</div>
              <div class="loc-card-type">${sub}</div>
            </div>
          </a>`;
        }).join('');
    return `
      ${_simpleListHeader('✨ Panteon', `${items.length} božstev`, '#/buh/new', 'Nové božstvo')}
      <div class="loc-grid">${grid}</div>
    `;
  }

  function renderBuhArticle(id) {
    if (id === 'new') return EditMode.renderBuhEditor(null);
    const g = Store.getBuh(id);
    if (!g) return `<p>Božstvo '${id}' nenalezeno.</p>`;
    if (EditMode.isActive()) return EditMode.renderBuhEditor(g);

    return _articleShell({
      visual: `<div class="ah-icon">${esc(g.symbol || '✨')}</div>`,
      title: esc(g.name),
      subtitle: [g.domain, g.alignment].filter(Boolean).map(esc).join(' · '),
      chips: [],
      facts: [
        { label: 'Doména',   value: g.domain    ? esc(g.domain)    : '' },
        { label: 'Zaměření', value: g.alignment ? esc(g.alignment) : '' },
      ],
      body: `<div class="md-view">${renderMarkdown(g.description)}</div>`,
      outlineSource: g.description || '',
    });
  }

  // ── Artifacts (Artefakty) ───────────────────────────────────────
  function renderArtifactList() {
    const items = Store.getArtifacts().slice()
      .sort((a, b) => _czCompare(a.name, b.name));
    if (items.length === 0) {
      return `
        <div class="page-header"><h1>🗝 Artefakty</h1></div>
        ${_renderEmptyState({
          icon: '🗝',
          title: 'Žádné artefakty',
          description: 'Předměty moci — magické zbraně, prokleté šperky, ztracené relikvie.',
          ctaLabel: 'Nový artefakt', ctaHref: '#/artefakt/new',
        })}`;
    }
    const grid = items.map(a => {
          const editBtn = EditMode.isActive()
            ? `<span class="list-edit-btn" title="Upravit" style="position:absolute;top:0.4rem;right:0.4rem">✏</span>` : '';
          return `<a class="loc-card" href="#/artefakt/${a.id}" style="text-decoration:none;position:relative">
            ${editBtn}
            <div class="loc-card-icon">🗝</div>
            <div class="loc-card-body">
              <div class="loc-card-name">${esc(a.name)}</div>
            </div>
          </a>`;
        }).join('');
    return `
      ${_simpleListHeader('🗝 Artefakty', `${items.length} artefaktů`, '#/artefakt/new', 'Nový artefakt')}
      <div class="loc-grid">${grid}</div>
    `;
  }

  function renderArtifactArticle(id) {
    if (id === 'new') return EditMode.renderArtifactEditor(null);
    const a = Store.getArtifact(id);
    if (!a) return `<p>Artefakt '${id}' nenalezen.</p>`;
    if (EditMode.isActive()) return EditMode.renderArtifactEditor(a);

    const owner = a.ownerCharacterId ? Store.getCharacter(a.ownerCharacterId) : null;
    const loc   = a.locationId       ? Store.getLocation(a.locationId)        : null;

    return _articleShell({
      visual: `<div class="ah-icon">🗝</div>`,
      title: esc(a.name),
      subtitle: '',
      chips: [],
      facts: [
        { label: 'Držitel',   value: owner ? `<a class="relation-chip" href="#/postava/${owner.id}">🎒 ${esc(owner.name)}</a>` : '' },
        { label: 'Umístění',  value: loc   ? `<a class="relation-chip" href="#/misto/${loc.id}">📍 ${esc(loc.name)}</a>` : '' },
      ],
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
    const items = Store.getHistoricalEvents().slice();
    // Sort by start (then name) — numeric-aware so "1347 DR" beats "980 DR".
    items.sort((a, b) => {
      const sa = String(a.start || '');
      const sb = String(b.start || '');
      const cmp = sa.localeCompare(sb, 'cs', { numeric: true, sensitivity: 'base' });
      return cmp !== 0 ? cmp : _czCompare(a.name, b.name);
    });
    if (items.length === 0) {
      return `
        <div class="page-header"><h1>📜 Historie</h1></div>
        ${_renderEmptyState({
          icon: '📜',
          title: 'Žádné historické události',
          description: 'Události dávných věků — války, pády říší, probuzení draků. Doplňují svět nezávisle na časové ose kampaně.',
          ctaLabel: 'Nová událost', ctaHref: '#/historicka-udalost/new',
        })}`;
    }
    const grid = items.map(h => {
      const editBtn = EditMode.isActive()
        ? `<span class="list-edit-btn" title="Upravit" style="position:absolute;top:0.4rem;right:0.4rem">✏</span>` : '';
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
      ${_simpleListHeader('📜 Historie', `${items.length} událostí`, '#/historicka-udalost/new', 'Nová událost')}
      <div class="loc-grid">${grid}</div>
    `;
  }

  function renderHistoryArticle(id) {
    if (id === 'new') return EditMode.renderHistoricalEventEditor(null);
    const h = Store.getHistoricalEvent(id);
    if (!h) return `<p>Historická událost '${id}' nenalezena.</p>`;
    if (EditMode.isActive()) return EditMode.renderHistoricalEventEditor(h);

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

    return _articleShell({
      visual: `<div class="ah-icon">📜</div>`,
      title:  esc(h.name),
      subtitle: _historyRange(h),
      facts: [
        { label: 'Začátek', value: esc(h.start || '') },
        { label: 'Konec',   value: esc(h.end   || '') },
      ],
      sections: [
        h.summary ? { title: 'Shrnutí', html: `<div class="md-view">${renderMarkdown(h.summary)}</div>` } : null,
        charChips ? { title: 'Postavy', html: charChips } : null,
        locChips  ? { title: 'Místa',   html: locChips  } : null,
      ].filter(Boolean),
      body: `<div class="md-view">${renderMarkdown(h.body)}</div>`,
      outlineSource: h.body || '',
    });
  }

  // ── Public API ─────────────────────────────────────────────────
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
      case "druhy":      html = renderSpeciesList(); break;
      case "druh":       html = renderSpeciesArticle(param); break;
      case "panteon":    html = renderPantheonList(); break;
      case "buh":        html = renderBuhArticle(param); break;
      case "artefakty":  html = renderArtifactList(); break;
      case "artefakt":   html = renderArtifactArticle(param); break;
      case "historie":           html = renderHistoryList(); break;
      case "historicka-udalost": html = renderHistoryArticle(param); break;
      default:           html = renderDashboard();
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
  };
})();
