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
import { esc, dataAction, pageEditToggle } from './utils.js';
import { I18n } from './i18n.js';
import { Addons } from './addons.js';

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
  /** No-arg public toggle wired to the shared `pageEditToggle` button.
   *  Reading `_editing` here at click time (instead of stamping it
   *  into the button's data-args at render time) keeps the button
   *  working across multiple toggles. */
  function toggleEditing() { setEditing(!_editing); }

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

    // Decomposed into NAMED fragments so addons can replace/hide/wrap/insert
    // the built-in pieces (Addons.applyFragments) AND append their own content
    // via the additive `timeline:card:extra` slot. Both are zero-cost when no
    // addon is installed (applyFragments returns the list unchanged; slotContent
    // returns []). The card stays exactly as before in a vanilla install.
    const frags = [
      { id: 'timeline:card:title', html: `<div class="tl-card-name">${esc(e.name)}</div>` },
      { id: 'timeline:card:body',  html: e.short ? `<div class="tl-card-desc">${esc(e.short)}</div>` : '' },
      { id: 'timeline:card:meta',  html: `
      <div class="tl-card-meta">
        ${charNames.length ? `<div class="tl-card-chars">👤 ${charNames.join(', ')}${charMore}</div>` : ''}
        ${locNames.length  ? `<div class="tl-card-loc">📍 ${locNames.join(' → ')}</div>` : ''}
      </div>` },
    ];
    const ctx = { event: e, sitting: e.sitting, role: { isDM: Role.isDM() } };
    for (const c of Addons.slotContent('timeline:card:extra', ctx)) {
      frags.push({ id: `timeline:card:addon:${c.addonId}`, html: `<div class="tl-card-addon" data-addon-id="${esc(c.addonId)}">${c.html}</div>` });
    }
    return Addons.applyFragments('timeline:card', frags, e).map(f => f.html).join('');
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

    // Edit toggle via the shared template — same look + behaviour as
    // /mapa/svet and /mapa/palac. Clicking calls Timeline.toggleEditing
    // (no args) so the button keeps working across multiple toggles.
    const editToggle = pageEditToggle({
      moduleName: 'Timeline', isEditing: editing, label: I18n.t('timeline.editToggleLabel'),
    });
    // Addon toolbar contributions (e.g. a filter chip / counter). Zero-cost
    // without addons.
    const toolbarExtra = Addons.slotContent('timeline:toolbar', { editing, role: { isDM: Role.isDM() } })
      .map(c => `<span class="tl-toolbar-addon" data-addon-id="${esc(c.addonId)}">${c.html}</span>`).join('');

    document.getElementById('main-content').style.display = '';
    document.getElementById('main-content').innerHTML = `
      <div class="tl-shell ${editing ? 'is-editing' : ''}">
        <div class="tl-toolbar">
          <div class="tl-title">⏳ ${esc(I18n.t('timeline.title'))}</div>
          <span class="tl-hint">${esc(I18n.t('timeline.hintBase'))}${editing ? ` · ${esc(I18n.t('timeline.hintDrag'))}` : ''}</span>
          ${editToggle}${toolbarExtra}
          ${editing ? `<button class="tl-add-btn"${dataAction('EditMode.startNewEvent')}>＋ ${esc(I18n.t('timeline.newEvent'))}</button>` : ''}
        </div>
        <div class="tl-board-viewport">
          <div class="tl-board" id="tl-board"></div>
        </div>
        <input type="range" class="tl-hscroll" id="tl-hscroll" min="0" max="1000" value="0"
          aria-label="${esc(I18n.t('timeline.scrollSittings'))}" style="display:none">
      </div>`;

    const board = document.getElementById('tl-board');

    // One column per sezení in 1..maxSitting (including empty ones so
    // you can drop into a skipped session).
    for (let s = 1; s <= maxSitting; s++) {
      _renderColumn(board, {
        sitting: s,
        label:   I18n.t('timeline.session', { n: s }),
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
        label:   I18n.t('timeline.newSession', { n: maxSitting + 1 }),
        events:  [],
        editing,
        variant: 'phantom',
      });
    }

    _wireHScroll();
  }

  // Horizontal "pan" slider under the board — THE scroll control for
  // sittings when there are more columns than fit (the native scrollbar
  // is hidden in CSS; this styled slider replaces it). Two-way synced
  // with the viewport; hidden when the board doesn't overflow. The
  // mouse wheel also pans the board horizontally (vertical wheels have
  // no other job here — except over a column whose card list itself
  // overflows, where the native vertical scroll must win).
  let _hscrollWired = false;
  function _syncHScroll() {
    const viewport = document.querySelector('.tl-board-viewport');
    const slider = document.getElementById('tl-hscroll');
    if (!viewport || !slider) return;
    const ms = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    if (ms <= 0) { slider.style.display = 'none'; return; }
    slider.style.display = '';
    slider.max = String(ms);
    slider.value = String(Math.round(viewport.scrollLeft));
  }
  function _wireHScroll() {
    const viewport = document.querySelector('.tl-board-viewport');
    const slider = document.getElementById('tl-hscroll');
    if (!viewport || !slider) return;
    slider.addEventListener('input', () => { viewport.scrollLeft = Number(slider.value); });
    viewport.addEventListener('scroll', () => { slider.value = String(Math.round(viewport.scrollLeft)); }, { passive: true });
    viewport.addEventListener('wheel', (e) => {
      // Trackpads emit dominant deltaX for sideways swipes — the
      // viewport already scrolls those natively.
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      // Over a vertically-overflowing column body, the wheel keeps its
      // native job (scrolling the cards).
      const colBody = e.target instanceof Element ? e.target.closest('.tl-col-body') : null;
      if (colBody && colBody.scrollHeight > colBody.clientHeight) return;
      // deltaMode 1 = lines (Firefox) → approximate px per line.
      viewport.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 40 : 1);
      e.preventDefault();
    }, { passive: false });
    if (!_hscrollWired) { window.addEventListener('resize', _syncHScroll); _hscrollWired = true; }
    _syncHScroll();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(_syncHScroll);
  }

  function _renderColumn(board, opts) {
    const { sitting, label, events, editing, variant } = opts;
    const col = document.createElement('div');
    col.className = `tl-col tl-col-${variant}`;
    col.dataset.sitting = String(sitting);
    if (events.length > STACK_THRESHOLD) col.classList.add('tl-col-stacked');

    // Header + optional addon column slots (header/footer). Zero-cost without addons.
    const colCtx = { sitting, events, label, role: { isDM: Role.isDM() } };
    const _slotBlock = (slotId, cls) => {
      const items = Addons.slotContent(slotId, colCtx);
      return items.length
        ? `<div class="${cls}">${items.map(c => `<div class="tl-col-addon" data-addon-id="${esc(c.addonId)}">${c.html}</div>`).join('')}</div>`
        : '';
    };
    col.innerHTML = `
      <div class="tl-col-header">
        <div class="tl-col-title">${esc(label)}</div>
        <div class="tl-col-count">${events.length || ''}</div>
      </div>
      ${_slotBlock('timeline:column:header', 'tl-col-header-extra')}
      <div class="tl-col-body"></div>
      ${_slotBlock('timeline:column:footer', 'tl-col-footer-extra')}
      ${editing ? `<button class="tl-col-add" data-sitting="${sitting}">＋ ${esc(I18n.t('timeline.newEvent'))}</button>` : ''}
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

  return { render, setEditing, toggleEditing };
})();
