// ═══════════════════════════════════════════════════════════════
//  SETTINGS PAGE — user-editable enums at /nastaveni.
//  Left column lists categories, right column edits the selected
//  one. Delete-with-usage shows a modal that lets the GM choose
//  between replace-with, force-delete, or cancel. Orphan references
//  are handled gracefully by resolveEnum() in consumers.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { EditMode } from './editmode.js';
import { WorldMap } from './map.js';
import { esc, dataAction, dataOn } from './utils.js';
import { SIDEBAR_PAGES } from './constants.js';

export const Settings = (() => {

  // Shape of each category: which fields to expose in the editor form.
  // `size` is only meaningful for pinTypes (default px size for new
  // places of that type). `icon` / `color` are shown as side-by-side
  // inputs when declared.
  const CATEGORIES = [
    { id: 'relationshipTypes', label: 'Vazby mezi postavami', icon: '🔗',
      fields: ['label', 'color', 'style'] },
    { id: 'genders',           label: 'Pohlaví',              icon: '⚥',
      fields: ['label'] },
    { id: 'pinTypes',          label: 'Typy míst',             icon: '📍',
      fields: ['label', 'icon', 'color', 'size'] },
    { id: 'characterStatuses', label: 'Stavy postav',          icon: '●',
      fields: ['label', 'icon', 'color'] },
    { id: 'locationStatuses',  label: 'Stavy míst',            icon: '🏚',
      fields: ['label', 'icon', 'color', 'severity'] },
    { id: 'artifactStates',    label: 'Stavy artefaktů',       icon: '🗝',
      fields: ['label', 'icon', 'color'] },
    { id: 'eventPriorities',   label: 'Priority událostí',     icon: '⚑',
      fields: ['label', 'color'] },
    // "Postoje k partě" — unified palette used on character / location /
    // faction glows. The intensity (`strength`) lives on each entity's
    // attitude entry, NOT on the enum item, so this editor only manages
    // colours + label. `bg` drives map-pin fill, `fg` is the icon contrast
    // on the pin, `labelColor` is the readable colour on dark UI (chip
    // text, glow, legend).
    { id: 'attitudes',         label: 'Postoje k partě',       icon: '🤝',
      fields: ['label', 'bg', 'fg', 'labelColor'] },
  ];

  // Non-enum tabs live alongside the category tabs. They render custom
  // panels (world-map upload, map-view presets, backup tools) instead
  // of the enum editor.
  const SPECIAL_TABS = [
    { id: 'worldmap',     label: 'Mapa světa',      icon: '🗺' },
    { id: 'mapViews',     label: 'Pohledy na mapě', icon: '📍' },
    { id: 'sidebarPages', label: 'Postranní panel', icon: '🧭' },
    { id: 'backup',       label: 'Záloha',          icon: '💾' },
  ];

  let _activeCat       = CATEGORIES[0].id;
  let _editingId       = null;  // id being edited inline, or '__new__' for add form
  let _snapshots       = [];    // populated by _loadSnapshots()
  // pinTypeId whose marker-icon panel is currently expanded. Only one at
  // a time — opening another collapses the previous so the layout stays
  // tidy when there are many pin types.
  let _iconPanelOpenFor = null;

  // ── Render ───────────────────────────────────────────────────
  function render() {
    const el = document.getElementById('main-content');
    if (!el) return;
    el.innerHTML = _pageHtml();
    el.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function _pageHtml() {
    const enumTabs = CATEGORIES.map(c => `
      <button type="button" class="settings-tab ${c.id===_activeCat?'is-active':''}"
        ${dataAction('Settings.selectCategory', c.id)}>
        <span class="settings-tab-icon">${c.icon}</span>
        <span class="settings-tab-label">${esc(c.label)}</span>
        <span class="settings-tab-count">${Store.getEnum(c.id).length}</span>
      </button>`).join('');
    const specialTabs = SPECIAL_TABS.map(t => `
      <button type="button" class="settings-tab ${t.id===_activeCat?'is-active':''}"
        ${dataAction('Settings.selectCategory', t.id)}>
        <span class="settings-tab-icon">${t.icon}</span>
        <span class="settings-tab-label">${esc(t.label)}</span>
      </button>`).join('');
    return `
      <div class="settings-page">
        <div class="page-header"><h1>⚙ Nastavení</h1>
          <div class="subtitle">Číselníky, svět, zálohy.</div>
        </div>
        <div class="settings-shell">
          <nav class="settings-tabs">
            ${enumTabs}
            <div class="settings-tabs-sep"></div>
            ${specialTabs}
          </nav>
          <section class="settings-editor">${_editorHtml()}</section>
        </div>
      </div>`;
  }

  function _editorHtml() {
    if (_activeCat === 'worldmap')     return _worldmapHtml();
    if (_activeCat === 'mapViews')     return _mapViewsHtml();
    if (_activeCat === 'sidebarPages') return _sidebarPagesHtml();
    if (_activeCat === 'backup')       return _backupHtml();
    const cat = CATEGORIES.find(c => c.id === _activeCat);
    const items = Store.getEnum(_activeCat);
    const rows = items.map(it => _rowHtml(cat, it)).join('');
    const addForm = _editingId === '__new__'
      ? _formHtml(cat, { id:'', label:'', color:'#888', icon:'', size:28, style:'solid' }, true)
      : '';
    return `
      <div class="settings-editor-head">
        <h2>${cat.icon} ${esc(cat.label)}</h2>
        <div class="settings-editor-actions">
          <button type="button" class="inline-create-btn"
            ${dataAction('Settings.startNew')}>＋ Přidat</button>
          <button type="button" class="inline-create-btn"
            title="Přidat zpět chybějící výchozí položky"
            ${dataAction('Settings.resetDefaults')}>↺ Doplnit výchozí</button>
        </div>
      </div>
      ${addForm}
      <div class="settings-rows">
        ${rows || '<div class="settings-empty">Tato kategorie je prázdná.</div>'}
      </div>
      <p class="settings-hint">
        Smazání položky, která je používaná, nabídne možnost nahradit ji
        jinou položkou nebo odstranit i tak (chybějící odkazy se vykreslují
        s ⚠ varováním, nic se nerozbije).
      </p>`;
  }

  function _rowHtml(cat, item) {
    if (_editingId === item.id) return _formHtml(cat, item, false);
    const usageCount = Store.findEnumUsages(_activeCat, item.id).length;
    const swatch = item.color
      ? `<span class="settings-swatch" style="background:${esc(item.color)}"></span>` : '';
    // Marker-icon panel toggle — pinTypes only. Opens an editor for
    // strategy + uploaded image variants below the row.
    const iconBtn = (cat.id === 'pinTypes')
      ? `<button type="button" class="settings-btn-icons"
            title="Vlastní ikony pro tuto značku"
            ${dataAction('Settings.toggleIconPanel', item.id)}>🎨</button>`
      : '';
    const row = `
      <div class="settings-row">
        <span class="settings-row-icon">${esc(item.icon || item.label?.[0] || '·')}</span>
        <span class="settings-row-label">${esc(item.label || item.id)}</span>
        ${swatch}
        <code class="settings-row-id">${esc(item.id)}</code>
        <span class="settings-row-usage" title="Použitích">${usageCount > 0 ? usageCount + '×' : '–'}</span>
        <div class="settings-row-actions">
          ${iconBtn}
          <button type="button" class="settings-btn-edit"
            ${dataAction('Settings.startEdit', item.id)}>✏</button>
          <button type="button" class="settings-btn-del"
            ${dataAction('Settings.requestDelete', item.id)}>🗑</button>
        </div>
      </div>`;
    if (cat.id === 'pinTypes' && _iconPanelOpenFor === item.id) {
      return row + _iconPanelHtml(item);
    }
    return row;
  }

  // ── Marker icon panel ──────────────────────────────────────────
  // Per-pinType editor for the optional `iconConfig` field. Lets
  // the GM upload variants (svg/png/jpeg/webp), choose a strategy
  // (single / random / state), and assign each file to a state.
  // All operations auto-persist — uploads write the file AND save
  // the iconConfig record in one logical save.
  function _iconPanelHtml(pinType) {
    const cfg = pinType.iconConfig || { strategy: 'single', files: [] };
    const strategy = cfg.strategy || 'single';
    const files    = Array.isArray(cfg.files) ? cfg.files : [];
    const statuses = Store.getEnum('locationStatuses') || [];

    const radio = (val, label, hint) => `
      <label class="mit-strategy-opt">
        <input type="radio" name="mit-strategy-${esc(pinType.id)}" value="${val}"
          ${strategy === val ? 'checked' : ''}
          ${dataOn('change', 'Settings.setIconStrategy', pinType.id, val)}>
        <span class="mit-strategy-label">
          <strong>${esc(label)}</strong>
          <span class="settings-hint">${esc(hint)}</span>
        </span>
      </label>`;

    const fileRows = files.map(f => {
      const stateOpts = `
        <option value="" ${f.stateId == null ? 'selected' : ''}>— Default —</option>
        ${statuses.map(s =>
          `<option value="${esc(s.id)}" ${f.stateId === s.id ? 'selected' : ''}>${esc(s.label || s.id)}</option>`
        ).join('')}`;
      return `
        <div class="mit-file-row">
          <div class="mit-thumb">
            <img src="${esc(f.url)}" alt="" ${dataOn('error', 'hide', '$el')}>
          </div>
          <code class="mit-file-name">${esc(f.id)}</code>
          <label class="settings-field" style="flex:0 0 auto;margin:0">
            <span class="settings-field-label" style="font-size:0.7rem">Stav</span>
            <select class="edit-select"
              ${dataOn('change', 'Settings.setIconState', pinType.id, f.id, '$value')}>
              ${stateOpts}
            </select>
          </label>
          <button type="button" class="settings-btn-del"
            title="Smazat tento soubor"
            ${dataAction('Settings.deleteIconFile', pinType.id, f.id)}>🗑</button>
        </div>`;
    }).join('');

    const empty = files.length ? '' : `
      <div class="settings-empty" style="margin:0.5rem 0">
        Zatím žádné soubory. Nahraj alespoň jeden — bez nahraných ikon
        se použije emoji glyf z výchozího nastavení.
      </div>`;

    return `
      <div class="mit-panel" id="mit-panel-${esc(pinType.id)}">
        <div class="mit-strategy-row">
          ${radio('single', 'Jeden soubor',     'Vždy se vykreslí výchozí (Default) soubor.')}
          ${radio('random', 'Náhodná varianta', 'Pro každé místo se deterministicky vybere jedna z variant.')}
          ${radio('state',  'Podle stavu',      'Použije se ikona odpovídající stavu místa, jinak nejbližší podle severity.')}
        </div>
        ${empty}
        <div class="mit-files">${fileRows}</div>
        <div class="mit-uploader">
          <label class="inline-create-btn" style="cursor:pointer;display:inline-block">
            📤 Nahrát soubory…
            <input type="file" multiple accept=".svg,.png,.jpg,.jpeg,.webp,image/svg+xml,image/png,image/jpeg,image/webp"
              style="display:none"
              ${dataOn('change', 'Settings.uploadIconFiles', pinType.id, '$el')}>
          </label>
          <span class="settings-hint">SVG / PNG / JPG / WebP, max 2 MB / soubor, 16 současně.</span>
        </div>
      </div>`;
  }

  function toggleIconPanel(pinTypeId) {
    _iconPanelOpenFor = (_iconPanelOpenFor === pinTypeId) ? null : pinTypeId;
    if (_iconPanelOpenFor) _editingId = null;  // mutually exclusive with inline edit
    render();
  }

  function _getPinType(id) {
    return Store.getEnum('pinTypes').find(p => p.id === id) || null;
  }
  function _ensureIconConfig(pt) {
    if (!pt.iconConfig || typeof pt.iconConfig !== 'object') {
      pt.iconConfig = { strategy: 'single', files: [] };
    }
    if (!Array.isArray(pt.iconConfig.files)) pt.iconConfig.files = [];
    if (typeof pt.iconConfig.strategy !== 'string') pt.iconConfig.strategy = 'single';
    return pt.iconConfig;
  }

  function setIconStrategy(pinTypeId, strategy) {
    const pt = _getPinType(pinTypeId);
    if (!pt) return;
    const cfg = _ensureIconConfig(pt);
    cfg.strategy = strategy;
    Store.saveEnumItem('pinTypes', pt);
    render();
  }

  function setIconState(pinTypeId, fileId, stateId) {
    const pt = _getPinType(pinTypeId);
    if (!pt) return;
    const cfg = _ensureIconConfig(pt);
    const f = cfg.files.find(x => x.id === fileId);
    if (!f) return;
    f.stateId = (stateId === '' || stateId == null) ? null : stateId;
    Store.saveEnumItem('pinTypes', pt);
    // No re-render needed — the dropdown's own value already shows
    // the new state. Skip the redraw to keep focus on the select.
  }

  function uploadIconFiles(pinTypeId, input) {
    const pt = _getPinType(pinTypeId);
    if (!pt) return;
    const files = input?.files;
    if (!files || !files.length) return;
    _flash('Nahrávám…');
    Store.uploadIcons(pinTypeId, files)
      .then(j => {
        const cfg = _ensureIconConfig(pt);
        for (const f of (j.files || [])) {
          // Skip duplicates by id (server returns the canonical name
          // including any -2/-3 collision suffix, so this is rare).
          if (cfg.files.some(x => x.id === f.id)) continue;
          cfg.files.push({ id: f.id, url: f.url, stateId: null });
        }
        Store.saveEnumItem('pinTypes', pt);
        render();
        _flash('Nahráno ✓');
      })
      .catch(e => _flash(e?.message || 'Nahrávání selhalo', false))
      .finally(() => { if (input) input.value = ''; });
  }

  function deleteIconFile(pinTypeId, fileId) {
    const pt = _getPinType(pinTypeId);
    if (!pt) return;
    if (!confirm(`Smazat soubor "${fileId}"?`)) return;
    Store.deleteIcon(pinTypeId, fileId).then(ok => {
      if (!ok) { _flash('Smazání selhalo', false); return; }
      const cfg = _ensureIconConfig(pt);
      cfg.files = cfg.files.filter(x => x.id !== fileId);
      Store.saveEnumItem('pinTypes', pt);
      render();
      _flash('Smazáno');
    });
  }

  function _formHtml(cat, item, isNew) {
    const uid = isNew ? 'new' : esc(item.id);
    const field = (name, placeholder, type='text') => {
      const val = item[name] == null ? '' : String(item[name]);
      return `
        <label class="settings-field">
          <span class="settings-field-label">${esc(_fieldLabel(name))}</span>
          <input class="edit-input" type="${type}" id="sf-${uid}-${name}"
            value="${esc(val)}" placeholder="${esc(placeholder || '')}">
        </label>`;
    };
    const colorField = (name) => `
      <label class="settings-field">
        <span class="settings-field-label">${esc(_fieldLabel(name))}</span>
        <input class="edit-input" type="color" id="sf-${uid}-${name}"
          value="${esc(item[name] || '#888888')}">
      </label>`;
    const styleField = () => `
      <label class="settings-field">
        <span class="settings-field-label">Styl čáry</span>
        <select class="edit-select" id="sf-${uid}-style">
          ${['solid','dashed','dotted'].map(s =>
            `<option value="${s}" ${item.style===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </label>`;
    const sizeField = () => `
      <label class="settings-field">
        <span class="settings-field-label">Výchozí velikost (px)</span>
        <input class="edit-input" type="number" id="sf-${uid}-size"
          min="14" max="64" step="2"
          value="${Number(item.size) || 28}">
      </label>`;
    // Numeric "decay axis" used by the marker icon resolver for
    // closest-match fallback. Empty input = null (off-axis: place
    // doesn't participate in the severity scale, e.g. "Tajné").
    const severityField = () => {
      const cur = (item.severity == null) ? '' : Number(item.severity);
      return `
      <label class="settings-field">
        <span class="settings-field-label">Severita <span class="settings-hint" style="font-weight:normal">(0 = pristine, vyšší = horší stav; prázdné = mimo škálu)</span></span>
        <input class="edit-input" type="number" id="sf-${uid}-severity"
          min="0" max="10" step="1"
          value="${esc(String(cur))}"
          placeholder="(prázdné)">
      </label>`;
    };

    const inputs = (cat.fields || []).map(name => {
      if (name === 'color' || name === 'bg' || name === 'fg' || name === 'labelColor') return colorField(name);
      if (name === 'style')                                                            return styleField();
      if (name === 'size')                                                             return sizeField();
      if (name === 'severity')                                                         return severityField();
      return field(name, name === 'icon' ? 'Emoji nebo znak' : 'Text');
    }).join('');

    return `
      <div class="settings-form">
        <div class="settings-form-row">
          ${isNew ? `
            <label class="settings-field">
              <span class="settings-field-label">ID (volitelně, vygeneruje se z názvu)</span>
              <input class="edit-input" id="sf-${uid}-id" placeholder="např. ally">
            </label>` : `
            <div class="settings-field settings-field-readonly">
              <span class="settings-field-label">ID</span>
              <code>${esc(item.id)}</code>
            </div>`}
          ${inputs}
        </div>
        <div class="settings-form-actions">
          <button type="button" class="edit-save-btn"
            ${dataAction('Settings.commit', uid, isNew)}>💾 Uložit</button>
          <button type="button" class="inline-create-btn"
            ${dataAction('Settings.cancelEdit')}>Zrušit</button>
        </div>
      </div>`;
  }

  function _fieldLabel(name) {
    return {
      label: 'Název', icon: 'Ikona', color: 'Barva',
      style: 'Styl', size: 'Velikost', severity: 'Severita',
      bg: 'Pozadí', fg: 'Popředí', labelColor: 'Barva textu',
    }[name] || name;
  }

  // ── Public commands (called from inline onclick handlers) ────
  function selectCategory(cat) {
    _activeCat = cat;
    _editingId = null;
    if (cat === 'backup') {
      // Fetch snapshot list before rendering so the table isn't empty
      // for a frame. Render once on entry (while pending), then again
      // when the list arrives.
      render();
      _loadSnapshots().then(render);
    } else {
      render();
    }
  }

  function startNew() {
    _editingId = '__new__';
    render();
  }

  function startEdit(id) {
    _editingId = id;
    render();
  }

  function cancelEdit() {
    _editingId = null;
    render();
  }

  function commit(uid, isNew) {
    const cat = CATEGORIES.find(c => c.id === _activeCat);
    const getVal = (name) => {
      const el = document.getElementById(`sf-${uid}-${name}`);
      return el ? el.value : '';
    };
    const existing = isNew ? null : Store.getEnum(_activeCat).find(x => x.id === uid);
    const label = getVal('label').trim();
    if (!label) { _flash('Název je povinný', false); return; }
    let id = isNew ? (getVal('id').trim() || _slug(label)) : uid;
    if (!id) id = _slug(label);
    if (isNew && Store.getEnum(_activeCat).some(x => x.id === id)) {
      _flash(`ID '${id}' už existuje — zvol jiné nebo nech vygenerovat`, false);
      return;
    }
    const item = { ...(existing || {}), id, label };
    for (const f of cat.fields) {
      const v = getVal(f);
      if (f === 'severity') {
        // Empty severity is meaningful: it means "off the decay axis"
        // (resolver skips this status for closest-match fallback).
        item[f] = (v === '' || v == null) ? null : Number(v);
      } else if (v !== '' && v != null) {
        item[f] = (f === 'size') ? Number(v) : v;
      }
    }
    Store.saveEnumItem(_activeCat, item);
    _editingId = null;
    render();
    _flash(isNew ? `Položka "${label}" vytvořena` : `Položka "${label}" upravena`);
  }

  function requestDelete(id) {
    const usages = Store.findEnumUsages(_activeCat, id);
    const item = Store.getEnum(_activeCat).find(x => x.id === id);
    if (!usages.length) {
      if (!confirm(`Smazat "${item?.label || id}"?`)) return;
      Store.deleteEnumItem(_activeCat, id);
      render();
      _flash('Smazáno');
      return;
    }
    _openDeleteModal(id, item, usages);
  }

  function resetDefaults() {
    Store.resetEnumCategory(_activeCat);
    render();
    _flash('Výchozí položky doplněny');
  }

  // ── Map-view presets panel ───────────────────────────────────
  // Presets are captured on the map itself via the ✚ toolbar button;
  // this panel only lists them and lets the GM rename or delete.
  // Entries are grouped by the map they belong to (world vs sub-map).
  function _mapViewsHtml() {
    const views = Store.getEnum('mapViews') || [];
    if (!views.length) return `
      <div class="settings-editor-head"><h2>📍 Pohledy na mapě</h2></div>
      <div class="settings-panel">
        ${_renderEmptyPresets()}
      </div>`;

    // Group by parentId (null = world). Label each group by the
    // parent location's name, or "Mapa světa" for the world group.
    const groups = new Map();
    for (const v of views) {
      const key = v.parentId || null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
    const sections = [];
    for (const [pid, list] of groups) {
      const parent   = pid ? (Store.getLocation(pid) || { name: '— neznámé místo —' }) : null;
      const title    = parent ? `🗺 ${esc(parent.name)}` : '🌐 Mapa světa';
      const rowsHtml = list.map(_mapViewRow).join('');
      sections.push(`
        <div class="settings-mapviews-group">
          <div class="settings-mapviews-group-title">${title}</div>
          <div class="settings-rows">${rowsHtml}</div>
        </div>`);
    }

    return `
      <div class="settings-editor-head">
        <h2>📍 Pohledy na mapě</h2>
      </div>
      <div class="settings-panel">
        <p class="settings-hint" style="margin-bottom:0.8rem">
          Nové pohledy vytvoř přímo na mapě: v režimu úprav přiblíž/oddalj
          požadovaný výřez a klikni na ✚ Uložit pohled v nástrojové liště.
        </p>
        ${sections.join('')}
      </div>`;
  }

  function _renderEmptyPresets() {
    return `
      <div class="settings-empty">
        Zatím žádné pohledy. Na mapě světa přiblíž/oddalj výřez a klikni
        na ✚ Uložit pohled (viditelné v režimu úprav).
      </div>`;
  }

  function _mapViewRow(v) {
    return `
      <div class="settings-row">
        <span class="settings-row-icon">${esc(v.icon || '📍')}</span>
        <span class="settings-row-label">${esc(v.label || '—')}</span>
        <code class="settings-row-id">${esc(v.id)}</code>
        <span></span>
        <span></span>
        <div class="settings-row-actions">
          <button type="button" class="settings-btn-edit"
                  title="Přejmenovat nebo změnit ikonu"
                  ${dataAction('Settings.renameMapView', v.id)}>✏</button>
          <button type="button" class="settings-btn-del"
                  title="Smazat pohled"
                  ${dataAction('Settings.deleteMapView', v.id)}>🗑</button>
        </div>
      </div>`;
  }

  function renameMapView(id) {
    const views = Store.getEnum('mapViews') || [];
    const v = views.find(x => x.id === id);
    if (!v) return;
    const label = prompt('Nový název pohledu:', v.label || '');
    if (label == null) return;
    const icon = prompt('Ikona:', v.icon || '📍');
    if (icon == null) return;
    Store.saveEnumItem('mapViews', { ...v, label: label.trim() || v.label, icon: icon.trim() || v.icon });
    render();
    _flash('Pohled upraven');
    // Mirror the change onto the live map toolbar if it's visible.
    try { WorldMap.refreshPresetButtons?.(); } catch (_) {}
  }

  function deleteMapView(id) {
    const views = Store.getEnum('mapViews') || [];
    const v = views.find(x => x.id === id);
    if (!v) return;
    if (!confirm(`Smazat pohled "${v.label || id}"?`)) return;
    Store.deleteEnumItem('mapViews', id, { force: true });
    render();
    _flash('Pohled smazán');
    try { WorldMap.refreshPresetButtons?.(); } catch (_) {}
  }

  // ── Sidebar pages panel ──────────────────────────────────────
  // Lists every page in the left sidebar (registry from
  // `constants.js → SIDEBAR_PAGES`) grouped by section. A checkbox
  // per row toggles whether that page appears in the sidebar; the
  // page itself stays reachable via direct URL or wikilinks.
  function _sidebarPagesHtml() {
    const hidden = new Set(Store.getHiddenSidebarPages());
    // Group pages by section, preserving registry order.
    const groups = [];
    const byKey = new Map();
    for (const p of SIDEBAR_PAGES) {
      if (!byKey.has(p.section)) {
        const g = { section: p.section, pages: [] };
        byKey.set(p.section, g);
        groups.push(g);
      }
      byKey.get(p.section).pages.push(p);
    }
    const sections = groups.map(g => {
      const rows = g.pages.map(p => {
        const isHidden = hidden.has(p.route);
        return `
          <div class="settings-sidebar-row">
            <label class="settings-sidebar-toggle" title="Zobrazovat v postranním panelu">
              <input type="checkbox" ${isHidden ? '' : 'checked'}
                ${dataOn('change', 'Settings.toggleSidebarPage', p.route, '$checked')}>
              <span class="settings-sidebar-toggle-track"></span>
            </label>
            <span class="settings-sidebar-icon">${esc(p.icon)}</span>
            <span class="settings-sidebar-label ${isHidden ? 'is-hidden' : ''}">${esc(p.label)}</span>
            <code class="settings-row-id">${esc(p.route)}</code>
            <a class="settings-sidebar-open" href="#${esc(p.route)}"
               title="Otevřít stránku">Otevřít →</a>
          </div>`;
      }).join('');
      return `
        <div class="settings-mapviews-group">
          <div class="settings-mapviews-group-title">${esc(g.section)}</div>
          <div class="settings-rows">${rows}</div>
        </div>`;
    }).join('');
    return `
      <div class="settings-editor-head">
        <h2>🧭 Postranní panel</h2>
        <div class="settings-editor-actions">
          <button type="button" class="inline-create-btn"
            title="Znovu zobrazit všechny stránky"
            ${dataAction('Settings.showAllSidebarPages')}>↺ Zobrazit vše</button>
        </div>
      </div>
      <div class="settings-panel">
        <p class="settings-hint" style="margin-bottom:0.8rem">
          Vyber, které stránky se mají zobrazovat v postranním panelu.
          Skryté stránky zůstávají dostupné přes přímý odkaz nebo
          wiki-odkaz <code>[[Název]]</code> — jen se nevypisují v menu.
        </p>
        ${sections}
      </div>`;
  }

  function toggleSidebarPage(route, visible) {
    const cur = new Set(Store.getHiddenSidebarPages());
    if (visible) cur.delete(route); else cur.add(route);
    Store.setHiddenSidebarPages([...cur]);
    applySidebarVisibility();
    render();
  }

  function showAllSidebarPages() {
    Store.setHiddenSidebarPages([]);
    applySidebarVisibility();
    render();
    _flash('Všechny stránky znovu zobrazeny');
  }

  /** Hide/show sidebar `<li>` entries based on the current
   *  `hiddenSidebarPages` setting. Also collapses a section heading
   *  + its `<ul>` when every page in that group is hidden, so the
   *  sidebar doesn't show empty sections. Safe to call repeatedly;
   *  the static markup in index.html doesn't change. */
  function applySidebarVisibility() {
    const hidden = new Set(Store.getHiddenSidebarPages());
    const lists = document.querySelectorAll('.sidebar .sidebar-nav');
    lists.forEach(ul => {
      const links = [...ul.querySelectorAll('a[data-route]')];
      let visibleCount = 0;
      for (const a of links) {
        const r  = a.getAttribute('data-route');
        const li = a.closest('li');
        const isHidden = hidden.has(r);
        if (li) li.style.display = isHidden ? 'none' : '';
        if (!isHidden) visibleCount++;
      }
      if (!links.length) return;
      const allHidden = visibleCount === 0;
      ul.style.display = allHidden ? 'none' : '';
      // Hide the preceding section heading or subsection toggle so
      // the sidebar doesn't show a label with no content under it.
      const prev = ul.previousElementSibling;
      if (prev && (prev.classList.contains('sidebar-section') ||
                   prev.classList.contains('sidebar-subsection'))) {
        prev.style.display = allHidden ? 'none' : '';
      }
    });
  }

  // ── World-map panel ──────────────────────────────────────────
  function _worldmapHtml() {
    const current = '/maps/swordcoast/sword_coast.jpg';
    return `
      <div class="settings-editor-head">
        <h2>🗺 Mapa světa</h2>
      </div>
      <div class="settings-panel">
        <p class="settings-hint" style="margin-bottom:1rem">
          Nahraj nový obrázek hlavní mapy. Uloží se jako
          <code>${esc(current)}</code> a server automaticky přegeneruje
          dlaždice (tile pyramid) pro plynulé zoomování.
        </p>
        <div class="settings-worldmap-preview">
          <img src="${esc(current)}?v=${Date.now()}" alt=""
               ${dataOn('error', 'hide', '$el')}>
        </div>
        <label class="inline-create-btn" style="cursor:pointer;display:inline-block;margin-top:0.8rem">
          📂 Vybrat soubor…
          <input type="file" accept="image/*" style="display:none"
                 ${dataOn('change', 'Settings.uploadWorldMap', '$el')}>
        </label>
        <span class="settings-hint" style="margin-left:0.8rem">
          Max 40 MB. Doporučený formát JPG/PNG/WebP, min. šířka 2000 px.
        </span>
      </div>`;
  }

  function uploadWorldMap(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('worldmap', file);
    _flash('Nahrávám…');
    fetch('/api/worldmap', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(() => {
        // A legacy localStorage override would still beat the new server
        // file in WorldMap._getImgUrl, so drop it after a successful
        // upload — the server copy is now the canonical image.
        try { localStorage.removeItem('world_map_image_url'); } catch (_) {}
        _flash('Mapa nahrána — přegenerovávám dlaždice na pozadí…');
        render();
      })
      .catch(e => _flash(e?.error || 'Nahrávání selhalo', false))
      .finally(() => { if (input) input.value = ''; });
  }

  // ── Backup / Snapshot panel ──────────────────────────────────
  function _backupHtml() {
    const rows = _snapshots.length ? _snapshots.map(_snapshotRow).join('') : `
      <div class="settings-empty">Zatím žádné body zálohy.</div>`;
    return `
      <div class="settings-editor-head">
        <h2>💾 Záloha</h2>
        <div class="settings-editor-actions">
          <a class="inline-create-btn" href="/api/backup"
             title="Stáhne ZIP celé složky data/">📥 Stáhnout ZIP</a>
          <label class="inline-create-btn" style="cursor:pointer"
             title="Nahraj ZIP ze Stáhnout ZIP nebo JSON exportu pro úplnou obnovu dat">
            📤 Obnovit ze zálohy…
            <input type="file" accept=".zip,.json,application/zip,application/json"
                   style="display:none"
                   ${dataOn('change', 'Settings.uploadRestore', '$el')}>
          </label>
          <button type="button" class="inline-create-btn"
                  ${dataAction('Settings.createSnapshot')}>＋ Vytvořit bod zálohy</button>
          <button type="button" class="inline-create-btn"
                  ${dataAction('Settings.refreshSnapshots')}>↻ Obnovit</button>
        </div>
      </div>
      <div class="settings-panel">
        <p class="settings-hint" style="margin-bottom:0.8rem">
          Server automaticky vytvoří bod zálohy při každé úpravě
          (sdružuje změny do 60 s). Udržuje posledních 50 bodů plus
          jeden denní po dobu 14 dnů. Obnovit můžeš libovolný bod níže
          nebo nahrát celý ZIP / JSON přes <em>Obnovit ze zálohy…</em>
          výše — před nahrazením se vždy vytvoří bezpečnostní bod.
        </p>
        <div class="settings-revert-row">
          <label class="settings-field" style="margin-right:0.6rem">
            <span class="settings-field-label">Vrátit poslední X úprav</span>
            <input class="edit-input" type="number" min="1" max="50"
                   value="1" id="settings-revert-n" style="width:5rem">
          </label>
          <button type="button" class="edit-delete-btn"
                  ${dataAction('Settings.revertLastN')}>↶ Vrátit</button>
        </div>
        <div class="settings-snapshots">${rows}</div>
      </div>`;
  }

  function _snapshotRow(s) {
    const when = _formatSnapshotDate(s.createdAt);
    const kb   = Math.max(1, Math.round((s.size || 0) / 1024));
    const tag  = s.reason === 'manual' ? '✦ ruční' :
                 s.reason === 'pre-restore' ? '⚠ před obnovou' : '✎ úprava';
    return `
      <div class="settings-row">
        <span class="settings-row-icon">🕒</span>
        <span class="settings-row-label">${esc(when)}</span>
        <code class="settings-row-id">${esc(tag)}</code>
        <span class="settings-row-usage" title="Velikost">${kb} kB</span>
        <div class="settings-row-actions">
          <button type="button" class="settings-btn-edit"
                  title="Obnovit tento stav"
                  ${dataAction('Settings.restoreSnapshot', s.id)}>↶</button>
          <button type="button" class="settings-btn-del"
                  title="Smazat bod zálohy"
                  ${dataAction('Settings.deleteSnapshot', s.id)}>🗑</button>
        </div>
      </div>`;
  }

  function _formatSnapshotDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString('cs-CZ', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch { return String(iso || ''); }
  }

  function _loadSnapshots() {
    return fetch('/api/snapshots', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : { snapshots: [] })
      .then(j => { _snapshots = j.snapshots || []; })
      .catch(() => { _snapshots = []; });
  }

  function refreshSnapshots() {
    _loadSnapshots().then(render);
  }

  function createSnapshot() {
    _flash('Vytvářím bod zálohy…');
    fetch('/api/snapshots', { method: 'POST', credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(() => _loadSnapshots().then(render).then(() => _flash('Bod zálohy vytvořen ✓')))
      .catch(() => _flash('Vytvoření bodu zálohy selhalo', false));
  }

  function restoreSnapshot(id) {
    const s = _snapshots.find(x => x.id === id);
    const when = s ? _formatSnapshotDate(s.createdAt) : id;
    if (!confirm(`Obnovit stav z ${when}? Aktuální data budou přepsána, ale před obnovou se automaticky vytvoří bezpečnostní bod zálohy.`)) return;
    _flash('Obnovuji…');
    fetch(`/api/snapshots/${encodeURIComponent(id)}/restore`, {
      method: 'POST', credentials: 'same-origin',
    })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(() => {
        _flash('Obnoveno ✓');
        // Force the client to reload fresh data; SSE should fire too,
        // but re-fetch to be certain the new state is in the tab.
        Store.load().then(() => _loadSnapshots().then(render));
      })
      .catch(() => _flash('Obnova selhala', false));
  }

  function deleteSnapshot(id) {
    const s = _snapshots.find(x => x.id === id);
    const when = s ? _formatSnapshotDate(s.createdAt) : id;
    if (!confirm(`Smazat bod zálohy z ${when}?`)) return;
    fetch(`/api/snapshots/${encodeURIComponent(id)}`, {
      method: 'DELETE', credentials: 'same-origin',
    })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(() => _loadSnapshots().then(render).then(() => _flash('Smazáno')))
      .catch(() => _flash('Smazání selhalo', false));
  }

  function revertLastN() {
    const input = document.getElementById('settings-revert-n');
    const n = Math.max(1, Math.min(50, Number(input?.value) || 1));
    if (!confirm(`Vrátit posledních ${n} úprav? Před obnovou se automaticky vytvoří bezpečnostní bod zálohy.`)) return;
    _flash(`Vracím posledních ${n} úprav…`);
    fetch(`/api/snapshots/revert-last/${n}`, {
      method: 'POST', credentials: 'same-origin',
    })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(() => {
        _flash('Obnoveno ✓');
        Store.load().then(() => _loadSnapshots().then(render));
      })
      .catch(e => _flash(e?.error || 'Vrácení změn selhalo', false));
  }

  // Restore from an uploaded ZIP (full data/ tree from /api/backup)
  // or a JSON document in the shape Store.exportJSON() produces.
  // The server takes a pre-restore snapshot internally so the user
  // can roll back even if they pick the wrong file.
  function uploadRestore(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!confirm(`Obnovit data ze souboru "${file.name}"?\n\nAktuální data budou přepsána. Před obnovou se automaticky vytvoří bezpečnostní bod zálohy, takže akci lze vrátit zpět.`)) {
      input.value = '';
      return;
    }
    const fd = new FormData();
    fd.append('backup', file);
    _flash('Nahrávám a obnovuji…');
    fetch('/api/restore', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(j => {
        const fmt = j.format === 'zip' ? 'ZIP' : 'JSON';
        _flash(`Obnoveno z ${fmt} (${j.restored} souborů) ✓`);
        // Refresh local store + snapshot list to reflect the new state.
        Store.load().then(() => _loadSnapshots().then(render));
      })
      .catch(e => _flash(e?.error || 'Obnova selhala', false))
      .finally(() => { if (input) input.value = ''; });
  }

  // ── Delete-with-usage modal ──────────────────────────────────
  function _openDeleteModal(id, item, usages) {
    const cat = _activeCat;
    const others = Store.getEnum(cat).filter(x => x.id !== id);
    const usageLinks = usages.slice(0, 20).map(u => `
      <li><a href="#/${_routeForCollection(u.collection)}/${u.id}">${esc(u.name)}</a></li>`).join('');
    const overflow = usages.length > 20 ? `<li>…a dalších ${usages.length - 20}</li>` : '';

    let root = document.getElementById('settings-del-modal');
    if (root) root.remove();
    root = document.createElement('div');
    root.id = 'settings-del-modal';
    root.className = 'settings-modal';
    root.innerHTML = `
      <div class="settings-modal-backdrop" data-dismiss></div>
      <div class="settings-modal-panel" role="dialog" aria-modal="true">
        <div class="settings-modal-title">Smazat "${esc(item?.label || id)}"?</div>
        <div class="settings-modal-body">
          <p>Tento záznam je používán <strong>${usages.length}×</strong>:</p>
          <ul class="settings-modal-usages">${usageLinks}${overflow}</ul>
          <div class="settings-modal-choice">
            <label class="settings-field">
              <span class="settings-field-label">Nahradit za…</span>
              <select class="edit-select" id="sdm-replace">
                <option value="">— nevybráno —</option>
                ${others.map(o => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}
              </select>
            </label>
          </div>
        </div>
        <div class="settings-modal-actions">
          <button type="button" class="edit-save-btn"
            ${dataAction('Settings.commitDelete', id, 'replace')}>Nahradit &amp; smazat</button>
          <button type="button" class="edit-delete-btn"
            ${dataAction('Settings.commitDelete', id, 'force')}>Smazat i tak</button>
          <button type="button" class="inline-create-btn"
            ${dataAction('Settings.closeModal')}>Zrušit</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('.settings-modal-backdrop')
        .addEventListener('click', () => root.remove());
  }

  function commitDelete(id, mode) {
    if (mode === 'replace') {
      const replaceWith = document.getElementById('sdm-replace')?.value || '';
      if (!replaceWith) { _flash('Vyber, za co nahradit', false); return; }
      const res = Store.deleteEnumItem(_activeCat, id, { replaceWith });
      closeModal();
      render();
      _flash(`Nahrazeno v ${res.usages.length} záznamech a smazáno`);
    } else if (mode === 'force') {
      const res = Store.deleteEnumItem(_activeCat, id, { force: true });
      closeModal();
      render();
      _flash(`Smazáno (${res.usages.length} odkazů zůstalo jako siroty)`);
    }
  }

  function closeModal() {
    document.getElementById('settings-del-modal')?.remove();
  }

  // ── Helpers ──────────────────────────────────────────────────
  function _slug(s) {
    return String(s).toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40) || 'e';
  }

  function _routeForCollection(c) {
    return ({
      characters:'postava', locations:'misto', events:'udalost',
      mysteries:'zahada', artifacts:'artefakt',
      relationships:'postava',  // rels don't have their own page
    })[c] || c;
  }

  // Route notifications through EditMode's toast (same visual style
   // as save/delete feedback across the rest of the app).
  function _flash(msg, ok = true) {
    if (typeof EditMode.toast === 'function') {
      EditMode.toast(msg, ok);
    } else {
      console.log('[settings]', msg);
    }
  }

  return {
    render,
    selectCategory, startNew, startEdit, cancelEdit,
    commit, requestDelete, commitDelete, closeModal,
    resetDefaults,
    uploadWorldMap,
    renameMapView, deleteMapView,
    toggleSidebarPage, showAllSidebarPages, applySidebarVisibility,
    refreshSnapshots, createSnapshot, restoreSnapshot,
    deleteSnapshot, revertLastN, uploadRestore,
    toggleIconPanel, setIconStrategy, setIconState,
    uploadIconFiles, deleteIconFile,
  };
})();
