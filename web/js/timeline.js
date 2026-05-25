// ═══════════════════════════════════════════════════════════════
//  TIMELINE — Kanban board (column per sezení)
//  Events live in columns Sezení 1..N. In edit mode, an extra
//  phantom column at the end accepts drops to create a new
//  sezení, and each column exposes "+ Nová událost" + per-card
//  drag-drop. Ancient/historical events live in their own
//  `historicalEvents` collection — not in the timeline.
//
//  Stacking: columns with more than STACK_THRESHOLD cards fan
//  out on hover/tap. Collapsed, cards peek with a vertical
//  offset; expanded, they separate back to normal spacing.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { EditMode } from './editmode.js';
import { Role } from './role.js';
import { esc, dataAction } from './utils.js';

const STACK_THRESHOLD = 4;

// Drag state (outside IIFE so the native dragstart/dragover/drop
// handlers wired directly on DOM nodes can see it).
let _draggingId = null;

export const Timeline = (() => {

  // Local per-page edit toggle. Was driven by EditMode.isActive() (the
  // global edit mode); now lives here so editing the timeline doesn't
  // require flipping a global state. Persists across renders within
  // the session — `setEditing(bool)` flips and re-renders. Anonymous
  // viewers never see the toolbar toggle, so they can't enter this
  // state without logging in first.
  let _editing = false;
  function setEditing(bool) {
    if (bool && Role.isAnonymous()) {
      // Anonymous click on ✏ Editovat osu → login modal first.
      window.dispatchEvent(new CustomEvent('auth:prompt-login'));
      return;
    }
    _editing = !!bool;
    render();
  }

  // Per-render id→entity Maps. Built fresh at the top of render() so
  // _cardHTML / _eventAccentColor do O(1) lookups instead of a linear
  // .find() inside every card on every render — the kanban can hold
  // hundreds of cards, so the Map indirection actually matters.
  let _charMap = new Map();
  let _locMap  = new Map();

  function _factionColor(id) { return Store.getFactions()[id]?.color || '#8B6914'; }

  function _eventAccentColor(e) {
    for (const cid of (e.characters || [])) {
      const c = _charMap.get(cid);
      if (c && c.faction && c.faction !== 'neutral') return _factionColor(c.faction);
    }
    return '#8B6914';
  }

  // ── Persist after a drag. Given the post-drop mapping of
  // sitting → ordered event ids, renumber `order` 1,2,3… and
  // write every event whose (sitting, order) actually changed.
  function _commitReorder(columns) {
    const writes = [];
    columns.forEach(col => {
      col.ids.forEach((id, idx) => {
        const existing = Store.getEvent(id);
        if (!existing) return;
        const order = idx + 1;
        if (existing.sitting !== col.sitting || existing.order !== order) {
          writes.push({ ...existing, sitting: col.sitting, order });
        }
      });
    });
    writes.forEach(w => Store.saveEvent(w));
    return writes.length > 0;
  }

  // ── Card HTML ─────────────────────────────────────────────────
  function _cardHTML(e) {
    const charNames = (e.characters || []).slice(0, 4).map(id => {
      const c = _charMap.get(id);
      return c ? esc(c.name) : esc(id);
    });
    const charMore = (e.characters || []).length > 4
      ? ` <span class="tl-more">+${(e.characters||[]).length - 4}</span>` : '';

    const locNames = (e.locations || []).map(id => {
      const l = _locMap.get(id);
      return l ? esc(l.name) : esc(id);
    });

    return `
      <div class="tl-card-name">${esc(e.name)}</div>
      ${e.short ? `<div class="tl-card-desc">${esc(e.short)}</div>` : ''}
      <div class="tl-card-meta">
        ${charNames.length ? `<div class="tl-card-chars">👤 ${charNames.join(', ')}${charMore}</div>` : ''}
        ${locNames.length  ? `<div class="tl-card-loc">📍 ${locNames.join(' → ')}</div>` : ''}
      </div>`;
  }

  // Build one card element with drag handlers wired in edit mode.
  function _buildCard(e, colEl) {
    const card = document.createElement('div');
    card.className = 'tl-card';
    card.dataset.id = e.id;
    card.style.setProperty('--tc', _eventAccentColor(e));
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', e.name);
    card.innerHTML = _cardHTML(e);

    card.addEventListener('click', () => {
      if (card.dataset.tlJustDragged === '1') {
        delete card.dataset.tlJustDragged;
        return;
      }
      window.location.hash = `#/udalost/${e.id}`;
    });
    card.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') window.location.hash = `#/udalost/${e.id}`;
    });

    if (_editing) {
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', ev => {
        _draggingId = e.id;
        card.classList.add('tl-drag-src');
        // Expand the source column so the user can see where they're
        // picking from and mid-column drops land precisely.
        colEl.classList.add('tl-col-expanded');
        try { ev.dataTransfer.setData('text/plain', e.id); } catch {}
        ev.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('tl-drag-src');
        card.dataset.tlJustDragged = '1';
        setTimeout(() => { delete card.dataset.tlJustDragged; }, 0);
        // Cleanup any lingering drop indicators.
        document.querySelectorAll('.tl-drop-indicator').forEach(n => n.remove());
        document.querySelectorAll('.tl-col-expanded').forEach(n => {
          // Leave columns expanded only if the pointer is currently over
          // them (hover keeps them open naturally).
          if (!n.matches(':hover')) n.classList.remove('tl-col-expanded');
        });
        _draggingId = null;
      });
    }
    return card;
  }

  // Pick the insertion index inside a column body from the pointer Y.
  // Returns the index in the column's current child card list. N means
  // "after the last existing card" (i.e., at the tail).
  function _insertIndexFromEvent(bodyEl, clientY) {
    const cards = [...bodyEl.querySelectorAll('.tl-card:not(.tl-drag-src)')];
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return cards.length;
  }

  // Show a thin gold line at the prospective drop position.
  function _showDropIndicator(bodyEl, idx) {
    document.querySelectorAll('.tl-drop-indicator').forEach(n => n.remove());
    const cards = [...bodyEl.querySelectorAll('.tl-card:not(.tl-drag-src)')];
    const line = document.createElement('div');
    line.className = 'tl-drop-indicator';
    if (idx >= cards.length) bodyEl.appendChild(line);
    else                     bodyEl.insertBefore(line, cards[idx]);
  }

  // Wire dragover + drop on a column. sittingKey is the column's
  // sezení number (1..N, or N+1 for the phantom "new sezení" slot).
  function _wireColumnDrop(colEl, bodyEl, sittingKey) {
    colEl.addEventListener('dragover', ev => {
      if (_draggingId == null) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      colEl.classList.add('tl-col-expanded');
      const idx = _insertIndexFromEvent(bodyEl, ev.clientY);
      _showDropIndicator(bodyEl, idx);
    });
    colEl.addEventListener('dragleave', ev => {
      // Only clear when leaving the column outright (not entering a
      // descendant). relatedTarget may be null for OS-boundary events.
      if (ev.relatedTarget && colEl.contains(ev.relatedTarget)) return;
      document.querySelectorAll('.tl-drop-indicator').forEach(n => n.remove());
    });
    colEl.addEventListener('drop', ev => {
      if (_draggingId == null) return;
      ev.preventDefault();
      const srcId = _draggingId;
      const idx = _insertIndexFromEvent(bodyEl, ev.clientY);
      _draggingId = null;
      document.querySelectorAll('.tl-drop-indicator').forEach(n => n.remove());
      _handleDrop(srcId, sittingKey, idx);
    });
  }

  // Rebuild all columns with `srcId` relocated to (targetSitting, insertIdx)
  // and persist.
  function _handleDrop(srcId, targetSitting, insertIdx) {
    const events = Store.getEvents();
    const byCol = _groupBySitting(events);
    // Ensure target column exists (it might be the phantom "new sezení"
    // column; the sitting key has already been resolved by the caller).
    if (!byCol.has(targetSitting)) byCol.set(targetSitting, []);

    // Remove src from whichever column currently contains it.
    for (const [, list] of byCol) {
      const i = list.findIndex(e => e.id === srcId);
      if (i >= 0) list.splice(i, 1);
    }
    // Insert at requested index.
    const src = events.find(e => e.id === srcId);
    if (!src) return;
    byCol.get(targetSitting).splice(insertIdx, 0, src);

    // Build the renumbering payload and persist.
    const columns = [...byCol.entries()].map(([sitting, list]) => ({
      sitting,
      ids: list.map(e => e.id),
    }));
    if (_commitReorder(columns)) render();
  }

  // Map sitting-number → ordered list of events. Events without a
  // sitting are coerced to sitting 1 so they're visible somewhere
  // instead of vanishing. Orders within each sitting come from the
  // current `order` so rebuilds are stable.
  function _groupBySitting(events) {
    const out = new Map();
    const sorted = [...events].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    sorted.forEach(e => {
      const k = (typeof e.sitting === 'number' && e.sitting >= 1) ? e.sitting : 1;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(e);
    });
    return out;
  }

  // ── Main render ───────────────────────────────────────────────

  /**
   * Render the timeline kanban into `#main-content`. Builds one column
   * per `Sezení 1..maxSitting` (including any empty sittings in the
   * middle so a skipped session is a valid drop target), plus a
   * phantom "Nové sezení N+1" column when edit mode is active.
   */
  function render() {
    // Dedupe twin pairs so each event shows once on the timeline.
    const events = Store.dedupeShadowTwins('events', Store.getEvents());

    _charMap = new Map(Store.getCharacters().map(c => [c.id, c]));
    _locMap  = new Map(Store.getLocations().map(l => [l.id, l]));

    const byCol  = _groupBySitting(events);
    const maxSitting = Math.max(
      1,
      events.reduce((m, e) => Math.max(m, e.sitting ?? 0), 0),
    );
    const editing = _editing;

    // Edit toggle in the toolbar — visible to every viewer; anonymous
    // click surfaces the login modal first (Timeline.setEditing's
    // role check below). Acts as a local per-page mode — enables card
    // drag-drop + the "+ Nová událost" footers.
    const editToggle = `
      <button class="tl-edit-toggle ${editing ? 'is-active' : ''}"
        title="${editing ? 'Vypnout úpravy osy' : 'Zapnout úpravy osy (přesouvání karet, nové události)'}"
        ${dataAction('Timeline.setEditing', !editing)}>
        ${editing ? '✓ Hotovo' : '✏ Editovat osu'}
      </button>`;

    document.getElementById('main-content').style.display = '';
    document.getElementById('main-content').innerHTML = `
      <div class="tl-shell ${editing ? 'is-editing' : ''}">
        <div class="tl-toolbar">
          <div class="tl-title">⏳ Časová Osa</div>
          <span class="tl-hint">Klik na kartu = detail události${editing ? ' · Táhni kartu = přeskládat' : ''}</span>
          ${editToggle}
          ${editing ? `<button class="tl-add-btn"${dataAction('EditMode.startNewEvent')}>＋ Nová událost</button>` : ''}
        </div>
        <div class="tl-board-viewport">
          <div class="tl-board" id="tl-board"></div>
        </div>
      </div>`;

    const board = document.getElementById('tl-board');

    // One column per sezení in 1..maxSitting (including empty ones so
    // you can drop into a skipped session).
    for (let s = 1; s <= maxSitting; s++) {
      _renderColumn(board, {
        sitting: s,
        label:   `Sezení ${s}`,
        events:  byCol.get(s) || [],
        editing,
        variant: 'sitting',
      });
    }

    // Phantom "new sezení" column (edit mode only). Drop here to bump
    // an event into a brand-new sezení at the end.
    if (editing) {
      _renderColumn(board, {
        sitting: maxSitting + 1,
        label:   `Nové sezení ${maxSitting + 1}`,
        events:  [],
        editing,
        variant: 'phantom',
      });
    }
  }

  function _renderColumn(board, opts) {
    const { sitting, label, events, editing, variant } = opts;
    const col = document.createElement('div');
    col.className = `tl-col tl-col-${variant}`;
    col.dataset.sitting = String(sitting);
    if (events.length > STACK_THRESHOLD) col.classList.add('tl-col-stacked');

    // Header
    col.innerHTML = `
      <div class="tl-col-header">
        <div class="tl-col-title">${esc(label)}</div>
        <div class="tl-col-count">${events.length || ''}</div>
      </div>
      <div class="tl-col-body"></div>
      ${editing ? `<button class="tl-col-add" data-sitting="${sitting}">＋ Nová událost</button>` : ''}
    `;

    const body = col.querySelector('.tl-col-body');
    events.forEach(e => body.appendChild(_buildCard(e, col)));

    // Tap-to-expand for touch devices. Ignore taps on cards themselves
    // (those navigate) — only the column background toggles.
    if (col.classList.contains('tl-col-stacked')) {
      col.addEventListener('click', ev => {
        if (ev.target.closest('.tl-card')) return;
        if (ev.target.closest('.tl-col-add')) return;
        col.classList.toggle('tl-col-expanded');
      });
    }

    if (editing) {
      const btn = col.querySelector('.tl-col-add');
      if (btn) {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          EditMode.startNewEvent({ sitting });
        });
      }
      _wireColumnDrop(col, body, sitting);
    }

    board.appendChild(col);
  }

  return { render, setEditing };
})();
