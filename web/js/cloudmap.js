// ═══════════════════════════════════════════════════════════════
//  CLOUD MAP — Information-cloud mind map, replaces circular nodes.
//  Each graph node becomes an HTML "cloud" card with rich context.
//  Cytoscape handles layout/physics via invisible proxy nodes.
//  The HTML cloud layer is overlaid and synced to the viewport.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { Role } from './role.js';
import { norm, debounce, esc, dataAction, dataOn, pageEditToggle } from './utils.js';
// Connection kinds (relationship types) come from the data-driven registry
// Store.getKinds('connections') — settings (seeded from REL_TYPES) + addon kinds.
import { I18n } from './i18n.js';
import { Addons } from './addons.js';

export const CloudMap = (() => {

  // Validate a user-supplied CSS colour (faction colours are DM-typed)
  // before it lands in an inline style / cssText string — a crafted
  // value otherwise breaks out of the attribute. Only hex literals pass;
  // anything else collapses to a neutral theme token.
  function _safeColor(c) {
    return /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : 'var(--text-muted)';
  }

  // Per-page edit toggle. Surfaces the `.cm-save-pos` layout-action
  // buttons (gated by `.map-toolbar.is-editing` in cloudmap.css).
  // Anonymous click → login modal via the `auth:prompt-login` window
  // event (editmode.js listens).
  let _editing = false;
  function _renderEditToggleHtml() {
    return pageEditToggle({
      moduleName: 'CloudMap', isEditing: _editing, label: I18n.t('cloudmap.editToggleLabel'),
    });
  }
  function setEditing(on) {
    if (on && Role.isAnonymous()) {
      window.dispatchEvent(new CustomEvent('auth:prompt-login'));
      return;
    }
    _editing = !!on;
    const toolbar = document.querySelector('.map-toolbar');
    if (toolbar) toolbar.classList.toggle('is-editing', _editing);
    // Replace the toggle button via the shared template — outerHTML
    // keeps the in-DOM state aligned with what initial render emits.
    // The "button only fires once" bug came from stamping the next
    // state into data-args at render time; we now route through
    // toggleEditing (no args) instead.
    const btn = document.querySelector('.map-toolbar .page-edit-toggle');
    if (btn) btn.outerHTML = _renderEditToggleHtml();
  }
  /** No-arg public toggle. Wired to the shared `pageEditToggle` button. */
  function toggleEditing() { setEditing(!_editing); }

  // ── Layout constants ────────────────────────────────────────
  const CW         = 168;          // cloud width  (graph px = screen px at zoom 1)
  const PAD        = 10;           // inner horizontal padding
  const IW         = CW - PAD * 2; // inner text width for wrapping

  const FONT_STRIP = '500 10px Inter, sans-serif';
  const FONT_NAME  = '600 13px Cinzel, Georgia, serif';
  const FONT_FACT  = '11px Lora, Georgia, serif';

  // Heights derived from actual CSS box model:
  //   .cm-cloud  → border-top:2 + padding-top:0 + padding-bottom:8 + border-bottom:1
  //   .cm-strip  → padding(5+3) + ~11px text  = 19px
  //   .cm-name   → 13px × 1.25 lh + 4px margin = 20px
  //   .cm-divider → 1px + 5px margin = 6px
  //   .cm-fact   → 11px × 1.4 lh + 2px margin = ~18px
  const H_OVERHEAD = 11;  // border(2+1) + padding-bottom(8)
  const H_STRIP    = 19;
  const H_NAME     = 20;
  const H_DIVIDER  = 6;
  const H_FACT     = 18;

  // ── Canvas text measurement + greedy word-wrap ──────────────
  // Word widths come from a single offscreen 2D canvas — measuring
  // hundreds of cards via DOM `getBoundingClientRect` would force
  // synchronous layout for every cloud and tank the layout pass.
  // Canvas `measureText` is essentially free in comparison and
  // doesn't touch the document tree.
  //
  // Per-(font + word) results cache in `_cache` for the lifetime of
  // the page. Key is `${font}|${word}` so changing font invalidates
  // automatically; the typical card body has only ~50 distinct words
  // so the cache stays small even on big graphs.
  const _cvs = document.createElement('canvas');
  const _ctx = _cvs.getContext('2d');
  const _cache = new Map();

  function _wordW(word, font) {
    const key = font + '|' + word;
    if (_cache.has(key)) return _cache.get(key);
    _ctx.font = font;
    const w = _ctx.measureText(word).width;
    _cache.set(key, w);
    return w;
  }

  /**
   * Greedy word-wrap. Splits `text` into lines that each fit `maxW`
   * pixels in the supplied `font`. Words that exceed `maxW` on their
   * own end up on a single overflowing line — no mid-word break (the
   * card uses CSS `overflow:hidden` so the visible width still caps).
   *
   * @param {string} text
   * @param {string} font  - CSS shorthand (e.g. `'13px Inter'`).
   * @param {number} maxW  - Pixel budget per line.
   * @returns {string[]}
   */
  function _wrap(text, font, maxW) {
    const words = String(text || '').split(' ').filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (_wordW(test, font) <= maxW) {
        line = test;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // ── Cloud height estimation ─────────────────────────────────
  // Pre-layout estimate: counts fact rows × H_FACT, then adds fixed overhead.
  // _resizeToActual() corrects any residual error after first DOM render.
  function _base() { return H_STRIP + H_NAME + H_DIVIDER; }

  function _charCloudH(c, mode) {
    let rows = 0;
    if (mode === 'frakce') {
      if (c.knowledge >= 2 && c.title) rows += _wrap(c.title, FONT_FACT, IW).length;
      const rels = Store.getRelationships();
      if (rels.some(r => r.source === c.id && r.type === 'commands')) rows++;
      if (rels.some(r => r.target === c.id && r.type === 'commands')) rows++;
      if (!rows) rows = 1; // "Bez vazeb velení" fallback
    } else if (mode === 'vztahy') {
      rows = 2; // status + count
      if (Store.getRelationships().some(r => r.source === c.id || r.target === c.id)) rows++;
    } else if (mode === 'tajemstvi') {
      rows = 1;
      const mysteries = Store.getMysteries().filter(m => (m.characters || []).includes(c.id));
      if (mysteries.length) {
        const q = (mysteries[0].questions || [])[0] || mysteries[0].name;
        rows += Math.min(2, _wrap(q, FONT_FACT, IW).length);
      }
    } else if (mode === 'casova-osa') {
      rows = 1;
      if (Store.getEvents().some(e => (e.characters || []).includes(c.id))) rows++;
    }
    return _base() + rows * H_FACT + H_OVERHEAD;
  }

  function _mysteryCloudH(m) {
    // `questions` is now `{text, answer}` objects (string fallback for
    // legacy / mid-migration data).
    const first = (m.questions || [])[0];
    const q     = Store.questionText(first);
    const qRows = q ? Math.min(2, _wrap(q, FONT_FACT, IW).length) : 0;
    return _base() + (1 + qRows) * H_FACT + H_OVERHEAD;
  }

  function _eventCloudH(e) {
    const rows = Math.min(2, _wrap(e.short || e.name, FONT_FACT, IW).length);
    return _base() + rows * H_FACT + H_OVERHEAD;
  }

  // ── Faction hub / location cloud sizes ───────────────────────
  const CW_HUB      = 210;
  const PAD_HUB     = 20;                // wider padding for pill shape
  const IW_HUB      = CW_HUB - PAD_HUB * 2;
  const H_OVERHEAD_HUB = 14;             // border(3+1) + padding-bottom(10)

  function _factionHubCloudH(faction, count) {
    // strip + name + divider + 1 fact row (member count) + pill overhead
    let rows = 1;
    if (faction.description) rows += Math.min(2, _wrap(faction.description, FONT_FACT, IW_HUB).length);
    return _base() + rows * H_FACT + H_OVERHEAD_HUB;
  }

  function _factionHubCloudHTML(fId, faction, count) {
    let body = `<div class="cm-fact">${esc(I18n.plural('cloudmap.characters', count))}</div>`;
    return `<div class="cm-cloud cm-faction-hub" data-id="hub_${fId}" data-type="faction"
              style="--cc:${faction.color}; --cw:${CW_HUB}px">
      <div class="cm-strip">${esc(faction.badge)} ${esc(I18n.t('cloudmap.factionStrip'))}</div>
      <div class="cm-name">${esc(faction.name)}</div>
      <div class="cm-divider"></div>
      ${body}
    </div>`;
  }

  function _locationCloudH(_loc) {
    // strip + name + divider + overhead — no per-loc body rows
    // anymore (status row was retired with the locationStatuses enum).
    return _base() + H_OVERHEAD;
  }

  function _locationCloudHTML(loc) {
    return `<div class="cm-cloud cm-location" data-id="${loc.id}" data-type="location"
              style="--cc:${CM_NODE_COLORS.location}; --cw:${CW}px">
      <div class="cm-strip">📍 ${esc(I18n.t('cloudmap.placeStrip'))}</div>
      <div class="cm-name">${esc(loc.name)}</div>
      <div class="cm-divider"></div>
    </div>`;
  }

  /** Scan characters → Map<factionId, Set<locationId>> */
  function _deriveFactionLocations(chars) {
    const map = new Map();
    for (const c of chars) {
      if (!c.faction) continue;
      if (!map.has(c.faction)) map.set(c.faction, new Set());
      const s = map.get(c.faction);
      if (c.location) s.add(c.location);
      if (c.locationRoles) c.locationRoles.forEach(lr => { if (lr.locationId) s.add(lr.locationId); });
    }
    return map;
  }

  // ── Data helpers ────────────────────────────────────────────
  // The player party lives in settings.playerParty now (not in the
  // factions collection), so these resolvers special-case the
  // `party` id and pull from Store.getPlayerParty() instead.
  function _factionColor(id) {
    if (id === 'party') return Store.getPlayerParty().color || '#444';
    return Store.getFactions()[id]?.color || '#444';
  }
  function _factionBadge(id) {
    if (id === 'party') { const pp = Store.getPlayerParty(); return pp.badge || pp.icon || '🛡'; }
    return Store.getFactions()[id]?.badge || '';
  }
  function _factionName(id) {
    if (id === 'party') return Store.getPlayerParty().name || 'Our Party';
    return Store.getFactions()[id]?.name || id;
  }
  function _statusIcon(s)    { return Store.getStatusMap()[s]?.icon   || '?';   }
  function _statusLabel(s)   { return Store.getStatusMap()[s]?.label  || s;     }
  function _statusColor(s)   { return Store.getStatusMap()[s]?.color  || '#888';}

  // Cloudmap-intrinsic node/edge colours. These are CANVAS-rendered (Cytoscape +
  // inline legend swatches), so they are JS constants rather than CSS tokens, and
  // this graph-specific palette is deliberately distinct from the wiki theme.
  // Single source of truth — referenced by BOTH the cloud builders and the legend
  // so the two cannot drift. (Real relationship-edge colours stay data-driven via
  // EDGE_COLORS / Store.getKinds('connections') — the legend reads those too.)
  const CM_NODE_COLORS     = { location: '#5D7A3A', mystery: '#6A1B9A', event: '#8B6914', dead: '#666' };
  const CM_EDGE_COLORS     = { member: '#888', located_at: '#5D7A3A', mysteryLink: '#7B2FA0', eventChain: '#C8A040', eventPart: '#555' };
  const CM_PRIORITY_COLORS = { 'kritická': '#C62828', 'vysoká': '#E65100', _default: '#8A5CC8' };

  // ── Cloud HTML builders ─────────────────────────────────────

  function _charCloudHTML(c, mode) {
    const isDead  = c.status === 'dead';
    const fColor  = isDead ? CM_NODE_COLORS.dead : _factionColor(c.faction);
    const badge   = _factionBadge(c.faction);
    const faction = _factionName(c.faction);
    const name    = c.knowledge >= 1 ? c.name : '???';
    const deadMark = isDead ? '💀 ' : '';

    let body = '';

    if (mode === 'frakce') {
      if (c.knowledge >= 2 && c.title) {
        body += `<div class="cm-fact">${esc(c.title)}</div>`;
      }
      const rels = Store.getRelationships();
      const cmdOut = rels.filter(r => r.source === c.id && r.type === 'commands');
      const cmdIn  = rels.filter(r => r.target === c.id && r.type === 'commands');
      if (cmdOut.length) {
        body += `<div class="cm-fact cm-dim">${esc(I18n.plural('cloudmap.commandsCount', cmdOut.length))}</div>`;
      }
      if (cmdIn.length) {
        const boss = Store.getCharacter(cmdIn[0].source);
        if (boss) body += `<div class="cm-fact cm-dim">${I18n.t('cloudmap.underCommand', { name: esc(boss.name) })}</div>`;
      }
      if (!body) body = `<div class="cm-fact cm-dim">${esc(I18n.t('cloudmap.noCommandLinks'))}</div>`;

    } else if (mode === 'vztahy') {
      const sIcon  = _statusIcon(c.status);
      const sLabel = _statusLabel(c.status);
      const sColor = _statusColor(c.status);
      body += `<div class="cm-status-row"><span style="color:${sColor}">${sIcon}</span> ${esc(sLabel)}</div>`;
      const rels = Store.getRelationships().filter(r => r.source === c.id || r.target === c.id);
      body += `<div class="cm-fact cm-dim">${esc(I18n.plural('cloudmap.relationships', rels.length))}</div>`;
      if (rels.length) {
        const counts = {};
        rels.forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
        const top = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 2)
          .map(([t,n]) => `${Store.getKind('connections', t).label}×${n}`).join(', ');
        body += `<div class="cm-fact cm-dim">${top}</div>`;
      }

    } else if (mode === 'tajemstvi') {
      const mysteries = Store.getMysteries().filter(m => (m.characters || []).includes(c.id));
      const cnt = mysteries.length;
      body += `<div class="cm-fact cm-dim">${esc(I18n.plural('cloudmap.mysteries', cnt))}</div>`;
      if (mysteries.length) {
        const q = (mysteries[0].questions || [])[0] || mysteries[0].name;
        const lines = _wrap(q, FONT_FACT, IW).slice(0, 2);
        const snippet = lines.join(' ') + (lines.length < _wrap(q, FONT_FACT, IW).length ? '…' : '');
        body += `<div class="cm-fact cm-hint">${esc(snippet)}</div>`;
      }

    } else if (mode === 'casova-osa') {
      const events = Store.getEvents()
        .filter(e => (e.characters || []).includes(c.id))
        .sort((a,b) => a.order - b.order);
      const cnt = events.length;
      body += `<div class="cm-fact cm-dim">${esc(I18n.plural('cloudmap.events', cnt))}</div>`;
      if (events.length) {
        const lines = _wrap(events[0].name, FONT_FACT, IW).slice(0, 1);
        body += `<div class="cm-fact">${esc(lines[0])}${_wrap(events[0].name, FONT_FACT, IW).length > 1 ? '…' : ''}</div>`;
      }
    }

    const modClass  = isDead ? ' cm-dead' : '';
    return `<div class="cm-cloud${modClass}" data-id="${c.id}" data-type="character"
              style="--cc:${fColor}; --cw:${CW}px">
      <div class="cm-strip">${badge} ${esc(faction)}</div>
      <div class="cm-name">${deadMark}${esc(name)}</div>
      <div class="cm-divider"></div>
      ${body}
    </div>`;
  }

  function _mysteryCloudHTML(m) {
    const priColor = CM_PRIORITY_COLORS[m.priority] || CM_PRIORITY_COLORS._default;
    const q = Store.questionText((m.questions || [])[0]);
    let qHTML = '';
    if (q) {
      const lines = _wrap(q, FONT_FACT, IW).slice(0, 2);
      const snippet = lines.join(' ') + (lines.length < _wrap(q, FONT_FACT, IW).length ? '…' : '');
      qHTML = `<div class="cm-fact cm-hint">${esc(snippet)}</div>`;
    }
    return `<div class="cm-cloud cm-mystery" data-id="${m.id}" data-type="mystery"
              style="--cc:${CM_NODE_COLORS.mystery}; --cw:${CW}px">
      <div class="cm-strip">❓ ${esc(I18n.t('cloudmap.mysteryStrip'))}</div>
      <div class="cm-name">${esc(m.name)}</div>
      <div class="cm-divider"></div>
      <div class="cm-fact cm-fact-priority" style="color:${priColor}">⚑ ${esc(m.priority || I18n.t('cloudmap.priorityMedium'))}</div>
      ${qHTML}
    </div>`;
  }

  function _eventCloudHTML(e) {
    const desc = e.short || e.description || e.name;
    const lines = _wrap(desc, FONT_FACT, IW).slice(0, 2);
    const snippet = lines.join(' ') + (lines.length < _wrap(desc, FONT_FACT, IW).length ? '…' : '');
    return `<div class="cm-cloud cm-event" data-id="${e.id}" data-type="event"
              style="--cc:${CM_NODE_COLORS.event}; --cw:${CW}px">
      <div class="cm-strip">📜 ${e.sitting ? esc(I18n.t('cloudmap.sitting', { n: e.sitting })) : esc(I18n.t('cloudmap.past'))}</div>
      <div class="cm-name">${esc(e.name)}</div>
      <div class="cm-divider"></div>
      <div class="cm-fact cm-dim">${esc(snippet)}</div>
    </div>`;
  }

  // ── Edge definitions ────────────────────────────────────────
  // Edge visuals come from the data-driven CONNECTION KINDS registry
  // (Store.getKinds('connections') — settings, seeded from REL_TYPES, plus any
  // addon-registered kinds). Rebuilt per render via _rebuildEdgeMeta() so a
  // DM/addon edit to a connection kind shows without a reload. Two cloudmap-only
  // synthetic edge kinds (member, located_at — not real relationships) merge in.
  let EDGE_COLORS      = {};
  let EDGE_TYPE_LABELS = {};
  let EDGE_STYLES      = {};
  function _rebuildEdgeMeta() {
    EDGE_COLORS = {}; EDGE_TYPE_LABELS = {}; EDGE_STYLES = {};
    for (const t of Store.getKinds('connections')) {
      EDGE_COLORS[t.id]      = t.color;
      EDGE_TYPE_LABELS[t.id] = t.label;
      // Stronger weight for command edges; thin dashed/dotted (except negotiates).
      const width = t.id === 'commands' ? 3 : (t.style === 'dashed' || t.style === 'dotted') && t.id !== 'negotiates' ? 1 : 2;
      EDGE_STYLES[t.id] = { 'line-style': t.style, width };
    }
    // Cloudmap-only edge kinds (not real relationships).
    EDGE_COLORS.located_at = CM_EDGE_COLORS.located_at;
    EDGE_STYLES.member     = { 'line-style': 'dashed', width: 1.5 };
    EDGE_STYLES.located_at = { 'line-style': 'dotted', width: 2   };
  }

  function _relEdge(r) {
    const es = EDGE_STYLES[r.type] || {};
    return {
      data: {
        id:        `${r.source}-${r.target}-${r.type}`,
        source:    r.source,
        target:    r.target,
        label:     r.label || EDGE_TYPE_LABELS[r.type] || r.type,
        color:     EDGE_COLORS[r.type] || '#666',
        width:     es.width || 2,
        lineStyle: es['line-style'] || 'solid',
      }
    };
  }

  // ── Layout persistence ───────────────────────────────────────
  // Saved node positions key per map mode, stored in localStorage.
  const LS_POS_PREFIX    = 'cm_pos_';
  const LS_FILTER_PREFIX = 'cm_filter_';
  let   _currentMode     = null;

  function _savePosKey()    { return LS_POS_PREFIX    + _currentMode; }
  function _saveFilterKey() { return LS_FILTER_PREFIX + _currentMode; }

  function _savePositions() {
    if (!_cy || !_currentMode) return;
    const pos = {};
    _cy.nodes().forEach(n => { pos[n.id()] = n.position(); });
    try {
      localStorage.setItem(_savePosKey(), JSON.stringify(pos));
      localStorage.setItem(_saveFilterKey(), JSON.stringify([..._hiddenFactions]));
    } catch(e) {}
  }

  function _loadPositions() {
    if (!_currentMode) return null;
    try {
      const raw = localStorage.getItem(_savePosKey());
      if (!raw) return null;
      const savedFilter = localStorage.getItem(_saveFilterKey());
      if (savedFilter) _hiddenFactions = new Set(JSON.parse(savedFilter));
      return JSON.parse(raw);
    } catch(e) { return null; }
  }

  function _clearPositions() {
    if (!_currentMode) return;
    localStorage.removeItem(_savePosKey());
    localStorage.removeItem(_saveFilterKey());
    _hiddenFactions = new Set();
  }

  // ── Faction filter state ─────────────────────────────────────
  let _hiddenFactions = new Set();

  function _toggleFaction(fId) {
    if (_hiddenFactions.has(fId)) _hiddenFactions.delete(fId);
    else _hiddenFactions.add(fId);
    _applyFactionFilter();
  }

  // ── Visual filter state (search / status / knowledge / edge-type / focus) ──
  // These DIM rather than fully hide; faction filter still owns hard-hide.
  // Persisted per mode in localStorage under LS_VFILTER_PREFIX.
  const LS_VFILTER_PREFIX = 'cm_vf_';
  function _vfilterKey() { return LS_VFILTER_PREFIX + _currentMode; }

  // Chip-style filter values. Each entry is a free-text query; a node
  // matches iff EVERY value is a diacritic-insensitive substring of the
  // node's searchable text blob (see _nodeSearchText). Status / knowledge
  // / species / faction dropdowns are all expressed as chips now — the
  // user types them into the TagFilter widget.
  let _filters = {
    values: [],                // array of strings (chip labels)
    hiddenEdgeTypes: new Set(),
    focusId: null,
    focusHops: 2,
  };
  let _focusMode = false;

  function _loadVFilter() {
    if (!_currentMode) return;
    try {
      const raw = localStorage.getItem(_vfilterKey());
      if (!raw) return;
      const o = JSON.parse(raw);
      // Prefer new shape (values[]); fall back to migrating legacy shape
      // (search + statuses) to chip values so users don't lose their state.
      if (Array.isArray(o.values)) {
        _filters.values = o.values.slice();
      } else {
        const migrated = [];
        if (o.search) migrated.push(String(o.search));
        if (Array.isArray(o.statuses)) {
          const sm = Store.getStatusMap();
          o.statuses.forEach(s => { if (sm[s]) migrated.push(sm[s].label); });
        }
        _filters.values = migrated;
      }
      _filters.hiddenEdgeTypes = new Set(o.hiddenEdgeTypes || []);
      _filters.focusHops       = +o.focusHops || 2;
      _focusMode               = !!o.focusMode;
    } catch (e) {}
  }
  function _saveVFilter() {
    if (!_currentMode) return;
    try {
      localStorage.setItem(_vfilterKey(), JSON.stringify({
        values:          _filters.values,
        hiddenEdgeTypes: [..._filters.hiddenEdgeTypes],
        focusHops:       _filters.focusHops,
        focusMode:       _focusMode,
      }));
    } catch (e) {}
  }

  // ── Node-kind registry ──────────────────────────────────────
  // Built-in node kinds as descriptors; addon kinds (Addons.nodeKinds(), perm
  // kinds:graph) merge on top via _nodeKind(). Each descriptor carries the
  // generic per-node behaviour the rest of the module routes through — `shape`
  // (hit-test), `detailHash` (tap / context-menu nav), `searchText(id)` (chip
  // filter) — plus `cardHTML(entity, mode)` / `height(entity, mode)` the view
  // builders render with. Built-ins DELEGATE to the existing render fns, so
  // behaviour is identical with zero addons installed.
  const KNOWLEDGE_NAMES = ['Neznámý','Tušený','Základní','Dobře znám','Plně zmapován'];
  const NODE_KINDS = new Map([
    ['character', {
      id: 'character', shape: 'rect', cardHTML: _charCloudHTML, height: _charCloudH,
      detailHash: (d) => `#/postava/${d.id}`,
      searchText: (id) => {
        const c = Store.getCharacter(id); if (!c) return '';
        const f = Store.getFactions()[c.faction] || {};
        const s = Store.getStatusMap()[c.status] || {};
        return [c.name, c.title, c.species, c.gender, c.age, s.label, f.name,
          KNOWLEDGE_NAMES[c.knowledge || 0], ...(c.tags || [])].filter(Boolean).join(' ');
      },
    }],
    ['location', {
      id: 'location', shape: 'rect', cardHTML: _locationCloudHTML, height: _locationCloudH,
      detailHash: (d) => `#/misto/${d.id}`,
      searchText: (id) => {
        const l = Store.getLocation(id); if (!l) return '';
        return [l.name, l.region, l.type, ...(l.tags || [])].filter(Boolean).join(' ');
      },
    }],
    ['mystery', {
      id: 'mystery', shape: 'rect', cardHTML: _mysteryCloudHTML, height: _mysteryCloudH,
      detailHash: (d) => `#/zahada/${d.id}`,
      searchText: (id) => {
        const m = Store.getMystery(id); if (!m) return '';
        const qBlob = (m.questions || []).flatMap(qa => [Store.questionText(qa), Store.questionAnswer(qa)]);
        return [m.name, m.priority, ...qBlob, ...(m.clues || [])].filter(Boolean).join(' ');
      },
    }],
    ['event', {
      id: 'event', shape: 'rect', cardHTML: _eventCloudHTML, height: _eventCloudH,
      detailHash: (d) => `#/udalost/${d.id}`,
      searchText: (id) => {
        const e = Store.getEvent(id); if (!e) return '';
        return [e.name, e.short, e.description, e.priority,
          e.sitting ? `sezeni ${e.sitting}` : 'minulost', ...(e.tags || [])].filter(Boolean).join(' ');
      },
    }],
    ['faction', {
      id: 'faction', shape: 'pill', cardHTML: _factionHubCloudHTML, height: _factionHubCloudH,
      detailHash: (d) => `#/frakce/${d.id.replace('hub_', '')}`,
      searchText: (id) => {
        const fId = id.replace(/^hub_/, '');
        const f = Store.getFactions()[fId];
        return f ? [f.name, f.badge, f.description].filter(Boolean).join(' ') : '';
      },
    }],
  ]);
  /** Resolve a node kind (built-in OR addon-registered) by type id, else null.
   *  Built-ins short-circuit (the hot path — _nodeIntersect runs during
   *  physics), so the addon scan only happens for unknown types. */
  function _nodeKind(type) {
    if (NODE_KINDS.has(type)) return NODE_KINDS.get(type);
    for (const def of Addons.nodeKinds()) if (def && def.id === type) return def;
    return null;
  }

  // Concatenated searchable text for a node (diacritic-insensitive chip match),
  // delegated to the node kind's searchText (built-in or addon).
  function _nodeSearchText(node) {
    const kind = _nodeKind(node.data('type'));
    return (kind && typeof kind.searchText === 'function') ? (kind.searchText(node.id(), node) || '') : '';
  }

  // Best-effort: resolve a Cytoscape edge to a relationship-type string for
  // the edge-type filter. Returns null when no meaningful type applies.
  function _edgeRelType(edge) {
    const id = edge.id();
    if (id.startsWith('mbr_'))   return 'member';
    if (id.startsWith('loc_'))   return 'located_at';
    if (id.startsWith('chain-')) return 'chain';
    if (id.includes('__'))       return 'participation';
    // Pattern: src-tgt-reltype  (relationship edges from _relEdge)
    const dash = id.lastIndexOf('-');
    if (dash > 0) {
      const tail = id.slice(dash + 1);
      if (EDGE_TYPE_LABELS[tail] || EDGE_STYLES[tail]) return tail;
    }
    return null;
  }

  // BFS: collect node IDs within `hops` steps of `startId` along undirected edges.
  function _bfsNeighborhood(startId, hops) {
    const visited = new Set([startId]);
    let frontier = [startId];
    for (let h = 0; h < hops; h++) {
      const next = [];
      for (const nid of frontier) {
        const node = _cy.getElementById(nid);
        if (!node || !node.length) continue;
        node.connectedEdges().forEach(e => {
          const other = e.source().id() === nid ? e.target() : e.source();
          const oid = other.id();
          if (!visited.has(oid)) { visited.add(oid); next.push(oid); }
        });
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return visited;
  }

  // Recompute which nodes and edges should be dimmed by the active filters.
  // Uses the existing `faded` class so _syncEdgeLabels() picks up edge dimming
  // for free; wrappers get .cm-vfilter-dim for fast CSS opacity.
  function _applyVisualFilter() {
    if (!_cy) return;
    // Each chip is a substring query; AND across chips, OR within a chip
    // against the node's enriched searchable text blob.
    const queries = (_filters.values || [])
      .map(v => norm(v))
      .filter(Boolean);
    const focusSet = (_focusMode && _filters.focusId)
      ? _bfsNeighborhood(_filters.focusId, _filters.focusHops)
      : null;

    const dim = new Set();
    _cy.nodes().forEach(node => {
      const id = node.id();
      let match = true;

      if (queries.length) {
        const hay = norm(_nodeSearchText(node));
        for (const q of queries) {
          if (!hay.includes(q)) { match = false; break; }
        }
      }

      if (match && focusSet && !focusSet.has(id)) match = false;

      if (!match) dim.add(id);
    });

    _cy.nodes().forEach(node => {
      const id = node.id();
      const isDim = dim.has(id);
      if (isDim) node.addClass('faded');
      else       node.removeClass('faded');
      const wrapper = _cloudMap[id];
      const cloud = wrapper && wrapper.firstElementChild;
      if (cloud) cloud.classList.toggle('cm-vfilter-dim', isDim);
    });

    _cy.edges().forEach(edge => {
      const eType   = _edgeRelType(edge);
      const typeHidden = !!eType && _filters.hiddenEdgeTypes.has(eType);
      const srcDim = edge.source().hasClass('faded');
      const tgtDim = edge.target().hasClass('faded');
      const isDim = typeHidden || srcDim || tgtDim;
      if (isDim) edge.addClass('faded');
      else       edge.removeClass('faded');
    });

    _syncEdgeLabels();
  }

  // Public setters used by inline event handlers in the filter bar.
  const _applyVisualFilterDebounced = debounce(_applyVisualFilter, 80);

  // New unified chip-filter setter. Called by the TagFilter widget via the
  // 'tf-change' CustomEvent. Each chip is a free-text substring query.
  function _setFilterValues(arr) {
    _filters.values = Array.isArray(arr) ? arr.slice() : [];
    _saveVFilter();
    _applyVisualFilterDebounced();
  }
  function _toggleEdgeType(t) {
    if (_filters.hiddenEdgeTypes.has(t)) _filters.hiddenEdgeTypes.delete(t);
    else _filters.hiddenEdgeTypes.add(t);
    _saveVFilter();
    _syncFilterChipUI();
    _applyVisualFilter();
  }
  function _toggleFocusMode() {
    _focusMode = !_focusMode;
    if (!_focusMode) _filters.focusId = null;
    _saveVFilter();
    _syncFilterChipUI();
    _applyVisualFilter();
  }
  function _setFocusHops(n) {
    _filters.focusHops = Math.max(1, Math.min(4, +n || 2));
    document.querySelectorAll('.cm-focus-hops-val').forEach(el => el.textContent = _filters.focusHops);
    _saveVFilter();
    if (_focusMode && _filters.focusId) _applyVisualFilter();
  }
  function _clearFilters() {
    _filters.values = [];
    _filters.hiddenEdgeTypes.clear();
    _filters.focusId = null;
    _focusMode = false;
    _saveVFilter();
    const tf = document.getElementById('cm-filter');
    if (tf && tf._tagfilter) tf._tagfilter.clear();
    _syncFilterChipUI();
    _applyVisualFilter();
  }

  // Sync chip 'is-on' class to current filter state. Status chips are gone
  // (replaced by TagFilter), so only edge-type chips and focus need syncing.
  function _syncFilterChipUI() {
    document.querySelectorAll('.cm-chip[data-edge-type]').forEach(b => {
      b.classList.toggle('is-off', _filters.hiddenEdgeTypes.has(b.dataset.edgeType));
    });
    const focusBtn = document.querySelector('.cm-focus-toggle');
    if (focusBtn) focusBtn.classList.toggle('is-on', _focusMode);
    const hopsBox = document.querySelector('.cm-focus-hops');
    if (hopsBox) hopsBox.hidden = !_focusMode;
  }

  function _applyFactionFilter() {
    if (!_cy) return;
    // For non-character nodes (location, mystery, event):
    // hide only if ALL connected character/faction nodes are hidden.
    // smartVisible[id] === false  → has connections, all are hidden → hide it
    // smartVisible[id] === true   → at least one visible connection → keep visible
    // smartVisible[id] === undefined → no tracked connections → keep visible
    const smartVisible = {};
    _cy.edges().forEach(edge => {
      const src = edge.source(), tgt = edge.target();
      const srcType = src.data('type'), tgtType = tgt.data('type');

      // Faction hub → location (original logic)
      if (srcType === 'faction' && tgtType === 'location') {
        const fId = src.data('faction');
        const lId = tgt.id();
        if (smartVisible[lId] === undefined) smartVisible[lId] = false;
        if (!_hiddenFactions.has(fId)) smartVisible[lId] = true;
      }

      // Character ↔ mystery or character ↔ event
      const trySmartHide = (charNode, otherNode) => {
        const oType = otherNode.data('type');
        if (charNode.data('type') === 'character' && (oType === 'mystery' || oType === 'event')) {
          const oId = otherNode.id();
          if (smartVisible[oId] === undefined) smartVisible[oId] = false;
          const fId = charNode.data('faction');
          if (!fId || !_hiddenFactions.has(fId)) smartVisible[oId] = true;
        }
      };
      trySmartHide(src, tgt);
      trySmartHide(tgt, src);
    });

    _cy.nodes().forEach(node => {
      const type    = node.data('type');
      const faction = node.data('faction');
      const id      = node.id();
      let hidden = false;

      if (type === 'faction' || type === 'character') {
        hidden = !!faction && _hiddenFactions.has(faction);
      } else if (type === 'location' || type === 'mystery' || type === 'event') {
        // Hidden if explicitly tracked and no visible connection remains
        hidden = smartVisible[id] === false;
      }

      const wrapper = _cloudMap[id];
      if (wrapper) wrapper.style.display = hidden ? 'none' : '';
      // Also set Cytoscape node visibility for edge routing
      if (hidden) node.addClass('cm-filter-hidden');
      else        node.removeClass('cm-filter-hidden');
    });

    // Hide edges where either endpoint is hidden
    _cy.edges().forEach(edge => {
      const hidden = edge.source().hasClass('cm-filter-hidden') ||
                     edge.target().hasClass('cm-filter-hidden');
      if (hidden) edge.addClass('cm-filter-hidden');
      else        edge.removeClass('cm-filter-hidden');
      // Also hide edge labels
      const elObj = _edgeLabels[edge.id()];
      if (elObj) elObj.div.style.display = hidden ? 'none' : '';
    });

    // Hide faction glows for hidden factions (hubs and members)
    Object.entries(_glowMap).forEach(([nodeId, glow]) => {
      const node = _cy.getElementById(nodeId);
      if (!node || !node.length) return;
      glow.style.display = node.hasClass('cm-filter-hidden') ? 'none' : '';
    });
  }

  // ── SVG namespace ────────────────────────────────────────────
  const _NS = 'http://www.w3.org/2000/svg';

  // ── Cytoscape state ─────────────────────────────────────────
  let _cy          = null;
  let _cloudLayer  = null;
  let _edgeSvg     = null; // SVG overlay for custom edge rendering
  let _cloudMap    = {}; // nodeId → wrapper div
  let _edgeLabels  = {}; // edgeId → {div, label, svgEls}
  let _glowMap     = {}; // 'hub_fId' → glow div

  // ── Physics integrator state ─────────────────────────────────
  // A single rAF loop drives every kind of motion in the mind map:
  //   • elastic mode (default) — rope physics on edges, spring tension
  //     between connected nodes during a drag, collision impulses,
  //     post-release coast to saved rest positions.
  //   • autolayout mode — Fruchterman-Reingold force field with
  //     temperature-cooled displacement, animated over ~3 s.
  // The loop sleeps when total kinetic energy drops below
  // PHYS_K.ENERGY_SLEEP and wakes on drag, autolayout, or filter
  // changes that displace edges.
  const _phys = {
    raf:        null,           // active rAF id; null = sleeping
    mode:       'elastic',      // 'elastic' | 'autolayout'
    draggedId:  null,           // node currently held by the user
    layoutEnd:  0,              // performance.now() target end of autolayout
    temp:       0,              // FR temperature (max per-step displacement)
    k:          80,             // FR optimal node distance (set by _runAutoLayout)
    nodeVel:    new Map(),      // nodeId → { vx, vy }
    nodeRest:   new Map(),      // nodeId → { x, y } target equilibrium
    edgeCP:     new Map(),      // edgeId → { x, y, vx, vy, tx, ty } control point
    history:    [],             // [Map<id, {x,y}>] undo stack, max 5 entries
  };

  // Last zoom level we wrote to the --cm-z CSS variable. _sync() only
  // updates the variable when zoom actually changes (not on every pan-
  // only or physics-tick frame), to keep the style invalidation cost
  // proportional to user-visible zoom changes. NaN forces the first
  // _sync() call to write.
  let _lastSyncedZoom = NaN;

  // ── Tunable physics constants ────────────────────────────────
  // All values are in node-position units (~px at zoom 1) per 16ms frame.
  // Damping values multiply velocity each frame (0..1, lower = more friction).
  //
  // Two regimes share these values:
  //   1. `elastic` (default) — rope-spring CPs + per-node spring back to
  //      saved equilibrium; loop sleeps when total KE < ENERGY_SLEEP.
  //   2. `autolayout` — Fruchterman–Reingold force field with temperature
  //      cooldown over AUTOLAYOUT_MS. Gravity pulls toward the viewport
  //      centre so disconnected components don't drift to infinity.
  //
  // Tweaking guidance:
  //   - Edges feel too stiff → lower EDGE_SPRING or raise EDGE_DAMP.
  //   - Nodes feel sluggish during drag → raise COLLISION_KICK.
  //   - FR layout flies apart → raise GRAVITY.
  //   - FR collapses inward → lower GRAVITY (or raise k via _runAutoLayout).
  //
  // See CLAUDE.md → "CloudMap architecture" → "Physics integrator" for
  // the full derivation, the rope-bend geometry note, and the list of
  // tried-and-reverted approaches (do NOT retry without reason).
  const PHYS_K = {
    // Very soft edge spring + extra inertia (less damping). At a typical
    // drag speed of 15 graph-px per frame the edge midpoint lags about
    // 0.15/0.04 · 15 ≈ 56 graph-px behind the chord midpoint at steady
    // state, AND the per-frame catch-up is small (cp moves only
    // (1−0.85)·spring·delta ≈ 0.6 % of the gap per frame from a standing
    // start), so the bow takes several frames to dissipate after the
    // drag stops — easy to see. (Visible mainly when the chord rotates;
    // pure translational drag along the chord direction can't bow a
    // quadratic Bézier no matter how soft the spring — the CP stays
    // colinear with the endpoints. Geometric constraint, not tuning.)
    EDGE_SPRING:    0.04,
    EDGE_DAMP:      0.85,
    // Neighbours are NOT pulled toward the held node. Only the
    // dragged node moves on its own; other nodes stay at their rest
    // positions until something physically pushes them (collision
    // impulse). Set to a small positive value (e.g. 0.04) to re-enable
    // a subtle "lean toward the dragged node" effect.
    NEIGH_PULL:     0.0,
    REST_PULL:      0.055,
    NODE_DAMP:      0.78,
    // Stronger collision impulse — nodes you push through visibly scoot
    // out of the way instead of hardly budging.
    COLLISION_KICK: 0.55,
    PADDING:        14,     // collision bbox padding around each node
    MAX_VEL:        45,     // hard cap to keep things stable
    GRAVITY:        0.0060, // pull toward viewport centre during autolayout
                            // (strong enough to keep disconnected components
                            // from drifting to the rim, weak enough that
                            // simple FR repulsion + attraction can still
                            // spread the graph out)
    ENERGY_SLEEP:   0.05,   // total KE per node to allow the loop to sleep
    AUTOLAYOUT_MS:  3500,   // how long the FR cooldown takes
  };

  function _physResetState() {
    if (_phys.raf) { cancelAnimationFrame(_phys.raf); _phys.raf = null; }
    _phys.nodeVel.clear();
    _phys.nodeRest.clear();
    _phys.edgeCP.clear();
    _phys.draggedId = null;
    _phys.mode = 'elastic';
    _phys.history = [];
    _phys.temp = 0;
    _lastSyncedZoom = NaN;   // force the next _sync() to write --cm-z
  }

  function _destroy() {
    _hideCtxMenu();
    _physResetState();
    Object.values(_edgeLabels).forEach(({ div, svgEls }) => {
      if (div) div.remove();
      if (svgEls) svgEls.forEach(el => el.remove());
    });
    if (_cy) { _cy.destroy(); _cy = null; }
    _cloudLayer = null;
    _edgeSvg    = null;
    _cloudMap   = {};
    _edgeLabels = {};
    _glowMap    = {};
  }

  // ── UI scaffold ─────────────────────────────────────────────
  function _buildFactionFilterLegend(factions, exclude = new Set()) {
    return Object.entries(factions)
      .filter(([fId]) => !exclude.has(fId))
      .map(([fId, f]) => `
        <label class="legend-item legend-filter" data-faction="${fId}">
          <input type="checkbox" ${_hiddenFactions.has(fId) ? '' : 'checked'}
                 ${dataOn('change', 'CloudMap.toggleFaction', fId)}>
          <div class="legend-dot" style="background:${_safeColor(f.color)}"></div>
          ${esc(f.badge || '⬡')} ${esc(f.name)}
        </label>`).join('');
  }

  function _buildUI(mode) {
    _currentMode = mode;
    _hiddenFactions = new Set(); // reset; _loadPositions() may repopulate from localStorage
    // Reset visual filter then load saved state for this mode
    _filters = { values: [], hiddenEdgeTypes: new Set(), focusId: null, focusHops: 2 };
    _focusMode = false;
    _loadVFilter();

    const container = document.getElementById('main-content');
    container.style.display = '';
    // Per-page edit toggle via the shared template — same look +
    // behaviour as /mapa/svet and /casova-osa. When on, the
    // `.cm-save-pos` layout-action buttons appear (gated by
    // `.map-toolbar.is-editing` in cloudmap.css).
    const editToggle = _renderEditToggleHtml();
    container.innerHTML = `
      <div class="map-container">
        <div class="map-toolbar ${_editing ? 'is-editing' : ''}">
          <div class="map-title">☁ ${esc(I18n.t('cloudmap.title'))}</div>
          <a href="#/mapa/frakce"    class="map-mode-btn ${mode==='frakce'    ?'active':''}">${esc(I18n.t('cloudmap.modeFactions'))}</a>
          <a href="#/mapa/vztahy"    class="map-mode-btn ${mode==='vztahy'    ?'active':''}">${esc(I18n.t('cloudmap.modeRelations'))}</a>
          <a href="#/mapa/tajemstvi" class="map-mode-btn ${mode==='tajemstvi' ?'active':''}">${esc(I18n.t('cloudmap.modeMysteries'))}</a>
          <button class="map-mode-btn cm-save-pos"${dataAction('CloudMap.runAutoLayout')} title="${esc(I18n.t('cloudmap.autoLayoutTitle'))}">✨ ${esc(I18n.t('cloudmap.autoLayout'))}</button>
          ${mode === 'frakce' ? `<button class="map-mode-btn cm-save-pos"${dataAction('CloudMap.runDagreLayout')} title="${esc(I18n.t('cloudmap.hierarchyTitle'))}">⊞ ${esc(I18n.t('cloudmap.hierarchy'))}</button>` : ''}
          <button class="map-mode-btn cm-save-pos cm-undo-layout"${dataAction('CloudMap.undoLayout')} title="${esc(I18n.t('cloudmap.undoLayoutTitle'))}">↶ ${esc(I18n.t('cloudmap.undoLayout'))}</button>
          <button class="map-mode-btn cm-save-pos"${dataAction('CloudMap.resetLayout')} title="${esc(I18n.t('cloudmap.resetLayoutTitle'))}">⟳ ${esc(I18n.t('cloudmap.resetLayout'))}</button>
          <button class="map-mode-btn cm-save-pos"${dataAction('CloudMap.savePositions')} title="${esc(I18n.t('cloudmap.savePositionsTitle'))}">💾 ${esc(I18n.t('cloudmap.savePositions'))}</button>
          <span class="map-hint">${esc(I18n.t('cloudmap.toolbarHint'))}</span>
          ${editToggle}
        </div>
        ${_buildFilterBar(mode)}
        <div id="cy-container"></div>
        <div class="map-legend" id="map-legend"></div>
      </div>
    `;

    // Bridge TagFilter's 'tf-change' CustomEvent into the filter state.
    // Attach to the per-render `.map-container` (created fresh by the
    // innerHTML above and an ancestor of the filter bar the chips live
    // in), NOT the persistent `#main-content` — innerHTML replaces a
    // node's CHILDREN, so a listener on #main-content would survive
    // every re-render and accumulate (a leak). The freshly-built
    // .map-container is discarded with the next innerHTML swap, taking
    // its listener with it.
    const mapContainer = container.querySelector('.map-container');
    if (mapContainer) mapContainer.addEventListener('tf-change', (ev) => {
      if (ev.target && ev.target.id === 'cm-filter') {
        _setFilterValues(ev.detail.values);
      }
    });
  }

  // Per-mode toolbar row: one TagFilter for free-text chip filters (name,
  // status, species, faction, tag, …), edge-type toggles where relevant,
  // focus toggle, clear button.
  function _buildFilterBar(mode) {
    // Edge-type chips depend on mode
    let edgeChips = '';
    const buildEdgeChip = (t, label, color) => {
      const off = _filters.hiddenEdgeTypes.has(t) ? ' is-off' : '';
      return `<button type="button" class="cm-chip cm-chip-edge${off}" data-edge-type="${t}"
        ${dataAction('CloudMap.toggleEdgeType', t)} style="--chip-color:${color}">${esc(label)}</button>`;
    };
    if (mode === 'vztahy') {
      edgeChips = [
        ['commands',I18n.t('cloudmap.edgeCommands'),EDGE_COLORS.commands], ['ally',I18n.t('cloudmap.edgeAlly'),EDGE_COLORS.ally],
        ['enemy',I18n.t('cloudmap.edgeEnemy'),EDGE_COLORS.enemy], ['mission',I18n.t('cloudmap.edgeMission'),EDGE_COLORS.mission],
        ['mystery',I18n.t('cloudmap.edgeMystery'),EDGE_COLORS.mystery], ['negotiates',I18n.t('cloudmap.edgeNegotiates'),EDGE_COLORS.negotiates],
        ['captured_by',I18n.t('cloudmap.edgeCaptured'),EDGE_COLORS.captured_by], ['history',I18n.t('cloudmap.edgeHistory'),EDGE_COLORS.history],
        ['uncertain',I18n.t('cloudmap.edgeUncertain'),EDGE_COLORS.uncertain],
      ].map(([t,l,c]) => buildEdgeChip(t,l,c)).join('');
    } else if (mode === 'frakce') {
      edgeChips = [
        ['member',I18n.t('cloudmap.edgeMember'),CM_EDGE_COLORS.member], ['located_at',I18n.t('cloudmap.edgeLocation'),CM_EDGE_COLORS.located_at],
        ['commands',I18n.t('cloudmap.edgeCommands'),EDGE_COLORS.commands], ['negotiates',I18n.t('cloudmap.edgeNegotiates'),EDGE_COLORS.negotiates],
        ['ally',I18n.t('cloudmap.edgeAlly'),EDGE_COLORS.ally],
      ].map(([t,l,c]) => buildEdgeChip(t,l,c)).join('');
    }

    const focusOn  = _focusMode ? ' is-on' : '';
    const tfValue  = (_filters.values || []).join(',');
    return `
      <div class="map-filterbar">
        <div class="tf-mount cm-filter-mount"
             data-tf-id="cm-filter"
             data-tf-placeholder="${esc(I18n.t('cloudmap.filterPlaceholder'))}"
             data-tf-hint="${esc(I18n.t('cloudmap.filterHint'))}"
             data-tf-value="${esc(tfValue)}"></div>
        ${edgeChips ? `<div class="cm-chip-group cm-chip-group-edge" title="${esc(I18n.t('cloudmap.hideEdgeTypes'))}">${edgeChips}</div>` : ''}
        <button type="button" class="cm-focus-toggle${focusOn}"
                ${dataAction('CloudMap.toggleFocusMode')}
                title="${esc(I18n.t('cloudmap.focusTitle'))}">🎯 ${esc(I18n.t('cloudmap.focus'))}</button>
        <span class="cm-focus-hops" ${_focusMode ? '' : 'hidden'}>
          <input type="range" min="1" max="4" step="1" value="${_filters.focusHops}"
                 ${dataOn('input', 'CloudMap.setFocusHops', '$value')}>
          <span class="cm-focus-hops-val">${_filters.focusHops}</span> ${esc(I18n.t('cloudmap.hop'))}
        </span>
        <button type="button" class="cm-clear-filters"${dataAction('CloudMap.clearFilters')}
                title="${esc(I18n.t('cloudmap.clearFilters'))}">⨯</button>
      </div>`;
  }

  // ── Cytoscape init ───────────────────────────────────────────
  function _initCy(elements, layout) {
    // No `_cy.destroy()` here — every caller is a view builder reached
    // only via render(), which calls _destroy() (nulling _cy) first.

    // Defensive: drop any edge whose endpoints aren't both present as nodes.
    // The mind-palace is built from arbitrary user data, so a relationship to
    // a deleted character — or a location affiliated with a faction that has
    // no hub node (e.g. 'party', which now lives in settings.playerParty) —
    // would otherwise make cytoscape throw on construction and blank the
    // entire map. Dropping the stray edge keeps the rest of the map alive.
    const _nodeIds = new Set();
    for (const el of elements) {
      if (el.data && el.data.id !== undefined && el.data.source === undefined) _nodeIds.add(el.data.id);
    }
    elements = elements.filter(el => {
      const d = el.data || {};
      if (d.source === undefined) return true; // node — always keep
      const ok = _nodeIds.has(d.source) && _nodeIds.has(d.target);
      if (!ok) console.warn('[cloudmap] dropped edge with missing endpoint:', d.id, d.source, '→', d.target);
      return ok;
    });

    // If we have saved positions, use a preset layout instead of physics
    const savedPos = _loadPositions();
    if (savedPos) {
      // Inject saved positions into node data so preset layout can use them
      elements = elements.map(el => {
        if (el.data && el.data.id && savedPos[el.data.id]) {
          return { ...el, position: savedPos[el.data.id] };
        }
        return el;
      });
      layout = { name: 'preset', fit: false, padding: 70 };
    }

    const container = document.getElementById('cy-container');
    container.style.position = 'relative'; // needed for absolute cloud layer

    _cy = cytoscape({
      container,
      elements,
      style: [
        {
          // Invisible proxy node — sized to match the cloud card.
          // shape:rectangle tells Cytoscape to route edges to the actual
          // rectangle boundary, not to a circumscribed ellipse.
          selector: 'node',
          style: {
            'width':              'data(w)',
            'height':             'data(h)',
            'shape':              'rectangle',
            'background-opacity': 0,
            'border-width':       0,
            'label':              '',
            'min-zoomed-font-size': 0,
          }
        },
        {
          // Native edges are hidden — we render them as SVG with gaps for labels.
          // Cytoscape edges still exist for layout/physics; visuals are in _edgeSvg.
          selector: 'edge',
          style: {
            'width':         0,
            'opacity':       0,
            'line-opacity':  0,
            'overlay-opacity': 0,
          }
        },
        // Fading/highlighting only affects nodes (edges are drawn in SVG)
        { selector: 'node.faded',       style: { opacity: 0.07 } },
        { selector: 'node.highlighted', style: { opacity: 1    } },
        { selector: '.cm-filter-hidden', style: { opacity: 0, 'events': 'no' } },
      ],
      layout,
      minZoom: 0.25,
      maxZoom: 3,
      userZoomingEnabled:  true,
      userPanningEnabled:  true,
      boxSelectionEnabled: false,
    });

    // Single cloud layer holding both SVG edges and HTML cards. The
    // CSS `zoom` property is applied per-frame to give a "true" zoom
    // (re-flows layout, re-rasterises text at the new size) instead
    // of `transform: scale()` which would blit a cached texture and
    // produce blurry text. Pan is applied via a separate
    // `transform: translate()` since translate doesn't trigger
    // texture caching. Modern browsers (Chrome/Edge/Safari forever,
    // Firefox 126+) support `zoom` natively.
    _cloudLayer = document.createElement('div');
    _cloudLayer.id = 'cloud-layer';
    _cloudLayer.style.cssText =
      'position:absolute;inset:0;pointer-events:none;' +
      'transform-origin:0 0;overflow:visible;z-index:5;';
    container.appendChild(_cloudLayer);

    // SVG edge layer — first child of cloud layer so it renders below
    // glow divs and cloud cards. Inherits the layer's `zoom` so vector
    // paths re-rasterise crisply at any zoom level.
    _edgeSvg = document.createElementNS(_NS, 'svg');
    _edgeSvg.setAttribute('class', 'cm-edge-svg');
    _edgeSvg.style.cssText =
      'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;';
    _edgeSvg.setAttribute('width', '0');
    _edgeSvg.setAttribute('height', '0');
    _cloudLayer.insertBefore(_edgeSvg, _cloudLayer.firstChild);

    return _cy;
  }

  // ── Cloud placement ─────────────────────────────────────────
  function _addCloud(html, id) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:absolute;pointer-events:none;';
    wrapper.innerHTML = html;
    _cloudLayer.appendChild(wrapper);
    _cloudMap[id] = wrapper;
  }

  // Proxy node helper
  function _proxy(id, type, w, h, extra) {
    return { data: { id, type, w, h, ...extra } };
  }

  // ── Viewport sync ────────────────────────────────────────────
  // Crisp text at any zoom: instead of CSS `zoom` or `transform: scale`
  // on the layer (both of which can cause Chromium to texture-cache
  // the subtree and bilinear-resample, producing the "smeared text"
  // we kept fighting), we drive every visually-sized property in
  // `.cm-cloud` and descendants through `calc(<base>px * var(--cm-z))`
  // and update `--cm-z` on `_cloudLayer` whenever zoom changes. CSS
  // variables go through the cascade and trigger a real style
  // recomputation, so the browser MUST re-render text at the exact
  // pixel size for the current zoom. No texture cache.
  //
  // The `--cm-z` write is gated on actual zoom delta — pan-only and
  // physics-tick frames must NOT trigger a layout recalc on the
  // entire card subtree. We track the last-written value in
  // `_lastSyncedZoom`.
  //
  // Cards are positioned in **screen coordinates** here:
  //   wrapper.left = pos.x · zoom + pan.x − (w · zoom) / 2
  // The card's CSS-driven visual width is `calc(--cw * --cm-z)`
  // (matches `w · zoom`), so this centres the card on the node's
  // rendered position.
  //
  // SVG edges keep their own `transform: translate(pan) scale(zoom)`
  // applied directly to `_edgeSvg`. Vector graphics re-rasterise
  // crisply at any scale — that's not a texture-cache path. The
  // SVG must have `transform-origin: 0 0` (default is 50% 50%).
  //
  // See CLAUDE.md "CloudMap text scaling via CSS variable" for the
  // full rationale, including a list of what we tried and reverted.
  function _sync() {
    if (!_cy || !_cloudLayer) return;
    const pan  = _cy.pan();
    const zoom = _cy.zoom();

    // Update the CSS variable only when zoom actually changes.
    // Tolerance avoids floating-point chatter from re-firing relayout.
    // First-call / post-reset case: _lastSyncedZoom is NaN, and any
    // arithmetic with NaN yields NaN (which is NOT > 0.0005), so we
    // explicitly force a write when the cached value isn't a real
    // number. Without this guard cards stay at the fallback size of 1
    // forever (because --cm-z never gets written).
    if (!Number.isFinite(_lastSyncedZoom) ||
        Math.abs(zoom - _lastSyncedZoom) > 0.0005) {
      _cloudLayer.style.setProperty('--cm-z', zoom);
      _lastSyncedZoom = zoom;
    }

    // Layer itself is no longer zoomed/transformed — clear any leftover
    // values from older code paths (defensive; cssText sets neither).
    _cloudLayer.style.zoom = '';
    _cloudLayer.style.transform = '';

    // SVG edges scale via their own transform on the SVG element. SVG
    // is vector and re-rasterises crisply at any scale. transform-origin
    // must be 0 0 — SVG's default is 50% 50% which would offset edges.
    if (_edgeSvg) {
      _edgeSvg.style.transformOrigin = '0 0';
      _edgeSvg.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
    }

    _cy.nodes().forEach(node => {
      const id = node.id();
      const wrapper = _cloudMap[id];
      if (!wrapper) return;
      const pos = node.position();
      const w   = node.data('w');
      const h   = node.data('h');
      // Visual size on screen is (w · zoom) × (h · zoom). The CSS
      // calc handles scaling; we just centre the wrapper.
      wrapper.style.left = (pos.x * zoom + pan.x - (w * zoom) / 2) + 'px';
      wrapper.style.top  = (pos.y * zoom + pan.y - (h * zoom) / 2) + 'px';

      // Glow halo: native size scaled by zoom (CSS handles width/height
      // via calc; we only place the box).
      const glow = _glowMap[id];
      if (glow) {
        const gs    = glow.classList.contains('cm-glow-sm') ? 320 : 550;
        const visGS = gs * zoom;
        glow.style.left = (pos.x * zoom + pan.x - visGS / 2) + 'px';
        glow.style.top  = (pos.y * zoom + pan.y - visGS / 2) + 'px';
      }
    });

    _syncEdgeLabels();
  }

  // ── SVG edge rendering + HTML labels with true line gaps ───────
  // Cytoscape edges are hidden (opacity 0). We draw edges as SVG lines
  // inside _edgeSvg (which lives in the cloud layer, below clouds).
  // Labelled edges are split into two segments with a gap for the text.
  // HTML label divs sit in that gap, centred on the edge midpoint.

  const EDGE_LABEL_FONT   = '12px Inter, sans-serif';
  const EDGE_LABEL_LINE_H = 12 * 1.35;
  const LABEL_GAP_PAD     = 5;   // extra gap each side beyond text bounds

  function _dashArray(lineStyle, width) {
    if (lineStyle === 'dashed') return `${width * 4},${width * 3}`;
    if (lineStyle === 'dotted') return `${width},${width * 2.5}`;
    return '';
  }

  // Marker geometry — sizes in graph-coordinate units (userSpaceOnUse)
  const MARKER_TRI_W  = 14;   // triangle arrow length along edge
  const MARKER_TRI_H  = 10;   // triangle arrow width perpendicular to edge
  const MARKER_CIRC_R = 4.5;  // circle radius at source end
  const MARKER_CIRC_D = MARKER_CIRC_R * 2;
  // How far to inset line endpoints so markers don't overlap clouds
  const INSET_SRC     = MARKER_CIRC_R;       // circle centre sits on the line end
  const INSET_TGT     = MARKER_TRI_W - 1;    // triangle tip at refX, pull back

  // Ensure SVG marker definitions exist for a given colour
  function _ensureMarkers(color, markerId) {
    if (_edgeSvg.querySelector(`#${markerId}-tri`)) return;
    let defs = _edgeSvg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(_NS, 'defs');
      _edgeSvg.insertBefore(defs, _edgeSvg.firstChild);
    }
    // Triangle target arrow — tip is at refX (right edge of the marker box)
    const mTri = document.createElementNS(_NS, 'marker');
    mTri.setAttribute('id', `${markerId}-tri`);
    mTri.setAttribute('markerWidth', MARKER_TRI_W);
    mTri.setAttribute('markerHeight', MARKER_TRI_H);
    mTri.setAttribute('refX', MARKER_TRI_W);
    mTri.setAttribute('refY', MARKER_TRI_H / 2);
    mTri.setAttribute('orient', 'auto');
    mTri.setAttribute('markerUnits', 'userSpaceOnUse');
    const tri = document.createElementNS(_NS, 'path');
    tri.setAttribute('d', `M0,0 L${MARKER_TRI_W},${MARKER_TRI_H / 2} L0,${MARKER_TRI_H} Z`);
    tri.setAttribute('fill', color);
    mTri.appendChild(tri);
    defs.appendChild(mTri);
    // Circle source marker — centred on the line start
    const mCirc = document.createElementNS(_NS, 'marker');
    mCirc.setAttribute('id', `${markerId}-circ`);
    mCirc.setAttribute('markerWidth', MARKER_CIRC_D);
    mCirc.setAttribute('markerHeight', MARKER_CIRC_D);
    mCirc.setAttribute('refX', MARKER_CIRC_R);
    mCirc.setAttribute('refY', MARKER_CIRC_R);
    mCirc.setAttribute('orient', 'auto');
    mCirc.setAttribute('markerUnits', 'userSpaceOnUse');
    const circ = document.createElementNS(_NS, 'circle');
    circ.setAttribute('cx', MARKER_CIRC_R);
    circ.setAttribute('cy', MARKER_CIRC_R);
    circ.setAttribute('r', MARKER_CIRC_R);
    circ.setAttribute('fill', color);
    mCirc.appendChild(circ);
    defs.appendChild(mCirc);
  }

  // Returns the point where a ray from (cx,cy) in unit direction (udx,udy)
  // exits the axis-aligned rectangle centred at (cx,cy) with half-sizes (hw,hh).
  // Used to find where an edge leaves/enters each cloud card boundary.
  function _rectIntersect(cx, cy, hw, hh, udx, udy) {
    const tx = udx !== 0 ? hw / Math.abs(udx) : Infinity;
    const ty = udy !== 0 ? hh / Math.abs(udy) : Infinity;
    const t  = Math.min(tx, ty);
    return { x: cx + udx * t, y: cy + udy * t };
  }

  // Pill = horizontal stadium: flat top/bottom, semicircle caps at left/right.
  function _pillIntersect(cx, cy, hw, hh, udx, udy) {
    const r      = hh;                        // cap radius = half-height
    const flatHW = Math.max(0, hw - r);       // half-width of the flat portion
    const tx     = udx !== 0 ? flatHW / Math.abs(udx) : Infinity;
    const ty     = udy !== 0 ? hh / Math.abs(udy) : Infinity;
    if (tx < ty && udx !== 0) {
      // Exits through a semicircle cap
      const capCx = cx + Math.sign(udx) * flatHW;
      const t = r / Math.hypot(udx, udy);
      return { x: capCx + udx * t, y: cy + udy * t };
    }
    // Exits through flat top/bottom
    const t = Math.min(tx, ty);
    return { x: cx + udx * t, y: cy + udy * t };
  }

  // Choose intersection function based on node type
  function _nodeIntersect(node, cx, cy, hw, hh, udx, udy) {
    const kind = _nodeKind(node.data('type'));
    if (kind && kind.shape === 'pill') return _pillIntersect(cx, cy, hw, hh, udx, udy);
    return _rectIntersect(cx, cy, hw, hh, udx, udy);
  }

  function _addEdgeLabels() {
    // Clean up previous edge labels and SVG elements
    Object.values(_edgeLabels).forEach(({ div, svgEls }) => {
      if (div) div.remove();
      if (svgEls) svgEls.forEach(el => el.remove());
    });
    _edgeLabels = {};
    // Clear old marker defs
    if (_edgeSvg) {
      const oldDefs = _edgeSvg.querySelector('defs');
      if (oldDefs) oldDefs.remove();
    }

    _cy.edges().forEach(edge => {
      const label  = edge.data('label') || '';
      const color  = edge.data('color') || '#666';
      const width  = edge.data('width') || 2;
      const lStyle = edge.data('lineStyle') || 'solid';
      const eid    = edge.id();

      // Marker ID from colour (strip non-alphanumeric for valid SVG id)
      const markerId = 'mk-' + color.replace(/[^a-zA-Z0-9]/g, '');
      _ensureMarkers(color, markerId);

      // Two SVG path segments per edge (path1: src→gap, path2: gap→tgt).
      // Paths instead of lines so they can render as quadratic Béziers
      // driven by the rope-physics control point in _phys.edgeCP.
      const path1 = document.createElementNS(_NS, 'path');
      const path2 = document.createElementNS(_NS, 'path');
      const baseStyle = `stroke:${color};stroke-width:${width};opacity:0.82;` +
                        `stroke-linecap:round;fill:none;`;
      path1.setAttribute('style', baseStyle);
      path2.setAttribute('style', baseStyle);
      const dash = _dashArray(lStyle, width);
      if (dash) {
        path1.setAttribute('stroke-dasharray', dash);
        path2.setAttribute('stroke-dasharray', dash);
      }
      _edgeSvg.appendChild(path1);
      _edgeSvg.appendChild(path2);

      // HTML label div
      const div = document.createElement('div');
      div.className = 'cm-edge-label';
      if (label) {
        div.textContent = label;
        div.style.color = color;
      }
      _cloudLayer.appendChild(div);

      _edgeLabels[eid] = { div, label, svgEls: [path1, path2], markerId };
    });
  }

  // Build a map of visible parallel-edge groups, keyed by the unordered
  // node-pair. Each entry stores the ordered list of visible edge ids; the
  // index within that list + its size drive perpendicular offset so multiple
  // relations between the same two nodes fan out instead of overlapping.
  function _buildParallelGroups() {
    const groups = new Map();
    _cy.edges().forEach(edge => {
      if (edge.hasClass('cm-filter-hidden')) return;
      const s = edge.source(), t = edge.target();
      if (s.hasClass('cm-filter-hidden') || t.hasClass('cm-filter-hidden')) return;
      const a = s.id(), b = t.id();
      const key = a < b ? `${a}||${b}` : `${b}||${a}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(edge.id());
    });
    // Sort deterministically so layout is stable across renders.
    groups.forEach(arr => arr.sort());
    const info = {};
    groups.forEach(arr => {
      arr.forEach((eid, idx) => { info[eid] = { idx, count: arr.length }; });
    });
    return info;
  }

  function _syncEdgeLabels() {
    // Parallel edges between the same two nodes get a perpendicular CP
    // offset so they bow apart instead of overlapping. The integrator
    // uses cp.tx/cp.ty (set below) as the spring target, so the curve
    // settles to a fan even at rest.
    const PARALLEL_FAN  = 36;
    const parallelInfo  = _buildParallelGroups();
    // Edge label divs live in the un-zoomed _cloudLayer (cards now
    // position themselves in screen coords; see _sync). We project
    // each label's graph-coord midpoint to screen coords and scale
    // its width by zoom; font-size scales via the --cm-z CSS var.
    const _pan  = _cy ? _cy.pan()  : { x: 0, y: 0 };
    const _zoom = _cy ? _cy.zoom() : 1;

    Object.entries(_edgeLabels).forEach(([eid, rec]) => {
      const { div, label, svgEls, markerId } = rec;
      const [path1, path2] = svgEls;
      const edge = _cy.getElementById(eid);

      const hideAll = () => {
        div.style.visibility = 'hidden';
        path1.setAttribute('visibility', 'hidden');
        path2.setAttribute('visibility', 'hidden');
      };

      if (!edge || !edge.length || edge.hasClass('cm-filter-hidden')) { hideAll(); return; }

      const srcNode = edge.source();
      const tgtNode = edge.target();
      if (srcNode.hasClass('cm-filter-hidden') || tgtNode.hasClass('cm-filter-hidden')) {
        hideAll(); return;
      }

      const sp = srcNode.position();
      const tp = tgtNode.position();
      const dx  = tp.x - sp.x;
      const dy  = tp.y - sp.y;
      const len = Math.hypot(dx, dy) || 1;
      const udx = dx / len;
      const udy = dy / len;

      // Cards and SVG both live in the same `zoom`-scaled layer, so
      // graph-coord half-extents at native card sizes are correct.
      const srcRaw = _nodeIntersect(srcNode, sp.x, sp.y,
                       srcNode.data('w') / 2, srcNode.data('h') / 2,  udx,  udy);
      const tgtRaw = _nodeIntersect(tgtNode, tp.x, tp.y,
                       tgtNode.data('w') / 2, tgtNode.data('h') / 2, -udx, -udy);

      const srcExit  = { x: srcRaw.x + udx * INSET_SRC, y: srcRaw.y + udy * INSET_SRC };
      const tgtEntry = { x: tgtRaw.x - udx * INSET_TGT, y: tgtRaw.y - udy * INSET_TGT };

      const visLen = Math.hypot(tgtRaw.x - srcRaw.x, tgtRaw.y - srcRaw.y);
      if (visLen < 10) { hideAll(); return; }

      // Geometric chord midpoint (graph coords)
      const midX = (srcRaw.x + tgtRaw.x) / 2;
      const midY = (srcRaw.y + tgtRaw.y) / 2;

      // Parallel-fan perpendicular offset for the CP target. Sign is
      // anchored to the canonical sorted pair so flipping source/target
      // doesn't cancel out in a multi-edge group.
      const pInfo = parallelInfo[eid] || { idx: 0, count: 1 };
      let perpAmt = 0;
      if (pInfo.count > 1) {
        const sign = srcNode.id() < tgtNode.id() ? 1 : -1;
        perpAmt = (pInfo.idx - (pInfo.count - 1) / 2) * PARALLEL_FAN * sign;
      }
      const targetCPx = midX + (-udy) * perpAmt;
      const targetCPy = midY + ( udx) * perpAmt;

      // Stash the target on the CP record so the integrator springs
      // toward it next frame. Initialize lazily if first sight, and
      // snap to target ONLY when the system is genuinely at rest (no
      // rAF scheduled, no node being dragged, not running autolayout).
      // The previous `!_phys.raf`-only check was vulnerable to brief
      // rAF flicker between tick rescheduling and the next mousemove,
      // which would zero out the rope-lag mid-drag and make the bow
      // invisible. The combined check is safe — rope physics only
      // gets snapped away once the user has actually let go.
      let cp = _phys.edgeCP.get(eid);
      if (!cp) {
        cp = { x: targetCPx, y: targetCPy, vx: 0, vy: 0, tx: targetCPx, ty: targetCPy };
        _phys.edgeCP.set(eid, cp);
      } else {
        cp.tx = targetCPx;
        cp.ty = targetCPy;
        const atRest = _phys.raf === null
                    && _phys.draggedId === null
                    && _phys.mode !== 'autolayout';
        if (atRest) {
          cp.x = targetCPx; cp.y = targetCPy;
          cp.vx = 0; cp.vy = 0;
        }
      }

      // Mirror Cytoscape faded/highlighted opacity on SVG paths + label
      const isFaded = edge.hasClass('faded');
      const svgOpacity = isFaded ? 0.07 : 0.82;
      path1.style.opacity = svgOpacity;
      path2.style.opacity = svgOpacity;
      div.style.opacity   = isFaded ? 0.07 : 1;
      path1.setAttribute('visibility', 'visible');
      path2.setAttribute('visibility', 'visible');

      // The full edge curve is one quadratic Bézier through (srcExit,
      // cp, tgtEntry). We render the visible part as TWO sub-curves
      // with a parametric gap around t=0.5 so the label can sit in
      // the middle. Sub-curves are mathematically halves of the same
      // parent curve (de Casteljau / blossom split) — no extra arc
      // gets injected per segment, which is what was causing the
      // "double-bow" overbend.
      //
      // For a quadratic with control polygon (P0, P1, P2), the
      // sub-curve from t=u to t=v has control polygon
      //   Q0 = B(u)
      //   Q1 = (1-u)(1-v)·P0 + ((1-u)v + u(1-v))·P1 + uv·P2
      //   Q2 = B(v)
      // For sub1 (u=0, v=t1):  Q1 = (1-t1)·P0 + t1·P1 = src·(1-t1) + cp·t1
      // For sub2 (u=t2, v=1):  Q1 = (1-t2)·P1 + t2·P2 = cp·(1-t2) + tgt·t2

      // Curve midpoint (B(0.5)) in graph coords — where the label sits
      // along the curve. Both label and edge live in the same zoomed
      // layer, so graph coords are the right units for both.
      const labelX = 0.25 * srcExit.x + 0.5 * cp.x + 0.25 * tgtEntry.x;
      const labelY = 0.25 * srcExit.y + 0.5 * cp.y + 0.25 * tgtEntry.y;

      if (label && visLen > 50) {
        // ── Labelled curve ──
        const labelW = Math.max(36, visLen - 20);
        // Width is in screen-px (label div is in the un-zoomed cloud
        // layer); labelW is in graph-px so multiply by zoom.
        div.style.width = (labelW * _zoom) + 'px';

        const lines = _wrap(label, EDGE_LABEL_FONT, labelW);
        let maxLineW = 0;
        for (const ln of lines) {
          _ctx.font = EDGE_LABEL_FONT;
          maxLineW = Math.max(maxLineW, _ctx.measureText(ln).width);
        }
        const gapHalfLen = Math.min(maxLineW / 2 + LABEL_GAP_PAD, visLen / 2 - 4);
        const halfT = Math.min(0.45, gapHalfLen / Math.max(1, visLen));
        const t1 = 0.5 - halfT;
        const t2 = 0.5 + halfT;

        // Sub-curve 1: t ∈ [0, t1]
        const u1 = 1 - t1;
        const sub1Q1x = u1 * srcExit.x + t1 * cp.x;
        const sub1Q1y = u1 * srcExit.y + t1 * cp.y;
        const sub1Q2x = u1 * u1 * srcExit.x + 2 * u1 * t1 * cp.x + t1 * t1 * tgtEntry.x;
        const sub1Q2y = u1 * u1 * srcExit.y + 2 * u1 * t1 * cp.y + t1 * t1 * tgtEntry.y;
        path1.setAttribute('d',
          `M ${srcExit.x} ${srcExit.y} Q ${sub1Q1x} ${sub1Q1y} ${sub1Q2x} ${sub1Q2y}`);
        path1.setAttribute('marker-start', `url(#${markerId}-circ)`);
        path1.removeAttribute('marker-end');

        // Sub-curve 2: t ∈ [t2, 1]
        const u2 = 1 - t2;
        const sub2Q0x = u2 * u2 * srcExit.x + 2 * u2 * t2 * cp.x + t2 * t2 * tgtEntry.x;
        const sub2Q0y = u2 * u2 * srcExit.y + 2 * u2 * t2 * cp.y + t2 * t2 * tgtEntry.y;
        const sub2Q1x = u2 * cp.x + t2 * tgtEntry.x;
        const sub2Q1y = u2 * cp.y + t2 * tgtEntry.y;
        path2.setAttribute('d',
          `M ${sub2Q0x} ${sub2Q0y} Q ${sub2Q1x} ${sub2Q1y} ${tgtEntry.x} ${tgtEntry.y}`);
        path2.removeAttribute('marker-start');
        path2.setAttribute('marker-end', `url(#${markerId}-tri)`);

        let angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (angle > 90 || angle < -90) angle += angle > 0 ? -180 : 180;
        div.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
        // Project graph-coord label midpoint to screen coords (the
        // div lives in the un-zoomed _cloudLayer).
        div.style.left = (labelX * _zoom + _pan.x) + 'px';
        div.style.top  = (labelY * _zoom + _pan.y) + 'px';
        div.style.visibility = 'visible';
      } else {
        // ── Unlabelled or too-short for label gap: single Bézier ──
        div.style.visibility = 'hidden';
        path1.setAttribute('d',
          `M ${srcExit.x} ${srcExit.y} Q ${cp.x} ${cp.y} ${tgtEntry.x} ${tgtEntry.y}`);
        path1.setAttribute('marker-start', `url(#${markerId}-circ)`);
        path1.setAttribute('marker-end',   `url(#${markerId}-tri)`);
        path2.setAttribute('visibility', 'hidden');
      }
    });
  }

  // ── Physics integrator: drag handlers + main loop ────────────
  // Drag events feed the integrator; they don't move anything by
  // themselves. Cytoscape moves the dragged node natively (the user
  // is dragging it directly), and we react to that motion in the
  // physics step: rope CPs lag behind, neighbors get spring-pulled,
  // collisions inject impulses on overlapping nodes.

  function _ensureNodeState(id, pos) {
    if (!_phys.nodeVel.has(id))  _phys.nodeVel.set(id, { vx: 0, vy: 0 });
    if (!_phys.nodeRest.has(id)) _phys.nodeRest.set(id, { x: pos.x, y: pos.y });
  }

  function _onDragStart(evt) {
    // If the user grabs anything mid-autolayout, freeze the FR run at
    // its current state and switch back to elastic mode — they want
    // direct control, not an animation fighting them.
    if (_phys.mode === 'autolayout') _finishAutoLayout();

    const id = evt.target.id();
    _phys.draggedId = id;
    _ensureNodeState(id, evt.target.position());
    const v = _phys.nodeVel.get(id);
    if (v) { v.vx = 0; v.vy = 0; }
    _physWake();
  }

  function _onDragNode(evt) {
    const id = evt.target.id();
    if (id !== _phys.draggedId) return;
    // The dragged node's "rest" follows the pointer so when the user
    // releases, that becomes the new equilibrium.
    const p = evt.target.position();
    _phys.nodeRest.set(id, { x: p.x, y: p.y });
    _physWake();
  }

  function _onDragFreeNode(evt) {
    const id = evt.target.id();
    if (id !== _phys.draggedId) return;
    const p = evt.target.position();
    _phys.nodeRest.set(id, { x: p.x, y: p.y });
    _phys.draggedId = null;
    _physWake();  // continue settling
  }

  /** Honour the OS "reduce motion" setting. When on, the integrator
   *  computes its final layout in a single synchronous pass instead of
   *  animating frame-by-frame (springs/FR cooldown are fast-forwarded). */
  function _prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
  }

  // Wake the integrator if it's sleeping. Self-stops once kinetic
  // energy drops below ENERGY_SLEEP and no drag/autolayout is active.
  function _physWake() {
    if (_phys.raf || !_cy) return;

    // Reduced motion: settle synchronously and skip the rAF animation.
    // A drag is inherently interactive (the pointer drives it frame by
    // frame), so only the non-drag settle / autolayout cooldown is
    // fast-forwarded — to the same equilibrium the animation would
    // reach, just without the in-between frames.
    if (_prefersReducedMotion() && _phys.draggedId === null) {
      if (_phys.mode === 'autolayout') _phys.layoutEnd = 0;   // finish FR this pass
      let guard = 0;
      do { _physStep(); } while (
        guard++ < 600 &&
        (_phys.mode === 'autolayout' || _physKineticEnergy() > PHYS_K.ENERGY_SLEEP)
      );
      _phys.raf = null;
      _sync();   // one final clean redraw
      return;
    }

    const tick = () => {
      _physStep();
      const shouldRun =
        _phys.draggedId !== null ||
        _phys.mode === 'autolayout' ||
        _physKineticEnergy() > PHYS_K.ENERGY_SLEEP;
      if (shouldRun) {
        _phys.raf = requestAnimationFrame(tick);
      } else {
        _phys.raf = null;
        _sync();   // one final clean redraw
      }
    };
    _phys.raf = requestAnimationFrame(tick);
  }

  function _physKineticEnergy() {
    let ke = 0;
    for (const v of _phys.nodeVel.values()) ke += v.vx * v.vx + v.vy * v.vy;
    for (const c of _phys.edgeCP.values())  ke += c.vx * c.vx + c.vy * c.vy;
    // Normalize per moving thing so big graphs don't refuse to sleep.
    const denom = Math.max(1, _phys.nodeVel.size + _phys.edgeCP.size);
    return ke / denom;
  }

  function _physStep() {
    if (!_cy) return;   // guard against tick fired between _destroy and rAF cancel
    if (_phys.mode === 'autolayout') _applyAutoLayoutForces();
    else                              _applyElasticForces();

    _resolveCollisions();
    _integrateNodes();
    _integrateEdgeCPs();

    // Render: clouds + edges. _sync() also calls _syncEdgeLabels()
    // which both consumes and updates each edge's CP target (tx,ty)
    // for the parallel-fan effect.
    _sync();

    if (_phys.mode === 'autolayout') {
      _phys.temp *= 0.974;     // ~3 s cooldown when starting from temp ≈ k
      if (performance.now() > _phys.layoutEnd || _phys.temp < 0.4) {
        _finishAutoLayout();
      }
    }
  }

  // ── Force application: elastic mode ──────────────────────────
  function _applyElasticForces() {
    const draggedId = _phys.draggedId;

    // Rest-pull: every undragged node is gently sprung toward its
    // saved equilibrium so the layout the user curated holds shape.
    _cy.nodes().forEach(node => {
      const id = node.id();
      if (id === draggedId) return;
      const p = node.position();
      const v = _phys.nodeVel.get(id);
      const r = _phys.nodeRest.get(id);
      if (!v || !r) return;
      v.vx += (r.x - p.x) * PHYS_K.REST_PULL;
      v.vy += (r.y - p.y) * PHYS_K.REST_PULL;
    });

    // Neighbor pull: while a node is held, its 1-hop connected
    // neighbours can be tugged toward it (set PHYS_K.NEIGH_PULL > 0
    // to enable). Disabled by default — only the dragged node moves
    // on its own; other nodes stay put until physically pushed by a
    // collision impulse.
    if (draggedId && PHYS_K.NEIGH_PULL > 0) {
      const dragNode = _cy.getElementById(draggedId);
      if (dragNode && dragNode.length) {
        const dp   = dragNode.position();
        const seen = new Set();
        dragNode.connectedEdges().forEach(edge => {
          const other = edge.source().id() === draggedId ? edge.target() : edge.source();
          const oid = other.id();
          if (seen.has(oid) || oid === draggedId) return;
          seen.add(oid);
          if (other.hasClass('cm-filter-hidden')) return;
          const op = other.position();
          const v  = _phys.nodeVel.get(oid);
          if (!v) return;
          v.vx += (dp.x - op.x) * PHYS_K.NEIGH_PULL;
          v.vy += (dp.y - op.y) * PHYS_K.NEIGH_PULL;
        });
      }
    }
  }

  // ── Force application: Fruchterman-Reingold auto-layout ──────
  // Classic FR: every pair repels by k²/d, every edge attracts by
  // d²/k, plus a weak gravitational pull toward the viewport centre
  // for compactness. Velocities are reset each frame and capped by
  // the current "temperature" so the cooldown produces a smooth
  // settling motion instead of jitter.
  function _applyAutoLayoutForces() {
    const k = _phys.k;
    const nodes = _cy.nodes().filter(n => !n.hasClass('cm-filter-hidden'));
    const N = nodes.length;
    if (!N) return;

    // Reset accumulated velocities — FR is re-evaluated from
    // scratch each iteration.
    nodes.forEach(n => {
      const v = _phys.nodeVel.get(n.id());
      if (v) { v.vx = 0; v.vy = 0; }
    });

    // Cache positions to avoid repeated property access in O(N²) loop.
    const ps = new Array(N);
    for (let i = 0; i < N; i++) ps[i] = { id: nodes[i].id(), p: nodes[i].position() };

    // Pairwise repulsion
    for (let i = 0; i < N; i++) {
      const a = ps[i];
      const va = _phys.nodeVel.get(a.id);
      for (let j = i + 1; j < N; j++) {
        const b = ps[j];
        const dx = b.p.x - a.p.x;
        const dy = b.p.y - a.p.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1) {
          // Coincident nodes: push them apart with a tiny random kick
          dist = 1;
          const jx = Math.random() - 0.5, jy = Math.random() - 0.5;
          if (va) { va.vx -= jx; va.vy -= jy; }
          const vb0 = _phys.nodeVel.get(b.id);
          if (vb0) { vb0.vx += jx; vb0.vy += jy; }
          continue;
        }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (va) { va.vx -= fx; va.vy -= fy; }
        const vb = _phys.nodeVel.get(b.id);
        if (vb) { vb.vx += fx; vb.vy += fy; }
      }
    }

    // Edge attraction
    _cy.edges().forEach(edge => {
      if (edge.hasClass('cm-filter-hidden')) return;
      const sId = edge.source().id();
      const tId = edge.target().id();
      const sp = edge.source().position();
      const tp = edge.target().position();
      const dx = tp.x - sp.x, dy = tp.y - sp.y;
      let dist = Math.hypot(dx, dy);
      if (dist < 1) dist = 1;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const vs = _phys.nodeVel.get(sId);
      const vt = _phys.nodeVel.get(tId);
      if (vs) { vs.vx += fx; vs.vy += fy; }
      if (vt) { vt.vx -= fx; vt.vy -= fy; }
    });

    // ── Gravity toward viewport centre (compactness, anti-outlier) ──
    const cont = _cy.container();
    if (cont) {
      const rect = cont.getBoundingClientRect();
      const pan  = _cy.pan();
      const zoom = _cy.zoom();
      const cx = (rect.width  / 2 - pan.x) / zoom;
      const cy = (rect.height / 2 - pan.y) / zoom;
      for (let i = 0; i < N; i++) {
        const v = _phys.nodeVel.get(ps[i].id);
        if (!v) continue;
        v.vx += (cx - ps[i].p.x) * PHYS_K.GRAVITY;
        v.vy += (cy - ps[i].p.y) * PHYS_K.GRAVITY;
      }
    }

    // ── Cap displacement by current temperature ──
    const t = _phys.temp;
    for (let i = 0; i < N; i++) {
      const v = _phys.nodeVel.get(ps[i].id);
      if (!v) continue;
      const speed = Math.hypot(v.vx, v.vy);
      if (speed > t) {
        v.vx = (v.vx / speed) * t;
        v.vy = (v.vy / speed) * t;
      }
    }
  }

  // ── Collision impulses (replaces snap-displace _bounce) ──────
  // Overlapping nodes get a velocity kick proportional to penetration
  // depth along the smallest-overlap axis. Self-stabilising: as nodes
  // separate the impulse magnitude shrinks. The dragged node is
  // immovable (infinite mass) — only the other node receives the
  // kick, which feels right because the user is actively holding
  // the dragged one.
  function _resolveCollisions() {
    const nodes = _cy.nodes();
    const PAD   = PHYS_K.PADDING;
    const draggedId = _phys.draggedId;
    const N = nodes.length;

    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      if (a.hasClass('cm-filter-hidden')) continue;
      const ap = a.position();
      const aHW = a.data('w') / 2 + PAD;
      const aHH = a.data('h') / 2 + PAD;
      const aId = a.id();

      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        if (b.hasClass('cm-filter-hidden')) continue;
        const bp = b.position();
        const bHW = b.data('w') / 2 + PAD;
        const bHH = b.data('h') / 2 + PAD;

        const dx = bp.x - ap.x;
        const dy = bp.y - ap.y;
        const ox = (aHW + bHW) - Math.abs(dx);
        const oy = (aHH + bHH) - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;

        const horizontal = ox < oy;
        const k  = PHYS_K.COLLISION_KICK;
        const va = _phys.nodeVel.get(aId);
        const vb = _phys.nodeVel.get(b.id());
        if (horizontal) {
          const dir = Math.sign(dx) || 1;
          if (vb && b.id() !== draggedId) vb.vx += dir * ox * k;
          if (va && aId      !== draggedId) va.vx -= dir * ox * k;
        } else {
          const dir = Math.sign(dy) || 1;
          if (vb && b.id() !== draggedId) vb.vy += dir * oy * k;
          if (va && aId      !== draggedId) va.vy -= dir * oy * k;
        }
      }
    }
  }

  // ── Integration: nodes ───────────────────────────────────────
  function _integrateNodes() {
    const draggedId = _phys.draggedId;
    _cy.batch(() => {
      _cy.nodes().forEach(node => {
        const id = node.id();
        if (id === draggedId) return;
        const v = _phys.nodeVel.get(id);
        if (!v) return;
        // Damping
        v.vx *= PHYS_K.NODE_DAMP;
        v.vy *= PHYS_K.NODE_DAMP;
        // Cap
        const speed = Math.hypot(v.vx, v.vy);
        if (speed > PHYS_K.MAX_VEL) {
          v.vx = (v.vx / speed) * PHYS_K.MAX_VEL;
          v.vy = (v.vy / speed) * PHYS_K.MAX_VEL;
        }
        if (Math.abs(v.vx) < 0.001 && Math.abs(v.vy) < 0.001) return;
        const p = node.position();
        node.position({ x: p.x + v.vx, y: p.y + v.vy });
      });
    });
  }

  // ── Integration: edge control points (rope physics) ──────────
  // Each edge has a control point with its own mass and velocity.
  // It springs toward a target stashed by _syncEdgeLabels (which is
  // the geometric midpoint plus any parallel-fan offset). The lag
  // between the target's motion and the CP's response is what gives
  // the line its rubber-band sag during fast drags.
  function _integrateEdgeCPs() {
    _cy.edges().forEach(edge => {
      const eid = edge.id();
      if (edge.hasClass('cm-filter-hidden')) return;
      let cp = _phys.edgeCP.get(eid);
      if (!cp) {
        const sp = edge.source().position(), tp = edge.target().position();
        cp = { x: (sp.x + tp.x) / 2, y: (sp.y + tp.y) / 2, vx: 0, vy: 0,
               tx: null, ty: null };
        _phys.edgeCP.set(eid, cp);
      }
      let tx = cp.tx, ty = cp.ty;
      if (tx == null || ty == null) {
        const sp = edge.source().position(), tp = edge.target().position();
        tx = (sp.x + tp.x) / 2;
        ty = (sp.y + tp.y) / 2;
      }
      cp.vx += (tx - cp.x) * PHYS_K.EDGE_SPRING;
      cp.vy += (ty - cp.y) * PHYS_K.EDGE_SPRING;
      cp.vx *= PHYS_K.EDGE_DAMP;
      cp.vy *= PHYS_K.EDGE_DAMP;
      cp.x += cp.vx;
      cp.y += cp.vy;
    });
  }

  // ── Auto-layout (Fruchterman-Reingold with cooling animation) ─
  // Snapshots current positions to the undo stack, sets up the FR
  // temperature, and lets the integrator do the rest. The cooldown
  // animation is the user-visible "settling into ideal positions"
  // motion. On finish, new positions become the saved rest and
  // persist to localStorage automatically.
  function _runAutoLayout() {
    const nodes = _cy.nodes().filter(n => !n.hasClass('cm-filter-hidden'));
    const N = nodes.length;
    if (!N || !_cy) return;

    _physSnapshotForUndo();

    // Derive FR optimal distance `k` from the cards' actual sizes —
    // typical 168×~130 cards → k ≈ 210, giving roughly one card-width
    // of breathing room between connected cards.
    let totalSize = 0;
    nodes.forEach(n => { totalSize += (n.data('w') + n.data('h')) / 2; });
    const avgNodeSize = totalSize / N;
    _phys.k = Math.max(140, avgNodeSize * 1.4);
    _phys.temp = _phys.k * 0.5;
    _phys.mode = 'autolayout';
    _phys.layoutEnd = performance.now() + PHYS_K.AUTOLAYOUT_MS;
    _phys.draggedId = null;

    // ── Random initial scatter ──
    // Re-running FR from the existing layout often refines a bad
    // arrangement instead of finding a good one (the optimiser gets
    // stuck near the starting configuration). Scattering nodes around
    // a circle of radius ~ k·√N before FR runs gives the algorithm
    // freedom to explore — it will then attract connected nodes
    // together while gravity prevents the whole graph from flying
    // apart. Empirically removes most of the "stuck with crossings"
    // outcomes from refining-only runs.
    const scatterR = _phys.k * Math.sqrt(Math.max(1, N)) * 0.45;
    nodes.forEach((node, i) => {
      const id = node.id();
      // Distribute on a Fibonacci-spiral-ish lattice so initial
      // positions are spread evenly, then jitter so FR has gradient
      // to climb out of any accidental symmetries.
      const golden = Math.PI * (3 - Math.sqrt(5));
      const r = scatterR * Math.sqrt((i + 0.5) / N);
      const theta = i * golden + Math.random() * 0.4;
      node.position({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
      _phys.nodeVel.set(id, { vx: 0, vy: 0 });
      _ensureNodeState(id, node.position());
    });

    _updateLayoutBtnStates();
    _physWake();
  }

  function _finishAutoLayout() {
    _phys.mode = 'elastic';
    _phys.temp = 0;

    // Post-FR: try to reduce edge crossings via swap-based simulated
    // annealing. FR alone minimises stress (distance-mismatch), not
    // crossings — for sparse graphs the two are correlated, but we
    // can usually find a few easy wins by swapping pairs of nodes.
    _reduceCrossings();

    // Snap each node's rest to wherever it ended up — the layout
    // we just animated to is now the equilibrium.
    _cy.nodes().forEach(node => {
      const id = node.id();
      const p  = node.position();
      _phys.nodeRest.set(id, { x: p.x, y: p.y });
    });
    _savePositions();
    _updateLayoutBtnStates();
    // Re-fit the viewport so the freshly-arranged graph is centred
    // and sized to fill the available area. Without this the user
    // often had to manually pan/zoom to find their cards after a run.
    // Reduced motion: snap the fit instead of animating the pan/zoom.
    if (_cy && _cy.nodes().nonempty()) {
      if (_prefersReducedMotion()) { _cy.fit(undefined, 80); _sync(); }
      else _cy.animate({ fit: { padding: 80 } }, { duration: 450, easing: 'ease-out-cubic' });
    }
  }

  // Hierarchical (dagre) layout — wired for the `frakce` mode, where the
  // faction-hub → command-chain → location structure is a natural top-down
  // hierarchy. Dagre is registered globally in app.js (`cytoscape.use`) and
  // bundled by cytoscape-dagre 4. Unlike FR (which runs through the physics
  // integrator), dagre is a one-shot Cytoscape layout: it positions nodes,
  // we adopt those positions as the physics rest + save them, so the
  // arrangement persists and the integrator holds it until the user drags.
  function _runDagreLayout() {
    if (!_cy || _currentMode !== 'frakce' || _cy.nodes().empty()) return;
    _physSnapshotForUndo();
    // Rank on the STRUCTURAL hierarchy only: hub→member (`mbr_`), hub→location
    // (`loc_`), and command chains (`*-commands`). Lateral cross-faction edges
    // (ally / negotiates) still render as SVG but are excluded from the layout
    // so they don't drag faction hubs out of the top rank. All nodes are
    // included, so every edge endpoint resolves within the subset.
    const hierEdges = _cy.edges().filter(function (e) {
      var id = e.id();
      return id.indexOf('mbr_') === 0 || id.indexOf('loc_') === 0 || /-commands$/.test(id);
    });
    const layout = _cy.layout({
      name:      'dagre',
      eles:      _cy.nodes().union(hierEdges),
      rankDir:   'TB',   // faction hubs on top; members + locations descend
      nodeSep:   55,
      rankSep:   120,
      edgeSep:   25,
      animate:   false,  // snap into place — the viewport fit below animates
      fit:       false,
    });
    layout.one('layoutstop', () => {
      // Adopt dagre's arrangement as the new equilibrium so the integrator
      // holds it (rather than springing nodes back to their old rest), and
      // persist it via the same path as Auto rozložení.
      _cy.nodes().forEach(n => {
        const p = n.position();
        _phys.nodeRest.set(n.id(), { x: p.x, y: p.y });
        _phys.nodeVel.set(n.id(), { vx: 0, vy: 0 });
      });
      _savePositions();
      _updateLayoutBtnStates();
      if (_cy.nodes().nonempty()) _cy.animate({ fit: { padding: 80 } }, { duration: 450, easing: 'ease-out-cubic' });
    });
    layout.run();
  }

  // ── Crossing-reduction post-pass ─────────────────────────────
  // Greedy hill-climbing on the **worst-offender** node. Each round:
  //   1. score every node by how many crossings its incident edges
  //      participate in;
  //   2. take the unstuck node with the highest score;
  //   3. try swapping it with every other node — keep the swap that
  //      drops total crossings the most;
  //   4. if no swap helps, mark the node "stuck" and move on to the
  //      next worst offender;
  //   5. stop when total crossings hit zero, no node can improve, or
  //      the attempt budget (`MAX_ROUNDS`) is exhausted.
  //
  // Why this beats random-pair simulated annealing: random pair
  // selection wastes most attempts on irrelevant nodes (those with
  // zero crossings). Targeting worst-offenders concentrates the search
  // where it matters and finds the *globally best* swap for that node
  // each round, not a random local one. For a 50-node graph this
  // typically eliminates 70-100 % of the crossings FR alone leaves
  // behind, in a few milliseconds.
  //
  // This stays a heuristic — finding the optimal crossing-free layout
  // is NP-hard. The hill-climber can get stuck in a local minimum; if
  // that ever becomes a problem, the right next step is restart-with-
  // random-perturbation rather than a bigger neighbourhood, since the
  // bottleneck is how often the *first* swap helps, not how many
  // swaps we try per round.
  //
  // Standard segment-crossing test: two segments AB and CD cross iff
  // A and B are on opposite sides of line CD AND C and D are on
  // opposite sides of line AB (orientation/CCW test via 2-D cross
  // product).
  function _reduceCrossings() {
    if (!_cy) return;
    const nodes = _cy.nodes().filter(n => !n.hasClass('cm-filter-hidden'));
    const N = nodes.length;
    if (N < 4) return;

    const pos = new Map();
    nodes.forEach(n => { const p = n.position(); pos.set(n.id(), { x: p.x, y: p.y }); });

    // Index of edges incident to each node — speeds up scoring loops.
    const incidentEdges = new Map();
    nodes.forEach(n => incidentEdges.set(n.id(), []));
    const edges = [];
    _cy.edges().forEach(e => {
      if (e.hasClass('cm-filter-hidden')) return;
      const s = e.source(), t = e.target();
      if (s.hasClass('cm-filter-hidden') || t.hasClass('cm-filter-hidden')) return;
      const sid = s.id(), tid = t.id();
      if (!pos.has(sid) || !pos.has(tid)) return;
      const idx = edges.length;
      edges.push({ s: sid, t: tid });
      incidentEdges.get(sid).push(idx);
      incidentEdges.get(tid).push(idx);
    });
    const E = edges.length;
    if (E < 2) return;

    const ccw = (ax, ay, bx, by, cx, cy) =>
      (cy - ay) * (bx - ax) - (by - ay) * (cx - ax);

    function segmentsCross(e1, e2) {
      if (e1.s === e2.s || e1.s === e2.t || e1.t === e2.s || e1.t === e2.t) return false;
      const a = pos.get(e1.s), b = pos.get(e1.t);
      const c = pos.get(e2.s), d = pos.get(e2.t);
      const o1 = ccw(a.x, a.y, b.x, b.y, c.x, c.y);
      const o2 = ccw(a.x, a.y, b.x, b.y, d.x, d.y);
      const o3 = ccw(c.x, c.y, d.x, d.y, a.x, a.y);
      const o4 = ccw(c.x, c.y, d.x, d.y, b.x, b.y);
      return (o1 * o2 < 0) && (o3 * o4 < 0);
    }

    // Crossings between this node's incident edges and the rest of
    // the graph. Crossings between two incident edges are counted
    // once (not double — they share an endpoint, segmentsCross
    // returns false).
    function nodeCrossingScore(id) {
      const incs = incidentEdges.get(id) || [];
      let n = 0;
      for (const i of incs) {
        for (let j = 0; j < E; j++) {
          if (j === i) continue;
          if (segmentsCross(edges[i], edges[j])) n++;
        }
      }
      return n;
    }

    function totalCrossings() {
      let n = 0;
      for (let i = 0; i < E; i++)
        for (let j = i + 1; j < E; j++)
          if (segmentsCross(edges[i], edges[j])) n++;
      return n;
    }

    let totalCross = totalCrossings();
    if (totalCross === 0) return;

    const ids   = nodes.map(n => n.id());
    const stuck = new Set();    // ids we already tried to improve unsuccessfully
    const MAX_ROUNDS = Math.min(N * 2, 400);   // cap total work for big graphs

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (totalCross === 0) break;

      // Find unstuck node with the most crossings.
      let worstId = null, worstScore = 0;
      for (const id of ids) {
        if (stuck.has(id)) continue;
        const s = nodeCrossingScore(id);
        if (s > worstScore) { worstScore = s; worstId = id; }
      }
      if (!worstId) break;

      // Try swapping with every candidate; pick best Δ.
      const origPos = pos.get(worstId);
      const origScore = worstScore;
      let bestDelta = 0, bestPartner = null, bestPartnerOrigPos = null;

      for (const otherId of ids) {
        if (otherId === worstId) continue;
        const otherPos = pos.get(otherId);
        const beforeOther = nodeCrossingScore(otherId);

        // Swap
        pos.set(worstId, otherPos);
        pos.set(otherId, origPos);

        const afterWorst = nodeCrossingScore(worstId);
        const afterOther = nodeCrossingScore(otherId);
        const delta = (afterWorst + afterOther) - (origScore + beforeOther);

        // Restore for next iteration
        pos.set(worstId, origPos);
        pos.set(otherId, otherPos);

        if (delta < bestDelta) {
          bestDelta = delta;
          bestPartner = otherId;
          bestPartnerOrigPos = otherPos;
        }
      }

      if (bestPartner === null || bestDelta >= 0) {
        // No improvement available for this node — mark it stuck.
        stuck.add(worstId);
        continue;
      }

      // Commit the best swap.
      pos.set(worstId, bestPartnerOrigPos);
      pos.set(bestPartner, origPos);
      totalCross += bestDelta;
      // Both swapped nodes might now be improvable again — clear them
      // from the stuck set.
      stuck.delete(worstId);
      stuck.delete(bestPartner);
    }

    // Commit improved positions back to Cytoscape.
    _cy.batch(() => {
      pos.forEach((p, id) => {
        const node = _cy.getElementById(id);
        if (node && node.length) node.position(p);
      });
    });
  }

  function _physSnapshotForUndo() {
    const snap = new Map();
    _cy.nodes().forEach(node => {
      const p = node.position();
      snap.set(node.id(), { x: p.x, y: p.y });
    });
    _phys.history.push(snap);
    if (_phys.history.length > 5) _phys.history.shift();
  }

  function _undoLayout() {
    const snap = _phys.history.pop();
    if (!snap) return;
    _cy.batch(() => {
      snap.forEach((p, id) => {
        const node = _cy.getElementById(id);
        if (node && node.length) {
          node.position({ x: p.x, y: p.y });
          _phys.nodeRest.set(id, { x: p.x, y: p.y });
          const v = _phys.nodeVel.get(id);
          if (v) { v.vx = 0; v.vy = 0; }
        }
      });
    });
    _savePositions();
    _sync();
    _updateLayoutBtnStates();
  }

  function _updateLayoutBtnStates() {
    const undoBtn = document.querySelector('.cm-undo-layout');
    if (!undoBtn) return;
    const enabled = _phys.history.length > 0;
    undoBtn.disabled = !enabled;
    undoBtn.style.opacity = enabled ? '1' : '0.4';
    undoBtn.style.pointerEvents = enabled ? 'auto' : 'none';
  }

  // ── Tap / highlight ──────────────────────────────────────────
  function _onTap(evt) {
    // Tap on background → clear focus / temporary highlights, keep persistent filters
    if (evt.target === _cy) {
      if (_focusMode && _filters.focusId) {
        _filters.focusId = null;
        _saveVFilter();
      }
      Object.values(_cloudMap).forEach(w => {
        w.firstElementChild && w.firstElementChild.classList.remove('cm-highlighted');
      });
      _applyVisualFilter();
      return;
    }

    const node = evt.target;
    if (!node.isNode()) return;

    // Focus mode: zaměří okolí, žádná navigace
    if (_focusMode) {
      _filters.focusId = node.id();
      _saveVFilter();
      _applyVisualFilter();
      const wrapper = _cloudMap[node.id()];
      if (wrapper && wrapper.firstElementChild) {
        wrapper.firstElementChild.classList.add('cm-highlighted');
      }
      return;
    }

    // Standard behavior: 1-hop highlight then navigate
    const connected = node.connectedEdges().connectedNodes().union(node);
    const ids       = new Set(connected.map(n => n.id()));

    _cy.elements().removeClass('faded highlighted');
    _cy.elements().not(connected).addClass('faded');
    connected.addClass('highlighted');

    Object.entries(_cloudMap).forEach(([id, wrapper]) => {
      const cloud = wrapper.firstElementChild;
      if (!cloud) return;
      if (ids.has(id)) {
        cloud.classList.remove('cm-faded');
        cloud.classList.add('cm-highlighted');
      } else {
        cloud.classList.remove('cm-highlighted');
        cloud.classList.add('cm-faded');
      }
    });

    // Navigate to the item's detail page (after a short delay so highlight shows)
    const d = node.data();
    setTimeout(() => {
      const hash = _detailHashFor(d);
      if (hash) window.location.hash = hash;
    }, 120);
  }

  // ── Right-click context menu ─────────────────────────────────
  // Singleton menu element appended to <body>; rebuilt per invocation.
  let _ctxMenu = null;

  function _hideCtxMenu() {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
  }

  function _detailHashFor(d) {
    const kind = _nodeKind(d.type);
    return (kind && typeof kind.detailHash === 'function') ? kind.detailHash(d) : null;
  }

  function _onCtxNode(evt) {
    _hideCtxMenu();
    const node = evt.target;
    const d = node.data();
    const isFocused = _focusMode && _filters.focusId === node.id();

    const items = [];
    const hash = _detailHashFor(d);
    if (hash) items.push({ label: '↗ ' + I18n.t('cloudmap.openDetail'), action: () => { window.location.hash = hash; } });

    if (isFocused) {
      items.push({ label: '⨯ ' + I18n.t('cloudmap.clearFocus'), action: () => {
        _filters.focusId = null;
        _saveVFilter();
        _applyVisualFilter();
      }});
    } else {
      items.push({ label: '🎯 ' + I18n.t('cloudmap.focusNeighborhood'), action: () => {
        _focusMode = true;
        _filters.focusId = node.id();
        _saveVFilter();
        _syncFilterChipUI();
        _applyVisualFilter();
        const wrapper = _cloudMap[node.id()];
        if (wrapper && wrapper.firstElementChild) {
          wrapper.firstElementChild.classList.add('cm-highlighted');
        }
      }});
    }

    if (d.type === 'character' && _currentMode !== 'vztahy') {
      items.push({ label: '🔗 ' + I18n.t('cloudmap.showRelations'), action: () => {
        window.location.hash = '#/mapa/vztahy';
      }});
    }
    if (d.type === 'character') {
      items.push({ label: '➕ ' + I18n.t('cloudmap.addRelationHere'), action: () => {
        // Land on the character page; in edit mode the relationship form
        // is rendered inline and pre-focused on the new-row.
        window.location.hash = `#/postava/${d.id}`;
        // Best-effort: scroll to the new-row after the page renders.
        setTimeout(() => {
          const row = document.querySelector(`#rel-section-${d.id} .rel-add-form`);
          if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.querySelector('select')?.focus();
          }
        }, 250);
      }});
    }

    // Position menu near cursor (use rendered position from cytoscape event)
    const oe = evt.originalEvent;
    const x = oe ? oe.clientX : 100;
    const y = oe ? oe.clientY : 100;
    _showCtxMenu(items, x, y);
  }

  function _showCtxMenu(items, x, y) {
    _ctxMenu = document.createElement('div');
    _ctxMenu.className = 'cm-ctx-menu';
    _ctxMenu.innerHTML = items.map((it, i) =>
      `<button type="button" class="cm-ctx-item" data-idx="${i}">${esc(it.label)}</button>`
    ).join('');
    _ctxMenu.addEventListener('click', e => {
      const btn = e.target.closest('.cm-ctx-item');
      if (!btn) return;
      const idx = +btn.dataset.idx;
      const it = items[idx];
      _hideCtxMenu();
      if (it && it.action) it.action();
    });
    document.body.appendChild(_ctxMenu);

    // Clamp inside viewport
    const rect = _ctxMenu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const cx = Math.min(x, vw - rect.width  - 6);
    const cy = Math.min(y, vh - rect.height - 6);
    _ctxMenu.style.left = Math.max(4, cx) + 'px';
    _ctxMenu.style.top  = Math.max(4, cy) + 'px';

    // One-shot dismiss on next outside click / Esc / scroll
    setTimeout(() => {
      const dismiss = (e) => {
        if (_ctxMenu && _ctxMenu.contains(e.target)) return;
        _hideCtxMenu();
        document.removeEventListener('mousedown', dismiss);
        document.removeEventListener('keydown',   onEsc);
        window.removeEventListener('blur',        offBlur);
      };
      const onEsc = (e) => { if (e.key === 'Escape') dismiss(e); };
      const offBlur = () => dismiss({ target: document.body });
      document.addEventListener('mousedown', dismiss);
      document.addEventListener('keydown',   onEsc);
      window.addEventListener('blur',        offBlur);
    }, 0);
  }

  // ── Post-render height correction ────────────────────────────
  // Pre-layout estimates can be slightly off due to font rendering.
  // After the first DOM paint we measure each cloud's real offsetHeight
  // and patch both the Cytoscape node style (edge routing) and node data
  // (used by _nodeIntersect for label positioning + FR repulsion).
  //
  // CRITICAL: cards now scale visually via the --cm-z CSS variable
  // (see _sync). offsetHeight reflects the VISUALLY-SCALED height —
  // but data('h') is graph-coord and feeds geometry-sensitive code
  // (edge endpoints, parallel-fan, FR repulsion, hit-testing). So we
  // temporarily force --cm-z = 1 before measuring, flush layout, take
  // the heights at native scale, then restore the previous value.
  // _lastSyncedZoom is reset so the next _sync() will write back the
  // actual zoom and not skip due to the stale-cached value.
  function _resizeToActual() {
    if (!_cy || !_cloudLayer) return;
    const prev = _cloudLayer.style.getPropertyValue('--cm-z');
    _cloudLayer.style.setProperty('--cm-z', '1');
    // Force a layout flush so offsetHeight reflects the temporary scale.
    void _cloudLayer.offsetHeight;

    _cy.batch(() => {
      _cy.nodes().forEach(node => {
        const wrapper = _cloudMap[node.id()];
        if (!wrapper) return;
        const cloud = wrapper.firstElementChild;
        if (!cloud) return;
        const h = cloud.offsetHeight;
        if (h > 0 && h !== node.data('h')) {
          node.data('h', h);
          node.style('height', h);
        }
      });
    });

    // Restore the previous --cm-z (or remove it if none was set).
    if (prev) _cloudLayer.style.setProperty('--cm-z', prev);
    else      _cloudLayer.style.removeProperty('--cm-z');
    // Force the next _sync() to re-write --cm-z (don't trust cache).
    _lastSyncedZoom = NaN;
  }

  // ── Shared event binding ─────────────────────────────────────
  function _bind() {
    _cy.on('render',                  _sync);
    // Node drag — listen for BOTH event names. Cytoscape's documented
    // node-drag events are `grab` / `drag` / `free`; `dragstart` and
    // `dragfree` are partial aliases that fire in some code paths but
    // not all. Belt-and-braces: bind both so the integrator wakes
    // reliably regardless of which alias actually fires for a given
    // grab gesture in the current Cytoscape build.
    _cy.on('grab dragstart',   'node', _onDragStart);
    _cy.on('drag',             'node', _onDragNode);
    _cy.on('free dragfree',    'node', _onDragFreeNode);
    _cy.on('tap',                     _onTap);
    _cy.on('cxttap',           'node', _onCtxNode);
    _cy.on('cxttap',                  evt => { if (evt.target === _cy) _hideCtxMenu(); });

    // ── Smooth zoom — override Cytoscape's coarse wheel zoom ──────
    // Cytoscape's built-in wheel step (~15–20 % per tick) feels jumpy.
    // We disable it and apply a finer step (6 %) ourselves, zooming
    // toward the cursor position exactly as Cytoscape would.
    _cy.userZoomingEnabled(false);
    const _container = _cy.container();
    _container.addEventListener('wheel', evt => {
      evt.preventDefault();

      const FACTOR = 0.06;                           // 6 % per scroll tick
      const delta  = evt.deltaY < 0 ? 1 + FACTOR : 1 / (1 + FACTOR);
      const oldZ   = _cy.zoom();
      const newZ   = Math.min(_cy.maxZoom(), Math.max(_cy.minZoom(), oldZ * delta));
      if (newZ === oldZ) return;

      // Zoom toward the cursor (keep the graph point under the pointer fixed)
      const rect  = _container.getBoundingClientRect();
      const cx    = evt.clientX - rect.left;
      const cy_px = evt.clientY - rect.top;

      _cy.zoom({
        level:    newZ,
        renderedPosition: { x: cx, y: cy_px },
      });
    }, { passive: false });

    _cy.ready(() => {
      _addEdgeLabels();
      _sync();
      // One rAF later the clouds are painted — measure, correct heights, then save positions
      requestAnimationFrame(() => {
        _resizeToActual();
        _sync();
        // Always fit the viewport to all nodes on initial render so saved
        // positions (or an empty viewport after container resize) don't
        // leave nodes off-screen — this is what caused the "empty" look
        // on mind palace modes like Záhady.
        if (_cy.nodes().nonempty()) _cy.fit(undefined, 60);
        _sync();
        _syncFilterChipUI();
        if ((_filters.values && _filters.values.length) ||
            _filters.hiddenEdgeTypes.size ||
            (_focusMode && _filters.focusId)) {
          _applyVisualFilter();
        }

        // Seed the physics integrator: each node's saved position
        // becomes its rest equilibrium. Edge CPs are NOT seeded here
        // — _syncEdgeLabels creates them lazily at the correct
        // parallel-fan target on first sync, and snaps them to that
        // target whenever the integrator is asleep. Pre-seeding from
        // an arbitrary mid-layout-animation position used to leave
        // every line bowed out of place after refresh.
        _cy.nodes().forEach(node => {
          const id = node.id();
          const p  = node.position();
          _phys.nodeRest.set(id, { x: p.x, y: p.y });
          _phys.nodeVel.set(id, { vx: 0, vy: 0 });
        });
        _updateLayoutBtnStates();
        // Positions are saved manually via the "Uložit pozice" button in edit mode
      });
    });
  }

  // ── MODE: FRAKCE ────────────────────────────────────────────
  // Central faction hub nodes + member nodes + location nodes.
  // Edges: hub→member, hub→location, commands, negotiates, ally.
  function _renderFrakce() {
    _buildUI('frakce');

    // Clear stale positions / filter when the layout's node-set changes.
    // Bumped to '3' when the party left the factions collection — old
    // saved layouts referenced `hub_party` which no longer exists, and
    // a saved faction filter could still hide 'party' (harmless) or
    // reference renamed ids. Wiping both gives the user a clean slate.
    const POS_VERSION_KEY = 'cm_pos_v_frakce';
    if (localStorage.getItem(POS_VERSION_KEY) !== '3') {
      localStorage.removeItem('cm_pos_frakce');
      localStorage.removeItem('cm_filter_frakce');
      _hiddenFactions = new Set();
      localStorage.setItem(POS_VERSION_KEY, '3');
    }

    const chars    = Store.getCharacters();
    const factions = Store.getFactions();
    const allRels  = Store.getRelationships();
    const locations = Store.getLocations();
    const facLocMap = _deriveFactionLocations(chars);

    // — Count members per faction —
    const memberCounts = {};
    chars.forEach(c => { memberCounts[c.faction] = (memberCounts[c.faction] || 0) + 1; });

    // — Faction hub nodes (skip "neutral") —
    const HIDDEN_HUB_FACTIONS = new Set(['neutral']);
    const hubNodes = Object.entries(factions)
      .filter(([fId]) => !HIDDEN_HUB_FACTIONS.has(fId))
      .map(([fId, f]) =>
        _proxy('hub_' + fId, 'faction', CW_HUB, _factionHubCloudH(f, memberCounts[fId] || 0),
          { faction: fId })
      );

    // — Character nodes —
    const charNodes = chars.map(c =>
      _proxy(c.id, 'character', CW, _charCloudH(c, 'frakce'), { faction: c.faction })
    );

    // — Determine command-chain roots per faction —
    // A "root" is a character NOT commanded by someone in the same faction.
    const cmdRels = allRels.filter(r => r.type === 'commands');
    const commandedByFaction = new Set(); // charIds that have a same-faction commander
    cmdRels.forEach(r => {
      const src = chars.find(c => c.id === r.source);
      const tgt = chars.find(c => c.id === r.target);
      if (src && tgt && src.faction === tgt.faction) {
        commandedByFaction.add(tgt.id);
      }
    });

    // — Location nodes (deduplicated) —
    const usedLocIds = new Set();
    facLocMap.forEach(locSet => locSet.forEach(id => usedLocIds.add(id)));
    const locNodes = [];
    for (const locId of usedLocIds) {
      const loc = locations.find(l => l.id === locId);
      if (loc) locNodes.push(_proxy(loc.id, 'location', CW, _locationCloudH(loc), {}));
    }

    // — Edges —
    const edges = [];

    // Hub → member edges (only to chain roots, skip factions without hubs)
    chars.forEach(c => {
      if (!c.faction || !factions[c.faction]) return;
      if (HIDDEN_HUB_FACTIONS.has(c.faction)) return;       // no hub for neutral
      if (commandedByFaction.has(c.id)) return;              // connected via command chain
      const fColor = _factionColor(c.faction);
      edges.push({
        data: {
          id: `mbr_${c.faction}_${c.id}`, source: 'hub_' + c.faction, target: c.id,
          label: '', color: fColor, width: 1.5, lineStyle: 'dashed',
        }
      });
    });

    // Hub → location edges (dotted, earthy green; skip factions without hubs)
    facLocMap.forEach((locSet, fId) => {
      if (HIDDEN_HUB_FACTIONS.has(fId)) return;
      if (!factions[fId]) return;   // no hub node (e.g. 'party' lives in playerParty now)
      for (const locId of locSet) {
        if (!locations.find(l => l.id === locId)) continue;
        edges.push({
          data: {
            id: `loc_${fId}_${locId}`, source: 'hub_' + fId, target: locId,
            label: '', color: CM_EDGE_COLORS.located_at, width: 2, lineStyle: 'dotted',
          }
        });
      }
    });

    // Commands + negotiates between characters
    const relEdges = allRels
      .filter(r => r.type === 'commands' || r.type === 'negotiates' || r.type === 'ally')
      .map(_relEdge);
    edges.push(...relEdges);

    // — Layout —
    const _c = _graphContrib('frakce');
    _initCy([...hubNodes, ...charNodes, ...locNodes, ...edges, ..._c.proxies, ..._c.edges], {
      name: 'cose', animate: true, animationDuration: 700,
      nodeRepulsion: 24000, gravity: 0.12, idealEdgeLength: 200,
      padding: 90, randomize: false, numIter: 3000,
    });

    // — Faction glow divs (inserted first so they render behind clouds) —
    // Hub glows: large and brighter; member glows: smaller and subtler
    Object.entries(factions).forEach(([fId, f]) => {
      if (HIDDEN_HUB_FACTIONS.has(fId)) return;
      const glow = document.createElement('div');
      glow.className = 'cm-glow';
      glow.style.cssText = `--gc:${_safeColor(f.color)};`;
      _cloudLayer.insertBefore(glow, _cloudLayer.firstChild);
      _glowMap['hub_' + fId] = glow;
    });
    chars.forEach(c => {
      if (!c.faction || !factions[c.faction]) return;
      const f = factions[c.faction];
      const glow = document.createElement('div');
      glow.className = 'cm-glow cm-glow-sm';
      glow.style.cssText = `--gc:${_safeColor(f.color)};`;
      _cloudLayer.insertBefore(glow, _cloudLayer.firstChild);
      _glowMap[c.id] = glow;
    });

    // — Add cloud cards —
    Object.entries(factions).forEach(([fId, f]) => {
      if (HIDDEN_HUB_FACTIONS.has(fId)) return;
      _addCloud(_factionHubCloudHTML(fId, f, memberCounts[fId] || 0), 'hub_' + fId);
    });
    chars.forEach(c => _addCloud(_charCloudHTML(c, 'frakce'), c.id));
    for (const locId of usedLocIds) {
      const loc = locations.find(l => l.id === locId);
      if (loc) _addCloud(_locationCloudHTML(loc), loc.id);
    }
    _c.render();

    _bind();
    _addEdgeLabels();

    // — Legend with faction filter checkboxes —
    const leg = document.getElementById('map-legend');
    if (leg) {
      leg.innerHTML = `
        <div class="legend-title">${esc(I18n.t('cloudmap.legendFactions'))}</div>
        ${_buildFactionFilterLegend(factions, HIDDEN_HUB_FACTIONS)}
        <div class="legend-item">
          <div class="legend-dot" style="background:${CM_NODE_COLORS.location}"></div>
          📍 ${esc(I18n.t('cloudmap.placeStrip'))}
        </div>
        <div class="legend-item" style="margin-top:0.4rem;opacity:0.55">
          <div class="legend-dot" style="background:${CM_NODE_COLORS.dead};border:1px dashed ${CM_EDGE_COLORS.member}"></div>
          ${esc(I18n.t('cloudmap.legendDead'))}
        </div>
        <div style="margin-top:0.5rem">
          <div class="legend-title">${esc(I18n.t('cloudmap.legendRelations'))}</div>
          <div class="legend-item"><div class="legend-line" style="border-top:1.5px dashed ${CM_EDGE_COLORS.member}"></div> ${esc(I18n.t('cloudmap.legendFactionMember'))}</div>
          <div class="legend-item"><div class="legend-line" style="border-top:3px solid ${EDGE_COLORS.commands || '#8B0000'}"></div> ${esc(I18n.t('cloudmap.legendCommand'))}</div>
          <div class="legend-item"><div class="legend-line" style="border-top:2px dashed ${EDGE_COLORS.negotiates || '#1565C0'}"></div> ${esc(I18n.t('cloudmap.legendNegotiation'))}</div>
          <div class="legend-item"><div class="legend-line" style="border-top:2px solid ${EDGE_COLORS.ally || '#2E7D32'}"></div> ${esc(I18n.t('cloudmap.legendAlly'))}</div>
          <div class="legend-item"><div class="legend-line" style="border-top:2px dotted ${CM_EDGE_COLORS.located_at}"></div> ${esc(I18n.t('cloudmap.legendLocation'))}</div>
        </div>`;

      if (_hiddenFactions.size) _applyFactionFilter();
    }
  }

  // ── MODE: VZTAHY ────────────────────────────────────────────
  // Clouds show: faction strip, name, status, connection count, top types.
  // Edges: all relationships with labels.
  function _renderVztahy() {
    _buildUI('vztahy');
    const chars    = Store.getCharacters();
    const rels     = Store.getRelationships();
    const factions = Store.getFactions();

    const nodes = chars.map(c =>
      _proxy(c.id, 'character', CW, _charCloudH(c, 'vztahy'))
    );
    const edges = rels.map(_relEdge);

    const _c = _graphContrib('vztahy');
    _initCy([...nodes, ..._c.proxies, ...edges, ..._c.edges], {
      name: 'cose', animate: true, animationDuration: 900,
      nodeRepulsion: 22000, gravity: 0.07, idealEdgeLength: 220,
      padding: 90, randomize: false, numIter: 3000,
    });

    chars.forEach(c => _addCloud(_charCloudHTML(c, 'vztahy'), c.id));
    _c.render();
    _bind();

    const typeRows = [
      ['commands',I18n.t('cloudmap.legendCommand')], ['ally',I18n.t('cloudmap.legendAlly')], ['enemy',I18n.t('cloudmap.legendEnemy')],
      ['mission',I18n.t('cloudmap.legendMission')],    ['mystery',I18n.t('cloudmap.legendMystery')], ['history',I18n.t('cloudmap.legendPast')],
    ].map(([t, l]) => {
      const es = EDGE_STYLES[t] || {};
      const c  = EDGE_COLORS[t] || '#666';
      const d  = es['line-style'] || 'solid';
      return `<div class="legend-item">
        <div class="legend-line" style="border-top:2px ${d} ${c}"></div>${esc(l)}
      </div>`;
    }).join('');

    const leg = document.getElementById('map-legend');
    if (leg) {
      leg.innerHTML = `
        <div class="legend-title">${esc(I18n.t('cloudmap.legendRelationTypes'))}</div>
        ${typeRows}
        <div class="legend-title" style="margin-top:0.5rem">${esc(I18n.t('cloudmap.legendFactions'))}</div>
        ${_buildFactionFilterLegend(factions)}`;
      if (_hiddenFactions.size) _applyFactionFilter();
    }
  }

  // ── MODE: ZÁHADY ────────────────────────────────────────────
  // Mystery clouds (purple) + character clouds showing mystery context.
  function _renderTajemstvi() {
    _buildUI('tajemstvi');
    const mysteries = Store.getMysteries();
    const chars     = Store.getCharacters();
    const factions  = Store.getFactions();

    const involvedIds = new Set(mysteries.flatMap(m => m.characters || []));
    const involved    = chars.filter(c => involvedIds.has(c.id));

    const mNodes = mysteries.map(m =>
      _proxy(m.id, 'mystery', CW, _mysteryCloudH(m))
    );
    const cNodes = involved.map(c =>
      _proxy(c.id, 'character', CW, _charCloudH(c, 'tajemstvi'))
    );
    const edges = mysteries.flatMap(m =>
      (m.characters || []).map(cid => ({
        data: {
          id: `${m.id}__${cid}`, source: m.id, target: cid,
          label: '', color: CM_EDGE_COLORS.mysteryLink, width: 1.5, lineStyle: 'dotted',
        }
      }))
    );

    const _c = _graphContrib('tajemstvi');
    _initCy([...mNodes, ...cNodes, ...edges, ..._c.proxies, ..._c.edges], {
      name: 'cose', animate: true, animationDuration: 700,
      nodeRepulsion: 16000, gravity: 0.22, idealEdgeLength: 180,
      padding: 65,
    });

    mysteries.forEach(m => _addCloud(_mysteryCloudHTML(m), m.id));
    involved.forEach(c  => _addCloud(_charCloudHTML(c, 'tajemstvi'), c.id));
    _c.render();
    _bind();
    _addEdgeLabels();

    const leg = document.getElementById('map-legend');
    if (leg) {
      leg.innerHTML = `
        <div class="legend-title">${esc(I18n.t('cloudmap.legendMysteries'))}</div>
        <div class="legend-item"><div class="legend-dot" style="background:${CM_NODE_COLORS.mystery}"></div> ${esc(I18n.t('cloudmap.legendMystery'))}</div>
        <div class="legend-item"><div class="legend-dot"></div> ${esc(I18n.t('cloudmap.legendInvolvedCharacter'))}</div>
        <div class="legend-title" style="margin-top:0.5rem">${esc(I18n.t('cloudmap.legendFactions'))}</div>
        ${_buildFactionFilterLegend(factions)}`;
      if (_hiddenFactions.size) _applyFactionFilter();
    }
  }

  // ── MODE: ČASOVÁ OSA ────────────────────────────────────────
  // Event clouds (gold) linked chronologically + characters showing their event history.
  function _renderCasovaOsa() {
    _buildUI('casova-osa');
    const events    = [...Store.getEvents()].sort((a, b) => a.order - b.order);
    const chars     = Store.getCharacters();
    const factions  = Store.getFactions();

    const involvedIds = new Set(events.flatMap(e => e.characters || []));
    const involved    = chars.filter(c => involvedIds.has(c.id));

    const eNodes = events.map(e =>
      _proxy(e.id, 'event', CW, _eventCloudH(e))
    );
    const cNodes = involved.map(c =>
      _proxy(c.id, 'character', CW, _charCloudH(c, 'casova-osa'))
    );

    // Chronological chain between events
    const chainEdges = events.slice(0, -1).map((e, i) => ({
      data: {
        id: `chain-${i}`, source: e.id, target: events[i + 1].id,
        label: '', color: CM_EDGE_COLORS.eventChain, width: 2, lineStyle: 'solid',
      }
    }));
    // Event ↔ character participation edges
    const partEdges = events.flatMap(e =>
      (e.characters || []).map(cid => ({
        data: {
          id: `${e.id}__${cid}`, source: e.id, target: cid,
          label: '', color: CM_EDGE_COLORS.eventPart, width: 1, lineStyle: 'dotted',
        }
      }))
    );

    const _c = _graphContrib('casova-osa');
    _initCy([...eNodes, ...cNodes, ...chainEdges, ...partEdges, ..._c.proxies, ..._c.edges], {
      name: 'cose', animate: true, animationDuration: 800,
      nodeRepulsion: 14000, gravity: 0.18, idealEdgeLength: 190,
      padding: 65,
    });

    events.forEach(e  => _addCloud(_eventCloudHTML(e), e.id));
    involved.forEach(c => _addCloud(_charCloudHTML(c, 'casova-osa'), c.id));
    _c.render();
    _bind();
    _addEdgeLabels();

    const leg = document.getElementById('map-legend');
    if (leg) {
      leg.innerHTML = `
        <div class="legend-title">${esc(I18n.t('cloudmap.legendTimeline'))}</div>
        <div class="legend-item">
          <div class="legend-line" style="border-top:2px solid ${CM_EDGE_COLORS.eventChain}"></div> ${esc(I18n.t('cloudmap.legendEventSequence'))}
        </div>
        <div class="legend-item"><div class="legend-dot" style="background:${CM_NODE_COLORS.event}"></div> ${esc(I18n.t('cloudmap.legendEvent'))}</div>
        <div class="legend-item"><div class="legend-dot"></div> ${esc(I18n.t('cloudmap.legendCharacter'))}</div>
        <div class="legend-title" style="margin-top:0.5rem">${esc(I18n.t('cloudmap.legendFactions'))}</div>
        ${_buildFactionFilterLegend(factions)}`;
      if (_hiddenFactions.size) _applyFactionFilter();
    }
  }

  // ── Graph view registry + addon contributions ───────────────
  // Built-in views (mind-map "modes") as descriptors; addon views
  // (Addons.graphViews(), perm kinds:graph) merge via _view(). render(mode)
  // dispatches through this, so built-ins + addon views share one path.
  const VIEWS = new Map([
    ['frakce',     { id: 'frakce',     build: _renderFrakce }],
    ['vztahy',     { id: 'vztahy',     build: _renderVztahy }],
    ['tajemstvi',  { id: 'tajemstvi',  build: _renderTajemstvi }],
    ['casova-osa', { id: 'casova-osa', build: _renderCasovaOsa }],
  ]);
  function _view(mode) {
    if (VIEWS.has(mode)) return VIEWS.get(mode);
    for (const def of Addons.graphViews()) if (def && def.id === mode) return def;
    return null;
  }

  function _safeNum(fn, fb) { try { const v = fn(); return Number.isFinite(v) ? v : fb; } catch { return fb; } }

  // Gather addon graph contributions for a view (perm graph:contribute): proxy
  // nodes (rendered via their node-kind descriptor's cardHTML/height) + edges
  // (built like relationships through _relEdge). Zero-cost with no contributors.
  // `.render()` is DEFERRED so clouds are added AFTER _initCy mounts the proxy
  // nodes — exactly like the built-in _addCloud loops.
  function _graphContrib(viewId) {
    const proxies = [], edges = [], clouds = [];
    for (const c of Addons.graphContributors(viewId)) {
      let r;
      try { r = c.fn({ viewId }); }
      catch (e) { console.error(`[addon ${c.addonId}] graph contributor "${viewId}" failed`, e); continue; }
      if (!r) continue;
      for (const n of (r.nodes || [])) {
        if (!n || !n.id || !n.type) continue;
        const kind = _nodeKind(n.type);
        const h = (kind && typeof kind.height === 'function') ? _safeNum(() => kind.height(n.entity || n, viewId), 120) : 120;
        proxies.push(_proxy(n.id, n.type, CW, h));
        clouds.push(n);
      }
      for (const e of (r.edges || [])) {
        if (e && e.source && e.target) edges.push(_relEdge({ type: 'uncertain', ...e }));
      }
    }
    return {
      proxies, edges,
      render() {
        for (const n of clouds) {
          const kind = _nodeKind(n.type);
          if (kind && typeof kind.cardHTML === 'function') {
            try { _addCloud(kind.cardHTML(n.entity || n, viewId), n.id); }
            catch (e) { console.error(`[addon] node "${n.type}" cardHTML failed`, e); }
          }
        }
      },
    };
  }

  // Generic renderer for an ADDON-authored declarative view (host.registerGraphView,
  // `build()` → {nodes,edges}). Built-in views keep their bespoke builders above;
  // this covers addon views with no cloudmap internals exposed.
  function _renderAddonView(def) {
    _buildUI(def.id);
    let r;
    try { r = def.build ? def.build({ store: Store, viewId: def.id }) : null; }
    catch (e) { console.error(`[addon] graph view "${def.id}" build failed`, e); r = null; }
    const list  = r || { nodes: [], edges: [] };
    const valid = (list.nodes || []).filter(n => n && n.id && n.type);
    const nodes = valid.map(n => {
      const kind = _nodeKind(n.type);
      const h = (kind && typeof kind.height === 'function') ? _safeNum(() => kind.height(n.entity || n, def.id), 120) : 120;
      return _proxy(n.id, n.type, CW, h);
    });
    const edges = (list.edges || []).filter(e => e && e.source && e.target).map(e => _relEdge({ type: 'uncertain', ...e }));
    _initCy([...nodes, ...edges], {
      name: 'cose', animate: true, animationDuration: 700,
      nodeRepulsion: 20000, gravity: 0.1, idealEdgeLength: 200, padding: 80, randomize: false, numIter: 2500,
    });
    valid.forEach(n => {
      const kind = _nodeKind(n.type);
      if (kind && typeof kind.cardHTML === 'function') {
        try { _addCloud(kind.cardHTML(n.entity || n, def.id), n.id); } catch (e) { console.error(e); }
      }
    });
    _bind();
    _addEdgeLabels();
  }

  // ── Public ────────────────────────────────────────────────

  /**
   * Render a mind-map mode into the current view. Tears down any
   * previous Cytoscape instance + HTML overlay first so re-rendering
   * the same mode is safe (used by SSE refresh). Wired into `app.js`
   * for the `/mapa/{frakce,vztahy,tajemstvi,palac}` routes.
   *
   * @param {'frakce'|'vztahy'|'tajemstvi'|'casova-osa'} mode
   */
  function render(mode) {
    _destroy();
    _rebuildEdgeMeta();   // refresh connection-kind visuals from the registry
    const view = _view(mode) || VIEWS.get('frakce');
    try {
      if (VIEWS.has(view.id)) view.build();      // built-in bespoke builder
      else                    _renderAddonView(view);   // addon declarative view
    } catch (e) { console.error(`[cloudmap] view "${view.id}" failed`, e); }
  }

  /**
   * Drop saved positions for the current mode and re-render so the
   * physics layout starts fresh. Used by the toolbar "⟳ Rozložení"
   * button.
   */
  function resetLayout() {
    _clearPositions();
    if (_currentMode) render(_currentMode);
  }

  return {
    render, resetLayout, setEditing, toggleEditing,
    savePositions:   _savePositions,
    runAutoLayout:   _runAutoLayout,
    runDagreLayout:  _runDagreLayout,
    undoLayout:      _undoLayout,
    toggleFaction:   _toggleFaction,
    setFilterValues: _setFilterValues,   // called by TagFilter via tf-change event
    toggleEdgeType:  _toggleEdgeType,
    toggleFocusMode: _toggleFocusMode,
    setFocusHops:    _setFocusHops,
    clearFilters:    _clearFilters,
  };
})();
