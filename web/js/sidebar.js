// ═══════════════════════════════════════════════════════════════
//  SIDEBAR — data-driven left navigation.
//
//  The sidebar nav is rendered from `Store.getSidebarLayout()` (a
//  DM-curated config in settings) rather than static markup. Section
//  grouping + page order are configurable via the drag-drop editor in
//  Settings → Postranní panel (`renderEditor`, added by the editor
//  build). Role-gated sections / pages never reach a non-DM viewer's
//  DOM. Collapsible sections persist their open state in localStorage.
//
//  Rendered into #sidebar-nav-root — a `display:contents` wrapper
//  inside `.sidebar`, so the sections lay out exactly like the old
//  static markup and every existing `.sidebar .sidebar-section` /
//  `.sidebar-nav` CSS selector keeps matching.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { Role } from './role.js';
import { SIDEBAR_PAGES, SIDEBAR_LAYOUT_DEFAULT } from './constants.js';
import { Addons } from './addons.js';
import { esc, dataAction, dataOn } from './utils.js';

export const Sidebar = (() => {
  const _pageByRoute = new Map(SIDEBAR_PAGES.map(p => [p.route, p]));
  const COLLAPSE_KEY = (id) => `sidebar_section_open:${id}`;

  // Mind-map sub-routes that all light up the Myšlenkový Palác link
  // (mirrors app.js navigate()'s active-link logic).
  const PALAC_ROUTES = new Set(['/mapa/palac', '/mapa/frakce', '/mapa/vztahy', '/mapa/tajemstvi']);

  function _isDM() {
    try { return Role.isDM(); } catch { return false; }
  }

  function _sectionOpen(sec) {
    try {
      const v = localStorage.getItem(COLLAPSE_KEY(sec.id));
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (_) {}
    return sec.defaultOpen !== false;
  }

  // A page <li>; '' when the page is unknown (stale route) or DM-only
  // for a non-DM viewer.
  function _pageLi(route) {
    const p = _pageByRoute.get(route);
    if (!p) return '';
    if (p.role === 'dm' && !_isDM()) return '';
    return `<li><a href="#${esc(route)}" class="nav-link" data-route="${esc(route)}">` +
      `<span class="nav-icon">${esc(p.icon || '')}</span> ${esc(p.label || route)}</a></li>`;
  }

  // A section heading + its <ul>; '' when the whole section is DM-only
  // for a non-DM viewer, or has no visible pages (no empty headings).
  function _sectionHtml(sec) {
    if (!sec || (sec.role === 'dm' && !_isDM())) return '';
    const lis = (sec.pages || []).map(_pageLi).filter(Boolean).join('');
    if (!lis) return '';
    const icon = sec.icon ? `${esc(sec.icon)} ` : '';
    const label = esc(sec.label || '');
    if (sec.collapsible) {
      const open = _sectionOpen(sec);
      return `
        <button class="sidebar-subsection${open ? ' is-open' : ''}" type="button"
                data-section-id="${esc(sec.id)}" aria-expanded="${open ? 'true' : 'false'}"
                ${dataAction('Sidebar.toggleSection', sec.id)}>
          <span class="sidebar-subsection-chevron">▸</span>
          <span class="sidebar-subsection-label">${icon}${label}</span>
        </button>
        <ul class="sidebar-nav sidebar-subsection-list${open ? ' is-open' : ''}" data-section-list="${esc(sec.id)}">${lis}</ul>`;
    }
    return `
      <div class="sidebar-section sidebar-section-${esc(sec.id)}">${icon}${label}</div>
      <ul class="sidebar-nav">${lis}</ul>`;
  }

  // Addon-registered sidebar links (CodexHost). Phase 1 groups them all
  // under a single "Doplňky" section appended after the DM's layout;
  // placement into the DM-configurable layout arrives in a later phase.
  // Role-gated addon pages (spec.role === 'dm') never reach a non-DM DOM.
  function _addonPageLi(spec) {
    if (!spec || typeof spec.route !== 'string') return '';
    if (spec.role === 'dm' && !_isDM()) return '';
    return `<li><a href="#${esc(spec.route)}" class="nav-link" data-route="${esc(spec.route)}">` +
      `<span class="nav-icon">${esc(spec.icon || '🧩')}</span> ${esc(spec.label || spec.route)}</a></li>`;
  }
  function _addonSectionHtml() {
    let pages = [];
    try { pages = Addons.sidebarPages ? Addons.sidebarPages() : []; } catch (_) {}
    const lis = pages.map(_addonPageLi).filter(Boolean).join('');
    if (!lis) return '';
    return `
      <div class="sidebar-section sidebar-section-doplnky">🧩 Doplňky</div>
      <ul class="sidebar-nav">${lis}</ul>`;
  }

  /** Rebuild the sidebar nav from the current layout. Idempotent and
   *  cheap — safe to call at boot, after Store.load, on role:changed,
   *  and after every SSE refetch. No-op until #sidebar-nav-root exists. */
  function render() {
    const root = document.getElementById('sidebar-nav-root');
    if (!root) return;
    const layout = Store.getSidebarLayout();
    root.innerHTML = (layout.sections || []).map(_sectionHtml).join('') + _addonSectionHtml();
    _markActive();
  }

  /** Toggle a collapsible section's open state (persisted per id).
   *  Generalises the retired `toggleKompendium`. */
  function toggleSection(id) {
    const sel = (attr) => `.sidebar [${attr}="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`;
    const btn  = document.querySelector(sel('data-section-id'));
    const list = document.querySelector(sel('data-section-list'));
    if (!btn || !list) return;
    const open = btn.classList.toggle('is-open');
    list.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    try { localStorage.setItem(COLLAPSE_KEY(id), open ? '1' : '0'); } catch (_) {}
  }

  // Re-apply the active-link highlight for the current hash route.
  // Mirrors app.js navigate()'s sidebar logic so a standalone render()
  // is correct without waiting for the next navigation.
  function _markActive() {
    const route = (location.hash || '#/').replace(/^#/, '') || '/';
    document.querySelectorAll('.sidebar [data-route]').forEach(el => {
      const r = el.dataset.route;
      let active = r === route || r === '/' + route.split('/')[1] || route.startsWith(r + '/');
      if (r === '/mapa/palac' && PALAC_ROUTES.has(route)) active = true;
      if (r === '/mapa/svet' && route.startsWith('/mapa/local/')) active = true;
      el.classList.toggle('active', active);
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  LAYOUT EDITOR (Settings → Postranní panel) — drag & drop
  // ══════════════════════════════════════════════════════════════
  // Renders into the settings page; every change mutates
  // settings.sidebarLayout (DM-only write) and re-renders both itself
  // and the live sidebar. DnD is wired through delegated document
  // listeners (registered once, below), scoped to #sidebar-layout-editor
  // so it never clashes with the timeline's own drag handlers.
  const HIDDEN_ID = '__hidden__';
  const _midY = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };

  function _pageRowHtml(route, secId) {
    const p = _pageByRoute.get(route);
    if (!p) return '';
    const move = secId === HIDDEN_ID
      ? `<button type="button" class="sb-page-btn" ${dataAction('Sidebar.showPage', route)} title="Zobrazit v panelu">← zobrazit</button>`
      : `<button type="button" class="sb-page-btn" ${dataAction('Sidebar.hidePage', route)} title="Skrýt z panelu">skrýt →</button>`;
    return `
      <li class="sb-page" data-route="${esc(route)}" data-sec-id="${esc(secId)}">
        <span class="sb-grip" draggable="true" title="Přetáhni" aria-hidden="true">⠿</span>
        <span class="sb-page-icon">${esc(p.icon || '')}</span>
        <span class="sb-page-label">${esc(p.label || route)}</span>
        ${p.role === 'dm' ? '<span class="sb-page-tag">DM</span>' : ''}
        ${move}
      </li>`;
  }

  function _secCardHtml(sec) {
    const rows = (sec.pages || []).map(r => _pageRowHtml(r, sec.id)).join('');
    return `
      <div class="sb-sec" data-sec-id="${esc(sec.id)}">
        <div class="sb-sec-head">
          <span class="sb-grip sb-sec-grip" draggable="true" title="Přetáhni sekci" aria-hidden="true">⠿</span>
          <input class="sb-sec-label" type="text" value="${esc(sec.label || '')}" placeholder="Název sekce"
                 ${dataOn('change', 'Sidebar.setSectionLabel', sec.id, '$value')}>
          <input class="sb-sec-icon" type="text" maxlength="3" value="${esc(sec.icon || '')}" placeholder="🙂"
                 title="Ikona sekce (volitelné)" ${dataOn('change', 'Sidebar.setSectionIcon', sec.id, '$value')}>
          <label class="sb-sec-flag" title="Sbalitelná sekce (jako Kompendium)">
            <input type="checkbox" ${sec.collapsible ? 'checked' : ''}
              ${dataOn('change', 'Sidebar.setSectionFlag', sec.id, 'collapsible', '$checked')}> Sbalitelná</label>
          <label class="sb-sec-flag" title="Zobrazovat jen DM">
            <input type="checkbox" ${sec.role === 'dm' ? 'checked' : ''}
              ${dataOn('change', 'Sidebar.setSectionFlag', sec.id, 'role', '$checked')}> Jen DM</label>
          <button type="button" class="sb-sec-del" ${dataAction('Sidebar.deleteSection', sec.id)} title="Smazat sekci">🗑</button>
        </div>
        <ul class="sb-pages" data-sec-id="${esc(sec.id)}">${rows || '<li class="sb-empty">— sem přetáhni stránku —</li>'}</ul>
      </div>`;
  }

  function _hiddenBucketHtml(hidden) {
    const rows = (hidden || []).map(r => _pageRowHtml(r, HIDDEN_ID)).join('');
    return `
      <div class="sb-sec sb-hidden" data-sec-id="${HIDDEN_ID}">
        <div class="sb-sec-head"><span class="sb-sec-label-static">🗂 Skryté / nezařazené</span></div>
        <ul class="sb-pages" data-sec-id="${HIDDEN_ID}">${rows || '<li class="sb-empty">— prázdné —</li>'}</ul>
      </div>`;
  }

  function _editorBodyHtml(layout) {
    return (layout.sections || []).map(_secCardHtml).join('') + _hiddenBucketHtml(layout.hidden);
  }

  /** Full editor panel for the Settings → Postranní panel tab. */
  function renderEditor() {
    return `
      <div class="settings-editor-head">
        <h2>🧭 Postranní panel</h2>
        <div class="settings-editor-actions">
          <button type="button" class="inline-create-btn" ${dataAction('Sidebar.addSection')}>＋ Sekce</button>
          <button type="button" class="inline-create-btn" title="Obnovit výchozí rozložení"
            ${dataAction('Sidebar.resetLayout')}>↺ Výchozí</button>
        </div>
      </div>
      <div class="settings-panel">
        <p class="settings-hint" style="margin-bottom:0.8rem">
          Uspořádej levý panel: přetáhni stránky mezi sekcemi nebo do <em>Skryté</em>,
          přetáhni sekci za úchyt <span class="sb-grip">⠿</span> pro změnu pořadí.
          Sekci lze přejmenovat, dát jí ikonu, označit jako sbalitelnou nebo jen pro
          DM. Změny se projeví okamžitě a sdílí se všem.
        </p>
        <div id="sidebar-layout-editor" class="sb-editor">${_editorBodyHtml(Store.getSidebarLayout())}</div>
      </div>`;
  }

  function _rerenderEditor() {
    const el = document.getElementById('sidebar-layout-editor');
    if (el) el.innerHTML = _editorBodyHtml(Store.getSidebarLayout());
    render();
  }

  // ── Edit actions (data-action / data-on targets) ──────────────
  function _findSec(layout, id) { return layout.sections.find(s => s.id === id); }
  function _removeRoute(layout, route) {
    for (const s of layout.sections) s.pages = s.pages.filter(r => r !== route);
    layout.hidden = layout.hidden.filter(r => r !== route);
  }

  // Label/icon/flag edits commit + refresh the live sidebar only — the
  // editor DOM already shows the change, and re-rendering it would yank
  // focus out of the input mid-type.
  function setSectionLabel(id, value) {
    const layout = Store.getSidebarLayout(); const sec = _findSec(layout, id); if (!sec) return;
    sec.label = String(value || '').slice(0, 40); Store.setSidebarLayout(layout); render();
  }
  function setSectionIcon(id, value) {
    const layout = Store.getSidebarLayout(); const sec = _findSec(layout, id); if (!sec) return;
    sec.icon = String(value || '').trim().slice(0, 3); Store.setSidebarLayout(layout); render();
  }
  function setSectionFlag(id, flag, checked) {
    const layout = Store.getSidebarLayout(); const sec = _findSec(layout, id); if (!sec) return;
    if (flag === 'collapsible') sec.collapsible = !!checked;
    else if (flag === 'role')   sec.role = checked ? 'dm' : '';
    Store.setSidebarLayout(layout); render();
  }

  // Structural edits re-render the editor + the live sidebar.
  function addSection() {
    const layout = Store.getSidebarLayout();
    layout.sections.push({ id: Store.generateId('sekce'), label: 'Nová sekce', icon: '', collapsible: false, defaultOpen: true, role: '', pages: [] });
    Store.setSidebarLayout(layout); _rerenderEditor();
  }
  function deleteSection(id) {
    const layout = Store.getSidebarLayout(); const sec = _findSec(layout, id); if (!sec) return;
    layout.hidden.push(...sec.pages);                 // pages survive → hidden
    layout.sections = layout.sections.filter(s => s.id !== id);
    Store.setSidebarLayout(layout); _rerenderEditor();
  }
  function hidePage(route) {
    const layout = Store.getSidebarLayout();
    _removeRoute(layout, route); layout.hidden.push(route);
    Store.setSidebarLayout(layout); _rerenderEditor();
  }
  function showPage(route) {
    const layout = Store.getSidebarLayout();
    _removeRoute(layout, route);
    const page = _pageByRoute.get(route);
    const home = _findSec(layout, page && page.section) || layout.sections[0];
    if (home) home.pages.push(route); else layout.hidden.push(route);
    Store.setSidebarLayout(layout); _rerenderEditor();
  }
  function resetLayout() {
    Store.setSidebarLayout(JSON.parse(JSON.stringify(SIDEBAR_LAYOUT_DEFAULT)));
    _rerenderEditor();
  }

  // ── Drag & drop (delegated document listeners, registered once) ─
  let _drag = null;   // {kind:'page', route, fromSecId} | {kind:'section', secId}
  const _inEditor = (el) => !!(el && el.closest && el.closest('#sidebar-layout-editor'));
  const _clearIndicator = () => document.querySelectorAll('.sb-drop-indicator').forEach(n => n.remove());
  // Rows/cards excluding the element currently being dragged, so the
  // computed insert index lines up with the data array after removal.
  const _liveRows = (container, sel) =>
    [...container.querySelectorAll(`:scope > ${sel}`)].filter(el => !el.classList.contains('sb-dragging'));

  function _onDragStart(e) {
    const src = e.target.closest && e.target.closest('.sb-page, .sb-sec');
    if (!src || !_inEditor(src)) return;
    if (src.classList.contains('sb-page')) {
      _drag = { kind: 'page', route: src.dataset.route, fromSecId: src.dataset.secId };
    } else {
      if (src.dataset.secId === HIDDEN_ID) return;    // hidden bucket isn't reorderable
      _drag = { kind: 'section', secId: src.dataset.secId };
    }
    src.classList.add('sb-dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', _drag.route || _drag.secId);
      e.dataTransfer.setDragImage(src, 12, 12);     // drag the whole row/card, not the tiny grip
    } catch (_) {}
  }

  function _onDragOver(e) {
    if (!_drag) return;
    _clearIndicator();
    if (_drag.kind === 'page') {
      const list = e.target.closest && e.target.closest('.sb-pages');
      if (!list || !_inEditor(list)) return;
      e.preventDefault();
      const ind = document.createElement('li'); ind.className = 'sb-drop-indicator';
      const before = _liveRows(list, '.sb-page').find(r => e.clientY < _midY(r));
      before ? list.insertBefore(ind, before) : list.appendChild(ind);
    } else {
      const editor = document.getElementById('sidebar-layout-editor');
      if (!editor || !_inEditor(e.target)) return;
      e.preventDefault();
      const ind = document.createElement('div'); ind.className = 'sb-drop-indicator sb-drop-indicator-sec';
      const before = _liveRows(editor, '.sb-sec:not(.sb-hidden)').find(c => e.clientY < _midY(c));
      if (before) editor.insertBefore(ind, before);
      else { const h = editor.querySelector(':scope > .sb-hidden'); h ? editor.insertBefore(ind, h) : editor.appendChild(ind); }
    }
  }

  function _onDrop(e) {
    if (!_drag) return;
    const layout = Store.getSidebarLayout();
    if (_drag.kind === 'page') {
      const list = e.target.closest && e.target.closest('.sb-pages');
      if (list && _inEditor(list)) {
        e.preventDefault();
        const rows = _liveRows(list, '.sb-page');
        let idx = rows.findIndex(r => e.clientY < _midY(r));
        if (idx < 0) idx = rows.length;
        _removeRoute(layout, _drag.route);
        const destId = list.dataset.secId;
        if (destId === HIDDEN_ID) layout.hidden.splice(Math.min(idx, layout.hidden.length), 0, _drag.route);
        else { const dest = _findSec(layout, destId); dest ? dest.pages.splice(idx, 0, _drag.route) : layout.hidden.push(_drag.route); }
        Store.setSidebarLayout(layout);
      }
    } else if (_drag.kind === 'section') {
      const editor = document.getElementById('sidebar-layout-editor');
      if (editor && _inEditor(e.target)) {
        e.preventDefault();
        const cards = _liveRows(editor, '.sb-sec:not(.sb-hidden)');
        let idx = cards.findIndex(c => e.clientY < _midY(c));
        if (idx < 0) idx = cards.length;
        const from = layout.sections.findIndex(s => s.id === _drag.secId);
        if (from >= 0) { const [moved] = layout.sections.splice(from, 1); layout.sections.splice(idx, 0, moved); Store.setSidebarLayout(layout); }
      }
    }
    _onDragEnd();
    _rerenderEditor();
  }

  function _onDragEnd() {
    _drag = null;
    _clearIndicator();
    document.querySelectorAll('.sb-dragging').forEach(n => n.classList.remove('sb-dragging'));
  }

  document.addEventListener('dragstart', _onDragStart);
  document.addEventListener('dragover', _onDragOver);
  document.addEventListener('drop', _onDrop);
  document.addEventListener('dragend', _onDragEnd);

  return {
    render, toggleSection, renderEditor,
    addSection, deleteSection, resetLayout,
    setSectionLabel, setSectionIcon, setSectionFlag,
    hidePage, showPage,
  };
})();
