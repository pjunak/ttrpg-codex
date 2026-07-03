// ═══════════════════════════════════════════════════════════════
//  SETTINGS PAGE — user-editable enums at /nastaveni.
//  Left column lists categories, right column edits the selected
//  one. Delete-with-usage shows a modal that lets the GM choose
//  between replace-with, force-delete, or cancel. Orphan references
//  are handled gracefully by resolveEnum() in consumers.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { EditMode } from './editmode.js';
import { WorldMap, PIN_TYPES } from './map.js';
import { Role } from './role.js';
import { esc, dataAction, dataOn } from './utils.js';
import { Sidebar } from './sidebar.js';
import { Addons } from './addons.js';
import { THEMES } from './constants.js';
import { I18n } from './i18n.js';

export const Settings = (() => {

  // Shape of each category: which fields to expose in the editor form.
  // `size` is only meaningful for pinTypes (default px size for new
  // places of that type). `icon` / `color` are shown as side-by-side
  // inputs when declared.
  const CATEGORIES = [
    { id: 'relationshipTypes', labelKey: 'settings.catRelationshipTypes', icon: '🔗',
      fields: ['label', 'color', 'style'] },
    { id: 'genders',           labelKey: 'settings.catGenders',           icon: '⚥',
      fields: ['label'] },
    // pinTypes: the emoji `icon` and `color` fields are deprecated
    // (color was never read by the renderer; the emoji is only a
    // last-resort fallback when no SVG resolves). The editable
    // fields are now: label, defaultIconId (pick from bundled SVGs),
    // size. Per-pin-type custom uploads live in the 🎨 panel.
    { id: 'pinTypes',          labelKey: 'settings.catPinTypes',          icon: '📍',
      fields: ['label', 'defaultIconId', 'size'] },
    { id: 'characterStatuses', labelKey: 'settings.catCharacterStatuses', icon: '●',
      fields: ['label', 'icon', 'color'] },
    { id: 'eventPriorities',   labelKey: 'settings.catEventPriorities',   icon: '⚑',
      fields: ['label', 'color'] },
    // "Postoje k partě" — unified palette used on character / location /
    // faction glows. The intensity (`strength`) lives on each entity's
    // attitude entry, NOT on the enum item, so this editor only manages
    // colours + label. `bg` drives map-pin fill, `fg` is the icon contrast
    // on the pin, `labelColor` is the readable colour on dark UI (chip
    // text, glow, legend).
    { id: 'attitudes',         labelKey: 'settings.catAttitudes',         icon: '🤝',
      fields: ['label', 'bg', 'fg', 'labelColor', 'strength'] },
  ];

  // Non-enum tabs live alongside the category tabs. They render custom
  // panels (world-map upload, map-view presets, backup tools) instead
  // of the enum editor.
  // Branding lives INSIDE the appearance tab and map views INSIDE the Mapy
  // tab (per-map) — they used to be tabs of their own; `_editorHtml` coerces
  // the stale ids for any session that still points at them.
  const SPECIAL_TABS = [
    { id: 'appearance',   labelKey: 'settings.tabAppearance',   icon: '🎨' },
    { id: 'playerParty',  labelKey: 'settings.tabPlayerParty',  icon: '🛡' },
    { id: 'worldmap',     labelKey: 'settings.tabMaps',         icon: '🗺' },
    { id: 'sidebarPages', labelKey: 'settings.tabSidebar',      icon: '🧭' },
    { id: 'addons',       labelKey: 'settings.tabAddons',       icon: '🧩' },
    { id: 'backup',       labelKey: 'settings.tabBackup',       icon: '💾' },
    // The account tab doubles as the SERVER tab (label "Server"): role chip +
    // login/logout + view-as + DM password rotation + the restart button.
    { id: 'account',      labelKey: 'settings.tabAccount',      icon: '🖥' },
  ];

  let _activeCat       = CATEGORIES[0].id;
  // True once the user has explicitly picked a tab. Before that, the
  // landing tab is role-aware: non-DM viewers default to "Účet" (most
  // useful tab for them — role chip + logout + backup access via the
  // Záloha tab); DMs default to the first enum editor (their common
  // workflow). Once a tab is picked, the selection sticks for the
  // remainder of the session.
  let _tabPickedByUser = false;
  let _editingId       = null;  // id being edited inline, or '__new__' for add form
  let _snapshots       = [];    // populated by _loadSnapshots()
  // pinTypeId whose marker-icon panel is currently expanded. Only one at
  // a time — opening another collapses the previous so the layout stays
  // tidy when there are many pin types.
  let _iconPanelOpenFor = null;
  // Currently-selected map in the "Mapy" tab. 'world' = main map;
  // for sub-maps the id is `local-${locationId}` so it lines up
  // with `_currentMapId` in map.js and the keys used in
  // `settings.mapConfigs`.
  let _activeMapId = 'world';
  // Cache-bust token applied to map preview <img> URLs. Stays stable
  // across renders so the browser caches the image normally — bumped
  // ONLY when an upload actually replaces a file (and once on first
  // mount, so a stale CDN copy from a prior session doesn't linger).
  // A naive `?v=${Date.now()}` per render would generate a new URL on
  // every redraw, forcing constant refetches and visible flicker on
  // any SSE-triggered re-render.
  const _previewBust = {};   // mapId → token
  function _previewBustFor(mapId) {
    if (!_previewBust[mapId]) _previewBust[mapId] = String(Date.now());
    return _previewBust[mapId];
  }
  function _bumpPreviewBust(mapId) {
    _previewBust[mapId] = String(Date.now());
  }

  // ── Render ───────────────────────────────────────────────────

  /**
   * Render the Settings page into `#main-content`. Wired into
   * `app.js`'s router for the `/nastaveni` route. Clears scroll so
   * users see the tab list first instead of mid-page state from the
   * previous route.
   */
  function render() {
    const el = document.getElementById('main-content');
    if (!el) return;
    // Role-aware default tab. Non-DM viewers land on Účet (logout +
    // role chip + access to the Záloha tab); DMs land on the first
    // enum editor as before. Sticky once the user picks a tab.
    if (!_tabPickedByUser && !Role.isDM()) {
      _activeCat = 'account';
    }
    el.innerHTML = _pageHtml();
    el.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  // Role-aware tab visibility. For DM viewers, all tabs are shown
  // (enum editors + every SPECIAL tab). For non-DM viewers (player or
  // DM-in-player-view) we hide the tabs whose actions are DM-only,
  // surfacing only Account + Záloha — the user's stated request was
  // "non-DM users need access to logout and backups", and the rest of
  // the tabs only edit DM-owned shared state.
  function _visibleEnumTabs() {
    return Role.isDM() ? CATEGORIES : [];
  }
  function _visibleSpecialTabs() {
    const addonTabs = (() => { try { return Addons.settingsTabs(); } catch { return []; } })()
      .filter(t => Role.isDM() || t.role !== 'dm');
    const base = Role.isDM() ? SPECIAL_TABS : SPECIAL_TABS.filter(t => t.id === 'account' || t.id === 'backup');
    return [...base, ...addonTabs];
  }

  // Resolve a tab's display label. Built-in tabs (CATEGORIES /
  // SPECIAL_TABS) carry a `labelKey` resolved through I18n; addon-
  // provided settings tabs come from Addons with a literal `.label`
  // (content the addon owns), so fall back to that.
  function _tabLabel(t) {
    return t.labelKey ? I18n.t(t.labelKey) : (t.label || t.id);
  }

  function _pageHtml() {
    // Defensive: if `_activeCat` references a tab that's been hidden
    // by the current role (e.g. DM exits to player view while the
    // enum editor is open), fall back to Account so the page renders
    // something useful instead of an empty editor pane.
    const visibleIds = new Set([
      ..._visibleEnumTabs().map(c => c.id),
      ..._visibleSpecialTabs().map(t => t.id),
    ]);
    if (!visibleIds.has(_activeCat)) _activeCat = 'account';

    const enumTabs = _visibleEnumTabs().map(c => `
      <button type="button" class="settings-tab ${c.id===_activeCat?'is-active':''}"
        ${dataAction('Settings.selectCategory', c.id)}>
        <span class="settings-tab-icon">${c.icon}</span>
        <span class="settings-tab-label">${esc(_tabLabel(c))}</span>
        <span class="settings-tab-count">${Store.getEnum(c.id).length}</span>
      </button>`).join('');
    const specialTabs = _visibleSpecialTabs().map(t => `
      <button type="button" class="settings-tab ${t.id===_activeCat?'is-active':''}"
        ${dataAction('Settings.selectCategory', t.id)}>
        <span class="settings-tab-icon">${t.icon}</span>
        <span class="settings-tab-label">${esc(_tabLabel(t))}</span>
      </button>`).join('');
    // Separator between enum tabs and special tabs renders only when
    // both groups are non-empty (DM viewers). Non-DM viewers see just
    // Account + Záloha, so the separator would be a stray line.
    const tabsSep = (enumTabs && specialTabs) ? `<div class="settings-tabs-sep"></div>` : '';
    return `
      <div class="settings-page">
        <div class="page-header"><h1>⚙ ${esc(I18n.t('settings.pageTitle'))}</h1>
          <div class="subtitle">${esc(Role.isDM() ? I18n.t('settings.subtitleDM') : I18n.t('settings.subtitlePlayer'))}</div>
        </div>
        <div class="settings-shell">
          <nav class="settings-tabs">
            ${enumTabs}
            ${tabsSep}
            ${specialTabs}
          </nav>
          <section class="settings-editor">${_editorHtml()}</section>
        </div>
      </div>`;
  }

  function _editorHtml() {
    // Retired tab ids (their panels merged elsewhere) — coerce a stale pick.
    if (_activeCat === 'mapViews') _activeCat = 'worldmap';
    if (_activeCat === 'branding') _activeCat = 'appearance';
    if (_activeCat === 'worldmap')     return _worldmapHtml();
    if (_activeCat === 'sidebarPages') return Sidebar.renderEditor();
    if (_activeCat === 'backup')       return _backupHtml();
    if (_activeCat === 'account')      return _accountHtml();
    if (_activeCat === 'appearance')   return _appearanceHtml();
    if (_activeCat === 'addons')       return _addonsHtml();
    if (_activeCat === 'playerParty')  return _playerPartyHtml();
    const _at = Addons.settingsTab(_activeCat);
    if (_at) { try { return _at.render(); } catch (e) { return `<div class="settings-panel" style="color:var(--color-danger)">${esc(I18n.t('settings.addonFailed'))}: ${esc(e.message)}</div>`; } }
    const cat = CATEGORIES.find(c => c.id === _activeCat);
    const items = Store.getEnum(_activeCat);
    const rows = items.map(it => _rowHtml(cat, it)).join('');
    const addForm = _editingId === '__new__'
      ? _formHtml(cat, { id:'', label:'', color:'#888', icon:'', size:28, style:'solid' }, true)
      : '';
    return `
      <div class="settings-editor-head">
        <h2>${cat.icon} ${esc(_tabLabel(cat))}</h2>
        <div class="settings-editor-actions">
          <button type="button" class="inline-create-btn"
            ${dataAction('Settings.startNew')}>＋ ${esc(I18n.t('action.add'))}</button>
          <button type="button" class="inline-create-btn"
            title="${esc(I18n.t('settings.resetDefaultsTitle'))}"
            ${dataAction('Settings.resetDefaults')}>↺ ${esc(I18n.t('settings.resetDefaults'))}</button>
        </div>
      </div>
      ${addForm}
      <div class="settings-rows">
        ${rows || `<div class="settings-empty">${esc(I18n.t('settings.categoryEmpty'))}</div>`}
      </div>
      <p class="settings-hint">
        ${esc(I18n.t('settings.deleteUsageHint'))}
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
            title="${esc(I18n.t('settings.customIconsTitle'))}"
            ${dataAction('Settings.toggleIconPanel', item.id)}>🎨</button>`
      : '';
    // For pinTypes rows, prefer a real artwork preview (uploaded files
    // → user-picked defaultIconId → per-id bundled default → emoji
    // fallback) so the row shows the same artwork the map renders.
    // All other categories keep the emoji/character glyph the GM
    // typed in.
    const rowIconHtml = (() => {
      if (cat.id === 'pinTypes') {
        const cfg = item.iconConfig;
        let url = null;
        if (cfg && Array.isArray(cfg.files) && cfg.files.length && cfg.files[0].url) {
          url = cfg.files[0].url;
        }
        if (!url && item.defaultIconId) url = WorldMap.bundledDefaultUrl(item.defaultIconId);
        if (!url) url = WorldMap.bundledDefaultUrl(item.id);
        if (url) return `<img class="settings-row-icon-img" src="${esc(url)}" alt="" ${dataOn('error', 'hide', '$el')}>`;
      }
      return `<span class="settings-row-icon">${esc(item.icon || item.label?.[0] || '·')}</span>`;
    })();
    // ID is intentionally hidden from existing rows — it's auto-generated
    // from the name at creation time and never editable. Showing it added
    // visual clutter without offering an action. The new-row form (see
    // _formHtml) still surfaces it as an optional override.
    const row = `
      <div class="settings-row">
        ${rowIconHtml}
        <span class="settings-row-label">${esc(item.label || item.id)}</span>
        ${swatch}
        <span class="settings-row-usage" title="${esc(I18n.t('settings.usageTitle'))}">${usageCount > 0 ? usageCount + '×' : '–'}</span>
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
  // Per-pinType editor for the optional `iconConfig` field. Lets the
  // GM upload variants (svg/png/jpeg/webp) and choose a strategy
  // (single / random). `single` uses the first file; `random` picks
  // deterministically per pin. All operations auto-persist — uploads
  // write the file AND save the iconConfig record in one logical save.
  function _iconPanelHtml(pinType) {
    const cfg = pinType.iconConfig || { strategy: 'single', files: [] };
    const strategy = cfg.strategy || 'single';
    const files    = Array.isArray(cfg.files) ? cfg.files : [];

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

    const fileRows = files.map(f => `
      <div class="mit-file-row">
        <div class="mit-thumb">
          <img src="${esc(f.url)}" alt="" ${dataOn('error', 'hide', '$el')}>
        </div>
        <code class="mit-file-name">${esc(f.id)}</code>
        <button type="button" class="settings-btn-del"
          title="${esc(I18n.t('settings.deleteFileTitle'))}"
          ${dataAction('Settings.deleteIconFile', pinType.id, f.id)}>🗑</button>
      </div>`).join('');

    // No user-uploaded files: surface the bundled game-icons default
    // when one exists for this pin type so the GM sees what's actually
    // rendering, plus a hint that uploading replaces it. Pin types
    // created by the GM (no bundled default) get the original
    // "no files / falls back to emoji" message instead.
    const bundledUrl = WorldMap.bundledDefaultUrl(pinType.id);
    const empty = files.length ? '' : (bundledUrl ? `
      <div class="mit-bundled-default" title="${esc(I18n.t('settings.bundledIconTitle'))}">
        <div class="mit-thumb"><img src="${esc(bundledUrl)}" alt=""></div>
        <div class="mit-bundled-default-text">
          <strong>${esc(I18n.t('settings.bundledIcon'))}</strong>
          <span class="settings-hint">${esc(I18n.t('settings.bundledIconHint'))}</span>
        </div>
      </div>` : `
      <div class="settings-empty" style="margin:0.5rem 0">
        ${esc(I18n.t('settings.noIconFiles'))}
      </div>`);

    return `
      <div class="mit-panel" id="mit-panel-${esc(pinType.id)}">
        <div class="mit-strategy-row">
          ${radio('single', I18n.t('settings.strategySingle'),  I18n.t('settings.strategySingleHint'))}
          ${radio('random', I18n.t('settings.strategyRandom'),  I18n.t('settings.strategyRandomHint'))}
        </div>
        ${empty}
        <div class="mit-files">${fileRows}</div>
        <div class="mit-uploader">
          <label class="inline-create-btn" style="cursor:pointer;display:inline-block">
            📤 ${esc(I18n.t('settings.uploadFiles'))}
            <input type="file" multiple accept=".svg,.png,.jpg,.jpeg,.webp,image/svg+xml,image/png,image/jpeg,image/webp"
              style="display:none"
              ${dataOn('change', 'Settings.uploadIconFiles', pinType.id, '$el')}>
          </label>
          <span class="settings-hint">${esc(I18n.t('settings.iconUploadHint'))}</span>
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

  function uploadIconFiles(pinTypeId, input) {
    const pt = _getPinType(pinTypeId);
    if (!pt) return;
    const files = input?.files;
    if (!files || !files.length) return;
    _flash(I18n.t('settings.uploading'));
    Store.uploadIcons(pinTypeId, files)
      .then(j => {
        const cfg = _ensureIconConfig(pt);
        for (const f of (j.files || [])) {
          // Skip duplicates by id (server returns the canonical name
          // including any -2/-3 collision suffix, so this is rare).
          if (cfg.files.some(x => x.id === f.id)) continue;
          cfg.files.push({ id: f.id, url: f.url });
        }
        Store.saveEnumItem('pinTypes', pt);
        render();
        _flash(I18n.t('settings.uploaded'));
      })
      .catch(e => _flash(e?.message || I18n.t('settings.uploadFailed'), false))
      .finally(() => { if (input) input.value = ''; });
  }

  function deleteIconFile(pinTypeId, fileId) {
    const pt = _getPinType(pinTypeId);
    if (!pt) return;
    if (!confirm(I18n.t('settings.deleteFileQ', { name: fileId }))) return;
    Store.deleteIcon(pinTypeId, fileId).then(ok => {
      if (!ok) { _flash(I18n.t('settings.deleteFailed'), false); return; }
      const cfg = _ensureIconConfig(pt);
      cfg.files = cfg.files.filter(x => x.id !== fileId);
      Store.saveEnumItem('pinTypes', pt);
      render();
      _flash(I18n.t('settings.deleted'));
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
        <span class="settings-field-label">${esc(I18n.t('settings.lineStyle'))}</span>
        <select class="edit-select" id="sf-${uid}-style">
          ${['solid','dashed','dotted'].map(s =>
            `<option value="${s}" ${item.style===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </label>`;
    const sizeField = () => `
      <label class="settings-field">
        <span class="settings-field-label">${esc(I18n.t('settings.defaultSizePx'))}</span>
        <input class="edit-input" type="number" id="sf-${uid}-size"
          min="14" max="64" step="2"
          value="${Number(item.size) || 28}">
      </label>`;
    // Default-icon picker — bundled SVG markers from the game-icons
    // pack. Lets the GM pick an icon for user-created pin types
    // (which otherwise have no bundled fallback and fall through to
    // an emoji). For seed pin types, picking here OVERRIDES the
    // per-id bundled default; leave empty to keep the original.
    const defaultIconField = () => {
      const ids = (WorldMap.getBundledDefaultIconIds && WorldMap.getBundledDefaultIconIds()) || [];
      const current = item.defaultIconId || '';
      const opts = [`<option value="">${esc(I18n.t('settings.defaultForType'))}</option>`,
        ...ids.map(id => {
          const label = (PIN_TYPES[id] && PIN_TYPES[id].label) || id;
          return `<option value="${esc(id)}" ${id===current?'selected':''}>${esc(label)}</option>`;
        })].join('');
      const previewUrl = current
        ? WorldMap.bundledDefaultUrl(current)
        : (WorldMap.bundledDefaultUrl(item.id) || '');
      const previewHtml = previewUrl
        ? `<img src="${esc(previewUrl)}" alt="" style="width:32px;height:32px;object-fit:contain;background:rgba(0,0,0,0.55);border-radius:4px;padding:2px" ${dataOn('error', 'hide', '$el')}>`
        : `<span class="settings-hint" style="align-self:center">${esc(I18n.t('settings.emojiFallback'))}</span>`;
      return `
        <label class="settings-field">
          <span class="settings-field-label">${esc(I18n.t('settings.fieldIcon'))}</span>
          <div style="display:flex;gap:0.5rem;align-items:center">
            ${previewHtml}
            <select class="edit-select" id="sf-${uid}-defaultIconId" style="flex:1"
              ${dataOn('change', 'Settings.previewDefaultIcon', uid, '$value')}>${opts}</select>
          </div>
        </label>`;
    };
    // Glow intensity for this attitude — moved off the entity onto
    // the enum item so editing here updates every glow at once.
    // Range 0..1, percent readout next to the slider.
    const strengthField = () => {
      const cur = (typeof item.strength === 'number') ? item.strength : 1.0;
      const pct = Math.round(cur * 100);
      return `
      <label class="settings-field">
        <span class="settings-field-label">${esc(I18n.t('settings.glowIntensity'))} <span class="settings-hint" style="font-weight:normal">${esc(I18n.t('settings.glowIntensityHint'))}</span></span>
        <div class="settings-strength-row">
          <input type="range" id="sf-${uid}-strength"
            min="0" max="1" step="0.05" value="${cur}"
            ${dataOn('input', 'Settings.updateStrengthReadout', '$el')}>
          <output id="sf-${uid}-strength-out">${pct}%</output>
        </div>
      </label>`;
    };

    const inputs = (cat.fields || []).map(name => {
      if (name === 'color' || name === 'bg' || name === 'fg' || name === 'labelColor') return colorField(name);
      if (name === 'style')                                                            return styleField();
      if (name === 'size')                                                             return sizeField();
      if (name === 'strength')                                                         return strengthField();
      if (name === 'defaultIconId')                                                    return defaultIconField();
      return field(name, name === 'icon' ? I18n.t('settings.emojiOrCharPh') : I18n.t('settings.textPh'));
    }).join('');

    return `
      <div class="settings-form">
        <div class="settings-form-row">
          ${isNew ? `
            <label class="settings-field">
              <span class="settings-field-label">${esc(I18n.t('settings.idFieldLabel'))}</span>
              <input class="edit-input" id="sf-${uid}-id" placeholder="${esc(I18n.t('settings.idFieldPh'))}">
            </label>` : ``}
          ${inputs}
        </div>
        <div class="settings-form-actions">
          <button type="button" class="edit-save-btn"
            ${dataAction('Settings.commit', uid, isNew)}>💾 ${esc(I18n.t('action.save'))}</button>
          <button type="button" class="inline-create-btn"
            ${dataAction('Settings.cancelEdit')}>${esc(I18n.t('action.cancel'))}</button>
        </div>
      </div>`;
  }

  function _fieldLabel(name) {
    return {
      label: I18n.t('settings.fieldName'),       icon: I18n.t('settings.fieldIcon'),
      color: I18n.t('settings.fieldColor'),      style: I18n.t('settings.fieldStyle'),
      size:  I18n.t('settings.fieldSize'),       strength: I18n.t('settings.glowIntensity'),
      bg:    I18n.t('settings.fieldBg'),         fg: I18n.t('settings.fieldFg'),
      labelColor: I18n.t('settings.fieldTextColor'),
      defaultIconId: I18n.t('settings.fieldIcon'),
    }[name] || name;
  }

  /** Live-update the icon preview next to the default-icon select.
   *  Walks up from the select to find the sibling preview, so a
   *  re-render of the form mid-interaction doesn't matter. */
  function previewDefaultIcon(uid, value) {
    const sel = document.getElementById(`sf-${uid}-defaultIconId`);
    if (!sel) return;
    const wrap = sel.parentElement;
    if (!wrap) return;
    const url = value ? WorldMap.bundledDefaultUrl(value) : '';
    let img = wrap.querySelector('img');
    if (url) {
      if (!img) {
        img = document.createElement('img');
        img.style.cssText = 'width:32px;height:32px;object-fit:contain;background:rgba(0,0,0,0.55);border-radius:4px;padding:2px';
        wrap.insertBefore(img, sel);
      }
      img.src = url;
    } else if (img) {
      img.remove();
    }
  }

  // ── Public commands (called from inline onclick handlers) ────
  /**
   * Switch the active settings tab. Re-renders the right pane in place
   * and lazy-loads the snapshot list when the Záloha tab is opened.
   *
   * @param {string} cat - Category id (`relationshipTypes` etc.) or a
   *                       SPECIAL_TABS id (`worldmap`, `backup`, …).
   */
  function selectCategory(cat) {
    _activeCat = cat;
    _tabPickedByUser = true;   // honour the user's explicit choice on subsequent renders
    _editingId = null;
    if (cat === 'backup') {
      // Fetch snapshot list before rendering so the table isn't empty
      // for a frame. Render once on entry (while pending), then again
      // when the list arrives.
      render();
      _loadSnapshots().then(render);
    } else if (cat === 'account') {
      // Password status is DM-only; for non-DM viewers the panel
      // skips the form entirely so the fetch is a wasted round-trip
      // but harmless (server returns 403, we just don't render forms).
      _passwordStatus = null;
      render();
      if (Role.getReal() === 'dm') _loadPasswordStatus().then(render);
    } else if (cat === 'addons') {
      _addonsList = null;        // show "loading" until /api/addons resolves
      render();
      _loadAddons().then(render);
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

  /** Live percent readout next to the attitude strength slider in
   *  the Postoje k partě editor. Wired via `dataOn('input', ...)`
   *  on the slider so the `<output>` updates as the user drags. */
  function updateStrengthReadout(rangeEl) {
    if (!rangeEl) return;
    const out = rangeEl.parentElement?.querySelector('output');
    if (!out) return;
    const v = parseFloat(rangeEl.value);
    out.textContent = `${Math.round((isFinite(v) ? v : 0) * 100)}%`;
  }

  function commit(uid, isNew) {
    const cat = CATEGORIES.find(c => c.id === _activeCat);
    const getVal = (name) => {
      const el = document.getElementById(`sf-${uid}-${name}`);
      return el ? el.value : '';
    };
    const existing = isNew ? null : Store.getEnum(_activeCat).find(x => x.id === uid);
    const label = getVal('label').trim();
    if (!label) { _flash(I18n.t('settings.nameRequired'), false); return; }
    let id = isNew ? (getVal('id').trim() || _slug(label)) : uid;
    if (!id) id = _slug(label);
    if (isNew && Store.getEnum(_activeCat).some(x => x.id === id)) {
      _flash(I18n.t('settings.idExists', { id }), false);
      return;
    }
    const item = { ...(existing || {}), id, label };
    for (const f of cat.fields) {
      const v = getVal(f);
      if (f === 'strength') {
        // Range slider always has a value; default to 1.0 if missing.
        let n = (v === '' || v == null) ? 1.0 : Number(v);
        if (!isFinite(n)) n = 1.0;
        if (n < 0) n = 0;
        if (n > 1) n = 1;
        item[f] = n;
      } else if (f === 'defaultIconId') {
        // Empty select means "use per-type default"; clear the override.
        if (v) item[f] = v;
        else delete item[f];
      } else if (v !== '' && v != null) {
        item[f] = (f === 'size') ? Number(v) : v;
      }
    }
    Store.saveEnumItem(_activeCat, item);
    _editingId = null;
    render();
    _flash(isNew ? I18n.t('settings.itemCreated', { label }) : I18n.t('settings.itemUpdated', { label }));
  }

  function requestDelete(id) {
    const usages = Store.findEnumUsages(_activeCat, id);
    const item = Store.getEnum(_activeCat).find(x => x.id === id);
    if (!usages.length) {
      if (!confirm(I18n.t('settings.deleteItemQ', { name: item?.label || id }))) return;
      Store.deleteEnumItem(_activeCat, id);
      render();
      _flash(I18n.t('settings.deleted'));
      return;
    }
    _openDeleteModal(id, item, usages);
  }

  function resetDefaults() {
    Store.resetEnumCategory(_activeCat);
    render();
    _flash(I18n.t('settings.defaultsAdded'));
  }

  // ── Map-view presets panel ───────────────────────────────────
  // Presets are captured on the map itself via the ✚ toolbar button;
  // this panel only lists them and lets the GM rename or delete.
  // Entries are grouped by the map they belong to (world vs sub-map).
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
                  title="${esc(I18n.t('settings.renameOrIconTitle'))}"
                  ${dataAction('Settings.renameMapView', v.id)}>✏</button>
          <button type="button" class="settings-btn-del"
                  title="${esc(I18n.t('settings.deleteViewTitle'))}"
                  ${dataAction('Settings.deleteMapView', v.id)}>🗑</button>
        </div>
      </div>`;
  }

  function renameMapView(id) {
    const views = Store.getEnum('mapViews') || [];
    const v = views.find(x => x.id === id);
    if (!v) return;
    const label = prompt(I18n.t('settings.newViewNamePrompt'), v.label || '');
    if (label == null) return;
    const icon = prompt(I18n.t('settings.iconPrompt'), v.icon || '📍');
    if (icon == null) return;
    Store.saveEnumItem('mapViews', { ...v, label: label.trim() || v.label, icon: icon.trim() || v.icon });
    render();
    _flash(I18n.t('settings.viewUpdated'));
    // Mirror the change onto the live map toolbar if it's visible.
    try { WorldMap.refreshPresetButtons?.(); } catch (_) {}
  }

  function deleteMapView(id) {
    const views = Store.getEnum('mapViews') || [];
    const v = views.find(x => x.id === id);
    if (!v) return;
    if (!confirm(I18n.t('settings.deleteViewQ', { name: v.label || id }))) return;
    Store.deleteEnumItem('mapViews', id, { force: true });
    render();
    _flash(I18n.t('settings.viewDeleted'));
    try { WorldMap.refreshPresetButtons?.(); } catch (_) {}
  }

  // ── Sidebar layout ───────────────────────────────────────────
  // The whole left sidebar is now data-driven (see the Sidebar module).
  // The Postranní panel tab renders Sidebar's drag-drop layout editor
  // (`_editorHtml` delegates to `Sidebar.renderEditor`). This alias
  // keeps the old public name working for any external caller; the
  // live sidebar re-render is `Sidebar.render`.
  function applySidebarVisibility() { Sidebar.render(); }

  // ── Maps panel ───────────────────────────────────────────────
  // The "Mapy" tab covers both image upload AND per-map config
  // (zoom-scale ratio for now; future per-map knobs would go here).
  // Left side renders an explorer-style tree mirroring the location
  // hierarchy (world root + every location with a `localMap`,
  // nested under its nearest mapped ancestor). Right side shows
  // the selected map's preview / upload / settings.
  //
  // Locations without a `localMap` aren't in the tree — they appear
  // there only when a *descendant* has one, in which case they show
  // up as faint, non-clickable rungs so the lineage is still
  // visible.

  // Resolve a mapId ('world' or 'local-${locId}') to the same
  // shape the panel expects: { id, label, icon, isWorld, locationId,
  // imgUrl }. Returns the world map for unknown ids so the panel
  // never renders a broken state.
  function _findMap(mapId) {
    if (!mapId || mapId === 'world') {
      return {
        id: 'world',
        label: I18n.t('settings.worldMap'),
        icon: '🌐',
        isWorld: true,
        imgUrl: '/maps/swordcoast/sword_coast.jpg',
      };
    }
    if (typeof mapId === 'string' && mapId.startsWith('local-')) {
      const locId = mapId.slice('local-'.length);
      const loc = Store.getLocation(locId);
      if (loc) {
        return {
          id: mapId,
          label: loc.name || loc.id,
          icon: '🗺',
          isWorld: false,
          locationId: locId,
          imgUrl: loc.localMap || '',
        };
      }
    }
    return _findMap('world');
  }

  // Build the maps tree. Returns the world root with `children`
  // populated recursively. Each child is `{ id, label, icon,
  // locationId, imgUrl, children, ghosts }` where `ghosts` is the
  // optional list of intermediate ancestor names between this node
  // and its tree-parent (rendered as a faint breadcrumb so the
  // lineage stays readable when the user has, e.g., a localMap on
  // a great-grandchild but nothing in between).
  function _mapsTree() {
    const allLocs = Store.getLocations() || [];
    const byId    = new Map(allLocs.map(l => [l.id, l]));
    const mapped  = allLocs.filter(l => l && l.localMap);

    // Nearest ancestor with localMap, walking parentId. Returns
    // `{ ancestor, ghosts }` — `ancestor` is the location (or null
    // for the world root) and `ghosts` is the list of intermediate
    // location names skipped.
    function nearestMapped(loc) {
      const ghosts = [];
      const seen = new Set();
      let cur = loc;
      while (cur.parentId && !seen.has(cur.parentId)) {
        seen.add(cur.parentId);
        const parent = byId.get(cur.parentId);
        if (!parent) break;
        if (parent.localMap) return { ancestor: parent, ghosts };
        ghosts.unshift(parent.name || parent.id);
        cur = parent;
      }
      return { ancestor: null, ghosts };
    }

    // Group mapped locations by their tree-parent key.
    const childrenOf = new Map();   // key: 'world' | locId, value: [{loc, ghosts}]
    childrenOf.set('world', []);
    for (const loc of mapped) {
      const { ancestor, ghosts } = nearestMapped(loc);
      const key = ancestor ? ancestor.id : 'world';
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push({ loc, ghosts });
    }
    // Sort each level alphabetically (Czech collation) for a stable
    // visual order regardless of save order.
    for (const arr of childrenOf.values()) {
      arr.sort((a, b) => (a.loc.name || '').localeCompare(b.loc.name || '', 'cs'));
    }

    function buildNode(loc, ghosts) {
      return {
        id:         `local-${loc.id}`,
        label:      loc.name || loc.id,
        icon:       '🗺',
        locationId: loc.id,
        imgUrl:     loc.localMap,
        ghosts,
        children:   (childrenOf.get(loc.id) || []).map(({ loc: c, ghosts: g }) => buildNode(c, g)),
      };
    }

    return {
      id:       'world',
      label:    I18n.t('settings.worldMap'),
      icon:     '🌐',
      isWorld:  true,
      imgUrl:   '/maps/swordcoast/sword_coast.jpg',
      children: (childrenOf.get('world') || []).map(({ loc, ghosts }) => buildNode(loc, ghosts)),
    };
  }

  function _renderMapNode(node, depth, isLast) {
    const isActive = node.id === _activeMapId;
    const indent   = depth * 16;
    const ghostHtml = (node.ghosts && node.ghosts.length)
      ? `<span class="settings-map-node-ghost" title="${esc(I18n.t('settings.ancestorsNoMap'))}">${node.ghosts.map(esc).join(' › ')} ›</span>`
      : '';
    const guide = depth > 0
      ? `<span class="settings-map-node-guide">${isLast ? '└' : '├'}</span>`
      : '';
    const childRows = (node.children || []).map((c, i, arr) =>
      _renderMapNode(c, depth + 1, i === arr.length - 1)
    ).join('');
    return `
      <button type="button" class="settings-map-node ${isActive?'is-active':''}"
        style="padding-left:${indent + 10}px"
        ${dataAction('Settings.selectMap', node.id)}>
        ${guide}
        <span class="settings-map-node-icon">${node.icon}</span>
        ${ghostHtml}
        <span class="settings-map-node-label">${esc(node.label)}</span>
      </button>${childRows}`;
  }

  function _worldmapHtml() {
    const tree = _mapsTree();
    // If `_activeMapId` references a location that's been deleted or
    // un-mapped, fall back to the world root so the panel doesn't
    // render an empty state forever.
    const flatIds = (function flatten(n) {
      return [n.id, ...(n.children || []).flatMap(flatten)];
    })(tree);
    if (!flatIds.includes(_activeMapId)) _activeMapId = 'world';
    const current = _findMap(_activeMapId);

    const treeHtml = _renderMapNode(tree, 0, true);

    const cfg   = Store.getMapConfig(_activeMapId);
    const ratio = (typeof cfg.zoomScaleRatio === 'number') ? cfg.zoomScaleRatio : 0;
    const ratioPct = Math.round(ratio * 100);

    const uploadAction  = current.isWorld ? 'Settings.uploadWorldMap' : 'Settings.uploadSubMap';
    const uploadHint    = current.isWorld
      ? I18n.t('settings.uploadHintWorld', { path: '<code>/maps/swordcoast/sword_coast.&lt;ext&gt;</code>' })
      : I18n.t('settings.uploadHintLocal', { path: `<code>/maps/local/${esc(current.locationId)}/map.&lt;ext&gt;</code>` });
    const uploadDataset = current.isWorld ? '' : ` data-loc-id="${esc(current.locationId)}"`;

    const previewSrc  = current.imgUrl ? `${current.imgUrl}?v=${_previewBustFor(_activeMapId)}` : '';
    const previewHtml = previewSrc
      ? `<div class="settings-worldmap-preview">
           <img src="${esc(previewSrc)}" alt="" ${dataOn('error', 'hide', '$el')}>
         </div>`
      : `<div class="settings-empty" style="margin:0.5rem 0">
           ${esc(I18n.t('settings.mapNoImage'))}
         </div>`;

    const headerLabel = current.isWorld
      ? `🌐 ${esc(I18n.t('settings.worldMap'))}`
      : `🗺 ${esc(current.label)}`;

    return `
      <div class="settings-editor-head">
        <h2>🗺 ${esc(I18n.t('settings.tabMaps'))}</h2>
      </div>
      <div class="settings-maps-shell">
        <aside class="settings-maps-tree" role="tree">
          ${treeHtml}
          <p class="settings-hint settings-maps-tree-hint">
            ${esc(I18n.t('settings.mapsTreeHint'))}
          </p>
        </aside>
        <section class="settings-maps-detail">
          <div class="settings-maps-detail-title">${headerLabel}</div>
          <p class="settings-hint" style="margin-bottom:0.8rem">${uploadHint}</p>
          ${previewHtml}
          <label class="inline-create-btn" style="cursor:pointer;display:inline-block;margin-top:0.8rem">
            📂 ${esc(I18n.t('settings.chooseFile'))}
            <input type="file" accept="image/*" style="display:none"${uploadDataset}
                   ${dataOn('change', uploadAction, '$el')}>
          </label>
          <span class="settings-hint" style="margin-left:0.8rem">
            ${esc(I18n.t('settings.mapUploadHint'))}
          </span>

          <hr style="border:none;border-top:1px dashed rgba(212,184,122,0.18);margin:1.2rem 0">

          <div class="settings-mapviews-group-title">${esc(I18n.t('settings.thisMapSettings'))}</div>
          <label class="settings-field" style="margin-top:0.6rem">
            <span class="settings-field-label">${esc(I18n.t('settings.markerZoomScale'))}
              <span class="settings-hint" style="font-weight:normal">
                ${esc(I18n.t('settings.markerZoomScaleHint'))}
              </span>
            </span>
            <div class="settings-strength-row">
              <input type="range" id="settings-mapconfig-zoomscale"
                min="0" max="1" step="0.05" value="${ratio}"
                ${dataOn('input', 'Settings.updateMapZoomRatioReadout', '$el')}
                ${dataOn('change', 'Settings.commitMapZoomRatio', '$value')}>
              <output id="settings-mapconfig-zoomscale-out">${ratioPct}%</output>
            </div>
          </label>

          ${_mapViewsSectionHtml(current)}
        </section>
      </div>`;
  }

  // ── Saved views (Pohledy) for THE SELECTED MAP — a section of the
  //    Mapy tab (used to be its own tab, grouped by map; the per-map
  //    panel is the natural home). Creation still happens on the map
  //    itself via the ✚ toolbar button; here it's rename/delete. ──
  function _mapViewsSectionHtml(current) {
    const pid   = current.isWorld ? null : current.locationId;
    const views = (Store.getEnum('mapViews') || []).filter(v => (v.parentId || null) === pid);
    const body  = views.length
      ? `<div class="settings-rows">${views.map(_mapViewRow).join('')}</div>`
      : `<div class="settings-empty">${esc(I18n.t('settings.mapViewsEmpty'))}</div>`;
    return `
          <hr style="border:none;border-top:1px dashed rgba(212,184,122,0.18);margin:1.2rem 0">
          <div class="settings-mapviews-group-title">📍 ${esc(I18n.t('settings.tabMapViews'))}</div>
          <p class="settings-hint" style="margin:0.5rem 0 0.8rem">
            ${esc(I18n.t('settings.mapViewsHint'))}
          </p>
          ${body}`;
  }

  /**
   * Switch the Mapy tab to show a different map's preview + config.
   * `'world'` selects the main map; for sub-maps the id is
   * `local-${locationId}` (matches `_currentMapId` in map.js).
   *
   * @param {string} mapId
   */
  function selectMap(mapId) {
    _activeMapId = mapId || 'world';
    render();
  }

  /** Live-update the readout next to the zoom-scale slider as
   *  the user drags. Persistence happens on `change` (after release)
   *  via `commitMapZoomRatio` so we don't fire one PATCH per pixel.
   *  Walks up from the slider's parent to find the sibling `<output>`
   *  rather than `getElementById`, so an SSE-driven re-render that
   *  replaces the slider DOM mid-debounce doesn't leave us writing
   *  text into a detached element. */
  function updateMapZoomRatioReadout(rangeEl) {
    if (!rangeEl) return;
    const out = rangeEl.parentElement?.querySelector('output');
    if (!out) return;
    const v = parseFloat(rangeEl.value);
    out.textContent = `${Math.round((isFinite(v) ? v : 0) * 100)}%`;
  }

  // Debounced commit + self-render suppression.
  //
  // Each `change` on a range slider in some browsers / input devices
  // fires more than once per drag, and each call would otherwise
  // PATCH → server broadcast → SSE → re-render of the Settings page.
  // The re-render replaces the slider DOM mid-interaction, which
  // makes the slider feel broken if the user resumes dragging in
  // the SSE round-trip window.
  //
  // Two mitigations:
  //  • Debounce 600 ms after the last change so a single drag-
  //    release-drag-release sequence collapses into one write.
  //  • Mark the commit as "self-originated" so app.js's SSE handler
  //    can skip the wholesale `navigate()` re-render when our own
  //    PATCH echoes back. The flag clears after a short window
  //    regardless, so an actual remote change still re-renders.
  //
  // Pin the captured target id at the moment commit fires so a
  // switch to a different map mid-debounce doesn't write the value
  // to the wrong key.
  let _zoomCommitTimer  = null;
  let _zoomCommitTarget = null;
  let _selfCommitUntil  = 0;
  /** True when Settings issued a write that hasn't echoed back yet
   *  (SSE round-trip window). Used by app.js's `_applyRemoteChange`
   *  to skip a re-render that would replace the slider DOM mid-
   *  interaction. The window is short (~1.5 s) so genuine remote
   *  edits during that window only get one missed re-render at
   *  worst — the next remote change re-renders normally. */
  function isPendingSelfCommit() {
    return Date.now() < _selfCommitUntil;
  }
  /**
   * Persist the zoom-scale slider's current value for the currently-
   * selected map. Debounced (see comment block above) and live-pushed
   * to a mounted `WorldMap` so markers rescale immediately.
   *
   * @param {string|number} value - Range input value (clamped to 0..1).
   */
  function commitMapZoomRatio(value) {
    let n = parseFloat(value);
    if (!isFinite(n)) n = 0;
    if (n < 0) n = 0;
    if (n > 1) n = 1;
    _zoomCommitTarget = _activeMapId;
    if (_zoomCommitTimer) clearTimeout(_zoomCommitTimer);
    _zoomCommitTimer = setTimeout(() => {
      _zoomCommitTimer = null;
      const target = _zoomCommitTarget;
      _zoomCommitTarget = null;
      if (!target) return;
      _selfCommitUntil = Date.now() + 1500;
      Store.setMapConfig(target, { zoomScaleRatio: n });
      // If the live map is open and showing this map, push the new
      // ratio so it rescales markers immediately rather than waiting
      // for the next zoom event. No-op when on the Settings page.
      try { WorldMap.applyZoomScaleRatio?.(target); } catch (_) {}
    }, 600);
  }

  function uploadWorldMap(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('worldmap', file);
    _flash(I18n.t('settings.uploading'));
    fetch('/api/worldmap', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(() => {
        // A legacy localStorage override would still beat the new server
        // file in WorldMap._getImgUrl, so drop it after a successful
        // upload — the server copy is now the canonical image.
        try { localStorage.removeItem('world_map_image_url'); } catch (_) {}
        _bumpPreviewBust('world');
        _flash(I18n.t('settings.mapUploadedRebuilding'));
        render();
      })
      .catch(e => _flash(e?.error || I18n.t('settings.uploadFailed'), false))
      .finally(() => { if (input) input.value = ''; });
  }

  function uploadSubMap(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const locId = input?.dataset?.locId;
    if (!locId) { _flash(I18n.t('settings.missingPlaceId'), false); return; }
    _flash(I18n.t('settings.uploading'));
    Store.uploadLocalMap(file, locId)
      .then(url => {
        // Refresh the location's record in memory so the preview
        // picks up the new URL on next render.
        const loc = Store.getLocation(locId);
        if (loc) Store.saveLocation({ ...loc, localMap: url });
        _bumpPreviewBust(`local-${locId}`);
        _flash(I18n.t('settings.mapUploadedRebuilding'));
        render();
      })
      .catch(e => _flash(e?.message || I18n.t('settings.uploadFailed'), false))
      .finally(() => { if (input) input.value = ''; });
  }

  // ── Player party panel ───────────────────────────────────────
  // Replaces the legacy `factions.party` record. Edits the
  // player-party visual identity that's used to brand PCs across
  // the UI (faction picker option, dashboard / postavy grouping
  // label, glow colour). Members are still managed through each
  // character's faction dropdown — the source of truth for "is a
  // PC" is `character.faction === 'party'`.
  function _playerPartyHtml() {
    const pp = Store.getPlayerParty();
    const memberCount = Store.getPartyMembers().length;
    return `
      <div class="settings-editor-head">
        <h2>🛡 ${esc(I18n.t('settings.tabPlayerParty'))}</h2>
      </div>
      <div class="settings-panel">
        <p class="settings-hint" style="margin-bottom:1rem">
          ${I18n.t('settings.playerPartyIntro')}
        </p>
        <div class="settings-form-row">
          <label class="settings-field">
            <span class="settings-field-label">${esc(I18n.t('settings.fieldName'))}</span>
            <input class="edit-input" id="pp-name" value="${esc(pp.name)}" placeholder="Our Party">
          </label>
          <label class="settings-field">
            <span class="settings-field-label">${esc(I18n.t('settings.fieldIconEmoji'))}</span>
            <input class="edit-input" id="pp-icon" value="${esc(pp.icon)}" placeholder="🛡">
          </label>
          <label class="settings-field">
            <span class="settings-field-label">${esc(I18n.t('settings.fieldColorGlowChip'))}</span>
            <input class="edit-input" type="color" id="pp-color" value="${esc(pp.color)}">
          </label>
          <label class="settings-field">
            <span class="settings-field-label">${esc(I18n.t('settings.fieldTextColor'))}</span>
            <input class="edit-input" type="color" id="pp-textColor" value="${esc(pp.textColor)}">
          </label>
        </div>
        <div class="settings-form-actions" style="margin-top:1rem">
          <button type="button" class="edit-save-btn"
            ${dataAction('Settings.savePlayerParty')}>💾 ${esc(I18n.t('action.save'))}</button>
        </div>
        <hr style="border:none;border-top:1px dashed rgba(212,184,122,0.18);margin:1.5rem 0">
        <div class="settings-mapviews-group-title">${esc(I18n.t('settings.partyMembers', { count: memberCount }))}</div>
        <p class="settings-hint" style="margin-top:0.6rem">
          ${I18n.t('settings.partyMembersHint')}
        </p>
        <div class="settings-rows" style="margin-top:0.6rem">
          ${Store.getPartyMembers().map(c => `
            <a class="settings-row" href="#/postava/${esc(c.id)}" style="text-decoration:none;color:inherit">
              <span class="settings-row-icon">${esc(pp.badge || pp.icon || '🛡')}</span>
              <span class="settings-row-label">${esc(c.name)}</span>
              <span></span>
              <span></span>
              <span></span>
              <span style="color:var(--text-muted);font-size:0.78rem">${esc(I18n.t('settings.openArrow'))}</span>
            </a>`).join('') || `<div class="settings-empty">${esc(I18n.t('settings.noMembers'))}</div>`}
        </div>
      </div>`;
  }

  /** Persist the player-party edits. Reads the four inputs and
   *  fires through Store.setPlayerParty which mirrors to settings
   *  storage via the regular PATCH path. */
  function savePlayerParty() {
    const get = id => document.getElementById(id)?.value?.trim() || '';
    const patch = {
      name:      get('pp-name')      || 'Our Party',
      icon:      get('pp-icon')      || '🛡',
      badge:     get('pp-icon')      || '🛡',  // mirror so _charBadge resolves
      color:     get('pp-color')     || '#F5F0E4',
      textColor: get('pp-textColor') || '#1a1410',
    };
    Store.setPlayerParty(patch);
    _flash(I18n.t('settings.playerPartySaved'));
    render();
  }

  // ── Branding panel (logo + sidebar wordmark) ─────────────────
  // The logo shows in the sidebar header, on the boot loading screen,
  // and as the browser-tab favicon. `applyBranding()` pushes the
  // current config onto that chrome; it's called from app.js at boot
  // and after every SSE refetch so a DM's upload propagates live.
  const DEFAULT_LOGO = '/branding/logo-default.svg';

  /** Resolve the effective logo URL: the custom upload (cache-busted by
   *  `updatedAt`) when set, else the bundled default. */
  function _logoSrc(b) {
    return b.logoUrl ? `${b.logoUrl}?v=${b.updatedAt || ''}` : DEFAULT_LOGO;
  }

  /** Handle a logo file pick: upload, persist the URL, push to chrome. */
  function uploadLogo(input) {
    const file = input?.files?.[0];
    if (!file) return;
    _flash(I18n.t('settings.uploading'));
    Store.uploadLogo(file)
      .then(url => {
        Store.setBranding({ logoUrl: url });
        applyBranding();
        _flash(I18n.t('settings.logoUploaded'));
        render();
      })
      .catch(e => _flash(e?.error || I18n.t('settings.uploadFailed'), false))
      .finally(() => { if (input) input.value = ''; });
  }

  /** Revert to the bundled default logo. */
  function deleteLogo() {
    Store.deleteLogo()
      .then(() => {
        Store.setBranding({ logoUrl: '' });
        applyBranding();
        _flash(I18n.t('settings.logoReverted'));
        render();
      })
      .catch(e => _flash(e?.error || I18n.t('settings.operationFailed'), false));
  }

  /** Persist the wordmark text (title + subtitle) and push to chrome. */
  function saveBranding() {
    const title    = document.getElementById('brand-title')?.value?.trim() || 'TTRPG Codex';
    const subtitle = document.getElementById('brand-subtitle')?.value?.trim() ?? '';
    Store.setBranding({ title, subtitle });
    applyBranding();
    _flash(I18n.t('settings.brandingSaved'));
    render();
  }

  /**
   * Push the current branding onto the page chrome: the sidebar +
   * loading-screen logo `<img>` (any `.js-brand-logo`), the sidebar
   * wordmark text, the favicon, and the document title. Safe to call
   * repeatedly and on any route — the targets are static markup in
   * index.html, outside `#main-content`.
   */
  function applyBranding() {
    if (typeof document === 'undefined') return;
    let b;
    try { b = Store.getBranding(); } catch (_) { return; }
    const url = _logoSrc(b);
    document.querySelectorAll('.js-brand-logo').forEach(img => {
      if (img.getAttribute('src') !== url) img.setAttribute('src', url);
    });
    const titleEl = document.getElementById('sidebar-logo-title');
    if (titleEl) titleEl.textContent = b.title;
    const subEl = document.getElementById('sidebar-logo-sub');
    if (subEl) subEl.textContent = b.subtitle;
    const fav = document.getElementById('favicon');
    if (fav) fav.setAttribute('href', url);
    if (b.title) document.title = b.title;
  }

  // ── Appearance (visual theme) ────────────────────────────────
  // A simple style switcher. Each THEMES entry maps to a
  // `[data-theme="<id>"]` block in web/css/themes.css overriding the
  // :root design tokens; 'classic' is the bare :root baseline. Stored
  // campaign-wide in settings.appearance (DM-only write) and pushed onto
  // <html data-theme> by applyTheme() — called at boot, on every SSE
  // refetch, and right after a change here. Adding a new style needs only
  // a THEMES entry + a themes.css block; this UI lists it automatically.
  function _appearanceHtml() {
    const cur = Store.getAppearance().theme;
    const opts = THEMES.map(t =>
      `<option value="${esc(t.id)}"${t.id === cur ? ' selected' : ''}>${esc(t.label)}</option>`
    ).join('');
    return `
      <div class="settings-editor-head">
        <h2>🎨 ${esc(I18n.t('settings.tabAppearance'))}</h2>
      </div>
      <div class="settings-panel">
        <p class="settings-hint" style="margin-bottom:1rem">
          ${esc(I18n.t('settings.appearanceIntro'))}
        </p>
        <label class="settings-field" style="max-width:320px">
          <span class="settings-field-label">${esc(I18n.t('settings.styleLabel'))}</span>
          <select class="edit-input" id="theme-select"
                  ${dataOn('change', 'Settings.changeTheme', '$value')}>${opts}</select>
        </label>
        <span class="settings-hint" style="display:block;margin-top:0.8rem">
          ${I18n.t('settings.appearanceMoreHint')}
        </span>
        ${_brandingSectionHtml()}
      </div>`;
  }

  // ── Branding (logo + wordmark) — a SECTION of the appearance tab ──
  // (used to be its own tab; the Store/api surface is unchanged:
  // settings.branding via setBranding / uploadLogo / deleteLogo).
  function _brandingSectionHtml() {
    const b = Store.getBranding();
    const hasCustom = !!b.logoUrl;
    return `
        <hr style="border:none;border-top:1px dashed rgba(212,184,122,0.18);margin:1.5rem 0">
        <div class="settings-mapviews-group-title">🐉 ${esc(I18n.t('settings.tabBranding'))}</div>
        <p class="settings-hint" style="margin:0.6rem 0 1rem">
          ${esc(I18n.t('settings.brandingIntro'))}
        </p>
        <div class="settings-branding-preview">
          <img src="${esc(_logoSrc(b))}" alt="${esc(I18n.t('settings.logoAlt'))}" class="settings-branding-logo"
               ${dataOn('error', 'hide', '$el')}>
          <div class="settings-branding-meta">
            ${esc(hasCustom ? I18n.t('settings.customLogo') : I18n.t('settings.defaultLogo'))}
          </div>
        </div>
        <div class="settings-form-actions" style="margin-top:1rem;gap:0.6rem;flex-wrap:wrap">
          <label class="inline-create-btn" style="cursor:pointer;display:inline-block">
            📂 ${esc(I18n.t('settings.uploadLogoBtn'))}
            <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp"
                   style="display:none" ${dataOn('change', 'Settings.uploadLogo', '$el')}>
          </label>
          ${hasCustom ? `<button type="button" class="inline-create-btn"
              ${dataAction('Settings.deleteLogo')}>↺ ${esc(I18n.t('settings.defaultDragon'))}</button>` : ''}
        </div>
        <span class="settings-hint" style="display:block;margin-top:0.5rem">
          ${esc(I18n.t('settings.logoUploadHint'))}
        </span>

        <hr style="border:none;border-top:1px dashed rgba(212,184,122,0.18);margin:1.5rem 0">

        <div class="settings-mapviews-group-title">${esc(I18n.t('settings.wordmarkText'))}</div>
        <div class="settings-form-row" style="margin-top:0.6rem">
          <label class="settings-field">
            <span class="settings-field-label">${esc(I18n.t('settings.fieldName'))}</span>
            <input class="edit-input" id="brand-title" value="${esc(b.title)}"
                   placeholder="TTRPG Codex">
          </label>
          <label class="settings-field">
            <span class="settings-field-label">${esc(I18n.t('settings.fieldSubtitle'))}</span>
            <input class="edit-input" id="brand-subtitle" value="${esc(b.subtitle)}"
                   placeholder="Wiki & World Atlas">
          </label>
        </div>
        <div class="settings-form-actions" style="margin-top:1rem">
          <button type="button" class="edit-save-btn"
            ${dataAction('Settings.saveBranding')}>💾 ${esc(I18n.t('settings.saveText'))}</button>
        </div>`;
  }

  /** Persist + apply the picked theme. */
  function changeTheme(id) {
    Store.setAppearance({ theme: id });
    applyTheme();
    _flash(I18n.t('settings.appearanceSaved'));
    render();
  }

  /** Push the active theme onto <html data-theme> + cache it for a
   *  flash-free next boot. Validates against THEMES, falling back to
   *  'classic' for an unknown/removed id. Safe to call repeatedly and
   *  on any route. */
  function applyTheme() {
    if (typeof document === 'undefined') return;
    let id = 'classic';
    try { id = Store.getAppearance().theme; } catch (_) {}
    if (!THEMES.some(t => t.id === id)) id = 'classic';
    document.documentElement.setAttribute('data-theme', id);
    try { localStorage.setItem('codex_theme', id); } catch (_) {}
  }

  // ── Account panel ────────────────────────────────────────────
  // Two parts:
  //   1. Current role chip + login/logout button (anyone with a
  //      session can see this — DM viewers in particular, since the
  //      sidebar role badge doesn't carry a 'Odhlásit' affordance).
  //   2. Password management for DM and player roles. DM-only — the
  //      whole /nastaveni route is anyway, but we double-gate so a
  //      future role expansion doesn't accidentally leak the form.
  //      Backed by GET/POST /api/passwords; status fetched lazily on
  //      tab entry and re-fetched after every successful change.

  // Cached password status: { dm, player } each with {stored, updatedAt,
  // envFallback, isDefault?, disabled?}. Loaded by _loadPasswordStatus.
  let _passwordStatus = null;

  function _accountHtml() {
    const role     = Role.get();
    const realRole = Role.getReal();
    const roleChip = (() => {
      if (role === 'dm')                           return `<span class="role-badge-chip role-badge-dm">🛡 DM</span>`;
      if (role === 'player' && realRole === 'dm')  return `<span class="role-badge-chip role-badge-impersonating">👁 ${esc(I18n.t('settings.rolePlayerViewDM'))}</span>`;
      if (role === 'player')                       return `<span class="role-badge-chip role-badge-player">👤 ${esc(I18n.t('settings.rolePlayer'))}</span>`;
      return `<span class="role-badge-chip role-badge-anonymous">👁 ${esc(I18n.t('settings.rolePublic'))}</span>`;
    })();
    const logoutBtn = role
      ? `<button type="button" class="edit-delete-btn"
           ${dataAction('Settings.logout')}>↩ ${esc(I18n.t('action.logout'))}</button>`
      : `<button type="button" class="inline-create-btn"
           ${dataAction('EditMode.promptLogin')}>🔑 ${esc(I18n.t('action.login'))}</button>`;
    // View-as-player toggle. Moved here from the sidebar so non-DM
    // users see no role chrome outside Přehled. Only DMs (real or
    // impersonating) see these buttons — players never need them.
    const viewAsBtn = (() => {
      if (realRole !== 'dm') return '';
      if (role === 'dm') {
        return `<button type="button" class="inline-create-btn"
                  ${dataAction('Role.viewAsPlayer')}
                  title="${esc(I18n.t('settings.viewAsPlayerTitle'))}">👁 ${esc(I18n.t('settings.viewAsPlayer'))}</button>`;
      }
      // role === 'player' && realRole === 'dm' (impersonating)
      return `<button type="button" class="inline-create-btn"
                ${dataAction('Role.backToDM')}
                title="${esc(I18n.t('settings.backToDMTitle'))}">← ${esc(I18n.t('settings.backToDM'))}</button>`;
    })();
    // Password management section — DM-only. Guard on realRole so a
    // DM in "view as player" mode still sees the forms (they're the
    // one with credentials).
    const passwordSection = (realRole === 'dm')
      ? _passwordSectionHtml()
      : `<p class="settings-hint" style="margin-top:1rem;font-style:italic">
           ${esc(I18n.t('settings.passwordDMOnly'))}
         </p>`;
    // Server operations — DM-only + gated on /api/version canRestart
    // (lazy-fetched, like the addons tab). The restart button moved
    // here from the Doplňky toolbar: it's a server op, not an addon op
    // (it's still HOW server-code addon changes load — see the hint).
    if (realRole === 'dm') _ensureServerInfo();
    const serverSection = (realRole === 'dm' && _canRestart) ? `
        <hr style="border:none;border-top:1px dashed rgba(212,184,122,0.18);margin:1.5rem 0">
        <div class="settings-mapviews-group-title">♻ ${esc(I18n.t('settings.serverOps'))}</div>
        <p class="settings-hint" style="margin:0.6rem 0 0.8rem">
          ${esc(I18n.t('settings.serverOpsHint'))}
        </p>
        <button type="button" class="inline-create-btn"
          ${dataAction('Settings.restartServer')}>♻ ${esc(I18n.t('settings.restartServer'))}</button>` : '';
    return `
      <div class="settings-editor-head">
        <h2>🖥 ${esc(I18n.t('settings.tabAccount'))}</h2>
      </div>
      <div class="settings-panel">
        <div class="settings-field" style="display:flex;flex-direction:column;gap:0.6rem;margin-bottom:1rem">
          <span class="settings-field-label">${esc(I18n.t('settings.currentRole'))}</span>
          <div>${roleChip}</div>
        </div>
        <p class="settings-hint" style="margin-bottom:0.8rem">
          ${esc(I18n.t('settings.logoutHint'))}
        </p>
        <div style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:center">
          ${logoutBtn}
          ${viewAsBtn}
        </div>
        ${passwordSection}
        ${serverSection}
      </div>`;
  }

  /** Renders the DM-only password management subsection: status
   *  summary for each role plus two change-password forms. Both forms
   *  require the DM's current password as a safety check. */
  function _passwordSectionHtml() {
    const st = _passwordStatus;
    if (!st) {
      return `<hr style="border:none;border-top:1px dashed rgba(212,184,122,0.18);margin:1.5rem 0">
        <div class="settings-mapviews-group-title">🔑 ${esc(I18n.t('settings.accountPasswords'))}</div>
        <p class="settings-hint" style="margin-top:0.6rem">${esc(I18n.t('settings.loadingStatus'))}</p>`;
    }
    return `
      <hr style="border:none;border-top:1px dashed rgba(212,184,122,0.18);margin:1.5rem 0">
      <div class="settings-mapviews-group-title">🔑 ${esc(I18n.t('settings.accountPasswords'))}</div>
      <p class="settings-hint" style="margin-top:0.6rem;margin-bottom:1rem">
        ${I18n.t('settings.passwordsIntro')}
      </p>
      ${_passwordFormHtml('dm', `🛡 ${I18n.t('settings.dmPassword')}`, st.dm)}
      ${_passwordFormHtml('player', `👤 ${I18n.t('settings.playerPassword')}`, st.player)}`;
  }

  function _passwordFormHtml(role, title, info) {
    const statusLine = (() => {
      if (info.stored) {
        const when = info.updatedAt
          ? ` ${I18n.t('settings.pwdChangedAt', { when: _formatSnapshotDate(new Date(info.updatedAt).toISOString()) })}`
          : '';
        return `<span style="color:var(--accent-gold)">● ${esc(I18n.t('settings.pwdSet'))}${esc(when)}</span>`;
      }
      if (role === 'dm' && info.isDefault) {
        return `<span style="color:#e88">⚠ ${esc(I18n.t('settings.pwdDefault'))}</span>`;
      }
      if (role === 'player' && info.disabled) {
        return `<span style="color:var(--text-muted)">○ ${esc(I18n.t('settings.pwdDisabled'))}</span>`;
      }
      if (info.envFallback) {
        return `<span style="color:var(--text-muted)">○ ${esc(I18n.t('settings.pwdFromEnv'))}</span>`;
      }
      return `<span style="color:var(--text-muted)">○ ${esc(I18n.t('settings.pwdNotSet'))}</span>`;
    })();
    const placeholder = (role === 'player')
      ? I18n.t('settings.pwdNewPlaceholderPlayer')
      : I18n.t('settings.pwdNewPlaceholderDM');
    return `
      <div class="settings-panel" style="margin-bottom:1rem;background:rgba(0,0,0,0.18)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:0.6rem">
          <strong>${esc(title)}</strong>
          <span style="font-size:0.85rem">${statusLine}</span>
        </div>
        <div class="settings-form-row">
          <label class="settings-field">
            <span class="settings-field-label">${esc(I18n.t('settings.currentDMPassword'))}</span>
            <input class="edit-input" type="password" autocomplete="current-password"
                   id="pwd-${esc(role)}-current"
                   placeholder="${esc(I18n.t('settings.forConfirmation'))}">
          </label>
          <label class="settings-field">
            <span class="settings-field-label">${esc(I18n.t('settings.newPassword'))}</span>
            <input class="edit-input" type="password" autocomplete="new-password"
                   id="pwd-${esc(role)}-new"
                   placeholder="${esc(placeholder)}">
          </label>
          <label class="settings-field">
            <span class="settings-field-label">${esc(I18n.t('settings.confirmNewPassword'))}</span>
            <input class="edit-input" type="password" autocomplete="new-password"
                   id="pwd-${esc(role)}-confirm"
                   placeholder="${esc(I18n.t('settings.repeatNewPassword'))}">
          </label>
        </div>
        <div class="settings-form-actions" style="margin-top:0.8rem">
          <button type="button" class="edit-save-btn"
            ${dataAction('Settings.changePassword', role)}>💾 ${esc(role === 'player' && info.stored ? I18n.t('settings.changeOrClearPassword') : I18n.t('settings.savePassword'))}</button>
        </div>
      </div>`;
  }

  /** Submit handler for one password form. Reads the three inputs,
   *  validates locally (matching server-side rules), POSTs to
   *  /api/passwords, then re-fetches status + re-renders. */
  function changePassword(role) {
    if (role !== 'dm' && role !== 'player') return;
    const get = id => document.getElementById(id)?.value || '';
    const current = get(`pwd-${role}-current`);
    const next    = get(`pwd-${role}-new`);
    const confirm = get(`pwd-${role}-confirm`);
    if (!current) { _flash(I18n.t('settings.enterCurrentDMPassword'), false); return; }
    if (next !== confirm) { _flash(I18n.t('settings.passwordsMismatch'), false); return; }
    if (role === 'dm' && next.length < 4) {
      _flash(I18n.t('settings.dmPasswordTooShort'), false); return;
    }
    if (role === 'player' && next.length > 0 && next.length < 4) {
      _flash(I18n.t('settings.playerPasswordTooShort'), false); return;
    }
    if (next.length > 200) { _flash(I18n.t('settings.passwordTooLong'), false); return; }

    fetch('/api/passwords', {
      method:      'POST',
      credentials: 'same-origin',
      headers:     { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, currentPassword: current, newPassword: next }),
    })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(() => {
        const msg = (role === 'player' && next === '')
          ? I18n.t('settings.playerAccountDisabled')
          : I18n.t('settings.passwordChanged', { role: role === 'dm' ? I18n.t('settings.roleDMShort') : I18n.t('settings.rolePlayerShort') });
        _flash(msg);
        // Re-fetch status so the rows reflect the new "nastaveno" timestamp.
        return _loadPasswordStatus().then(render);
      })
      .catch(e => _flash(e?.error || I18n.t('settings.passwordChangeFailed'), false));
  }

  /** Fetch DM/player password status from the server. Stores into
   *  module-level _passwordStatus; returns the promise so callers can
   *  chain a render. */
  function _loadPasswordStatus() {
    return fetch('/api/passwords', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { _passwordStatus = j; })
      .catch(() => { _passwordStatus = null; });
  }

  /** Clear the session cookie via Role.logout(). The role:changed
   *  event handler in app.js refetches data + re-renders, so we don't
   *  need to navigate ourselves. */
  function logout() {
    if (!confirm(I18n.t('settings.logoutConfirm'))) return;
    Role.logout().then(() => _flash(I18n.t('settings.loggedOut')));
  }

  // ── Backup / Snapshot panel ──────────────────────────────────
  // Players see: the snapshot list + the create-manual-snapshot
  // button. Pinning a "known-good" point before risky edits is
  // useful for everyone, and the metadata endpoint leaks nothing.
  // DM-only on top: the raw ZIP download (would bypass the
  // visibility filter), restore-from-file, restore-snapshot,
  // delete-snapshot, and revert-last-N. The server enforces all of
  // this — the UI gates below are pure UX so non-DM viewers don't
  // see buttons that would 401.
  function _backupHtml() {
    const isDM = Role.isDM();
    const rows = _snapshots.length ? _snapshots.map(_snapshotRow).join('') : `
      <div class="settings-empty">${esc(I18n.t('settings.noSnapshots'))}</div>`;
    const downloadBtn = isDM ? `
          <a class="inline-create-btn" href="/api/backup"
             title="${esc(I18n.t('settings.downloadZipTitle'))}">📥 ${esc(I18n.t('settings.downloadZip'))}</a>` : '';
    const restoreBtn = isDM ? `
          <label class="inline-create-btn" style="cursor:pointer"
             title="${esc(I18n.t('settings.restoreFromBackupTitle'))}">
            📤 ${esc(I18n.t('settings.restoreFromBackup'))}
            <input type="file" accept=".zip,.json,application/zip,application/json"
                   style="display:none"
                   ${dataOn('change', 'Settings.uploadRestore', '$el')}>
          </label>` : '';
    const revertRow = isDM ? `
        <div class="settings-revert-row">
          <label class="settings-field" style="margin-right:0.6rem">
            <span class="settings-field-label">${esc(I18n.t('settings.revertLastN'))}</span>
            <input class="edit-input" type="number" min="1" max="50"
                   value="1" id="settings-revert-n" style="width:5rem">
          </label>
          <button type="button" class="edit-delete-btn"
                  ${dataAction('Settings.revertLastN')}>↶ ${esc(I18n.t('action.undo'))}</button>
        </div>` : '';
    const playerHint = isDM ? '' : `
        <p class="settings-hint" style="margin-bottom:0.8rem;font-style:italic">
          ${esc(I18n.t('settings.backupPlayerHint'))}
        </p>`;
    return `
      <div class="settings-editor-head">
        <h2>💾 ${esc(I18n.t('settings.tabBackup'))}</h2>
        <div class="settings-editor-actions">
          ${downloadBtn}
          ${restoreBtn}
          <button type="button" class="inline-create-btn"
                  ${dataAction('Settings.createSnapshot')}>＋ ${esc(I18n.t('settings.createSnapshot'))}</button>
          <button type="button" class="inline-create-btn"
                  ${dataAction('Settings.refreshSnapshots')}>↻ ${esc(I18n.t('action.restore'))}</button>
        </div>
      </div>
      <div class="settings-panel">
        <p class="settings-hint" style="margin-bottom:0.8rem">
          ${esc(I18n.t('settings.backupIntro'))}${isDM ? ' ' + I18n.t('settings.backupIntroDM') : ''}
        </p>
        ${playerHint}
        ${revertRow}
        <div class="settings-snapshots">${rows}</div>
      </div>`;
  }

  function _snapshotRow(s) {
    const when = _formatSnapshotDate(s.createdAt);
    const kb   = Math.max(1, Math.round((s.size || 0) / 1024));
    const tag  = s.reason === 'manual' ? `✦ ${I18n.t('settings.snapshotManual')}` :
                 s.reason === 'pre-restore' ? `⚠ ${I18n.t('settings.snapshotPreRestore')}` : `✎ ${I18n.t('settings.snapshotEdit')}`;
    // Restore + delete are DM-only; players see the row without
    // action buttons so they can review history but not roll it back.
    const actions = Role.isDM() ? `
        <div class="settings-row-actions">
          <button type="button" class="settings-btn-edit"
                  title="${esc(I18n.t('settings.restoreThisStateTitle'))}"
                  ${dataAction('Settings.restoreSnapshot', s.id)}>↶</button>
          <button type="button" class="settings-btn-del"
                  title="${esc(I18n.t('settings.deleteSnapshotTitle'))}"
                  ${dataAction('Settings.deleteSnapshot', s.id)}>🗑</button>
        </div>` : '';
    return `
      <div class="settings-row">
        <span class="settings-row-icon">🕒</span>
        <span class="settings-row-label">${esc(when)}</span>
        <code class="settings-row-id">${esc(tag)}</code>
        <span class="settings-row-usage" title="${esc(I18n.t('settings.sizeTitle'))}">${kb} kB</span>
        ${actions}
      </div>`;
  }

  function _formatSnapshotDate(iso) {
    return I18n.formatDate(iso, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
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
    _flash(I18n.t('settings.creatingSnapshot'));
    fetch('/api/snapshots', { method: 'POST', credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(() => _loadSnapshots().then(render).then(() => _flash(I18n.t('settings.snapshotCreated'))))
      .catch(() => _flash(I18n.t('settings.snapshotCreateFailed'), false));
  }

  function restoreSnapshot(id) {
    const s = _snapshots.find(x => x.id === id);
    const when = s ? _formatSnapshotDate(s.createdAt) : id;
    if (!confirm(I18n.t('settings.restoreSnapshotQ', { when }))) return;
    _flash(I18n.t('settings.restoring'));
    fetch(`/api/snapshots/${encodeURIComponent(id)}/restore`, {
      method: 'POST', credentials: 'same-origin',
    })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(() => {
        _flash(I18n.t('settings.restored'));
        // Force the client to reload fresh data; SSE should fire too,
        // but re-fetch to be certain the new state is in the tab.
        Store.load().then(() => _loadSnapshots().then(render));
      })
      .catch(() => _flash(I18n.t('settings.restoreFailed'), false));
  }

  function deleteSnapshot(id) {
    const s = _snapshots.find(x => x.id === id);
    const when = s ? _formatSnapshotDate(s.createdAt) : id;
    if (!confirm(I18n.t('settings.deleteSnapshotQ', { when }))) return;
    fetch(`/api/snapshots/${encodeURIComponent(id)}`, {
      method: 'DELETE', credentials: 'same-origin',
    })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(() => _loadSnapshots().then(render).then(() => _flash(I18n.t('settings.deleted'))))
      .catch(() => _flash(I18n.t('settings.deleteFailed'), false));
  }

  function revertLastN() {
    const input = document.getElementById('settings-revert-n');
    const n = Math.max(1, Math.min(50, Number(input?.value) || 1));
    if (!confirm(I18n.plural('settings.revertLastNQ', n))) return;
    _flash(I18n.plural('settings.revertingLastN', n));
    fetch(`/api/snapshots/revert-last/${n}`, {
      method: 'POST', credentials: 'same-origin',
    })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(() => {
        _flash(I18n.t('settings.restored'));
        Store.load().then(() => _loadSnapshots().then(render));
      })
      .catch(e => _flash(e?.error || I18n.t('settings.revertFailed'), false));
  }

  // Restore from an uploaded ZIP (full data/ tree from /api/backup)
  // or a JSON document in the shape Store.exportJSON() produces.
  // The server takes a pre-restore snapshot internally so the user
  // can roll back even if they pick the wrong file.
  function uploadRestore(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!confirm(I18n.t('settings.restoreFromFileQ', { name: file.name }))) {
      input.value = '';
      return;
    }
    const fd = new FormData();
    fd.append('backup', file);
    _flash(I18n.t('settings.uploadingRestoring'));
    fetch('/api/restore', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(j => {
        const fmt = j.format === 'zip' ? 'ZIP' : 'JSON';
        _flash(I18n.t('settings.restoredFromFmt', { fmt, count: j.restored }));
        // Refresh local store + snapshot list to reflect the new state.
        Store.load().then(() => _loadSnapshots().then(render));
      })
      .catch(e => _flash(e?.error || I18n.t('settings.restoreFailed'), false))
      .finally(() => { if (input) input.value = ''; });
  }

  // ── Delete-with-usage modal ──────────────────────────────────
  function _openDeleteModal(id, item, usages) {
    const cat = _activeCat;
    const others = Store.getEnum(cat).filter(x => x.id !== id);
    const usageLinks = usages.slice(0, 20).map(u => `
      <li><a href="#/${_routeForCollection(u.collection)}/${u.id}">${esc(u.name)}</a></li>`).join('');
    const overflow = usages.length > 20 ? `<li>${esc(I18n.t('settings.andMore', { count: usages.length - 20 }))}</li>` : '';

    let root = document.getElementById('settings-del-modal');
    if (root) root.remove();
    root = document.createElement('div');
    root.id = 'settings-del-modal';
    root.className = 'settings-modal';
    root.innerHTML = `
      <div class="settings-modal-backdrop" data-dismiss></div>
      <div class="settings-modal-panel" role="dialog" aria-modal="true">
        <div class="settings-modal-title">${esc(I18n.t('settings.deleteModalTitle', { name: item?.label || id }))}</div>
        <div class="settings-modal-body">
          <p>${I18n.t('settings.deleteModalUsedBy', { count: `<strong>${usages.length}×</strong>` })}</p>
          <ul class="settings-modal-usages">${usageLinks}${overflow}</ul>
          <div class="settings-modal-choice">
            <label class="settings-field">
              <span class="settings-field-label">${esc(I18n.t('settings.replaceWith'))}</span>
              <select class="edit-select" id="sdm-replace">
                <option value="">${esc(I18n.t('settings.notSelected'))}</option>
                ${others.map(o => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}
              </select>
            </label>
          </div>
        </div>
        <div class="settings-modal-actions">
          <button type="button" class="edit-save-btn"
            ${dataAction('Settings.commitDelete', id, 'replace')}>${esc(I18n.t('settings.replaceAndDelete'))}</button>
          <button type="button" class="edit-delete-btn"
            ${dataAction('Settings.commitDelete', id, 'force')}>${esc(I18n.t('settings.deleteAnyway'))}</button>
          <button type="button" class="inline-create-btn"
            ${dataAction('Settings.closeModal')}>${esc(I18n.t('action.cancel'))}</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('.settings-modal-backdrop')
        .addEventListener('click', () => root.remove());
  }

  function commitDelete(id, mode) {
    if (mode === 'replace') {
      const replaceWith = document.getElementById('sdm-replace')?.value || '';
      if (!replaceWith) { _flash(I18n.t('settings.pickReplacement'), false); return; }
      const res = Store.deleteEnumItem(_activeCat, id, { replaceWith });
      closeModal();
      render();
      _flash(I18n.t('settings.replacedAndDeleted', { count: res.usages.length }));
    } else if (mode === 'force') {
      const res = Store.deleteEnumItem(_activeCat, id, { force: true });
      closeModal();
      render();
      _flash(I18n.t('settings.deletedOrphaned', { count: res.usages.length }));
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
      mysteries:'zahada', artifacts:'artefakt', factions:'frakce',
      pantheon:'buh', historicalEvents:'historicka-udalost',
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

  // ── Addon manager (Settings → Doplňky) ───────────────────────
  // DM-only tab (gated by _visibleSpecialTabs). Lists installed addons
  // from /api/addons (lazy-loaded on tab entry like the account tab),
  // with enable/disable/remove + an install wizard that takes a pasted
  // GitHub URL. Built entirely on design-system tokens/classes.
  let _addonsList     = null;   // cached /api/addons projection; null = loading
  let _addonWizardEsc = null;   // keydown handler installed while the wizard is open
  let _wizardPreview  = null;   // { repo, ref, sha } captured at the wizard's preview step
  let _wizardMode     = 'install'; // 'install' | 'update' — wizard messaging
  let _addonUpdates   = {};     // id -> { hasUpdate, repo, ... } from the last check-updates
  let _canRestart     = null;   // /api/version `canRestart` (null = not yet fetched)
  let _serverInfoPending = false;

  function _loadAddons() {
    return fetch('/api/addons', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(r => r.ok ? r.json() : null)
      .then(j => { _addonsList = (j && Array.isArray(j.addons)) ? j.addons : []; })
      .catch(() => { _addonsList = []; });
  }

  /** DM gate for the addon lifecycle actions: prompts login for a non-DM and
   *  returns false so the caller bails. Centralises the repeated guard. */
  function _requireDM() {
    if (Role.isDM()) return true;
    try { EditMode.promptLogin(); } catch (_) {}
    return false;
  }

  /** Re-fetch the addon list and re-render IF the Doplňky tab is showing — the
   *  shared tail of every lifecycle mutation. */
  function _reloadAddonsIfActive() {
    return _loadAddons().then(() => { if (_activeCat === 'addons') render(); });
  }

  /** Fetch /api/version `canRestart` once (gates the "restart server" button).
   *  Re-renders the addons tab when it resolves so the button appears without a
   *  manual reload. No-op once known or while a fetch is in flight. */
  function _ensureServerInfo() {
    if (_canRestart !== null || _serverInfoPending) return;
    _serverInfoPending = true;
    Store.getCanRestart().then(v => {
      _canRestart = !!v; _serverInfoPending = false;
      if (_activeCat === 'addons') render();
    });
  }

  // Close the addon-row overflow / permissions <details> menus on an outside
  // click, on a menu item firing, or on Esc — and keep only one open at a time.
  // Native <details> does none of this, so without it a menu sticks open over a
  // re-rendering list (or after a cancelled confirm). Bubble phase, so app.js's
  // capture-phase action dispatcher runs the clicked item's action first.
  // Registered once at module load.
  const _ADDON_MENU_SEL = '.addon-actions-more[open], .addon-row-perms[open]';
  document.addEventListener('click', (ev) => {
    document.querySelectorAll(_ADDON_MENU_SEL).forEach(d => {
      const sum = d.querySelector(':scope > summary');
      if (sum && sum.contains(ev.target)) return;   // its own summary → native toggle owns it
      d.open = false;                                // outside click, or a menu item (after its action fired)
    });
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') document.querySelectorAll(_ADDON_MENU_SEL).forEach(d => { d.open = false; });
  });

  function _addonsHtml() {
    _ensureServerInfo();   // fetch canRestart once → reveals the restart button
    // Overlay each installed addon with its live client load-state so a
    // broken addon reads as an error rather than looking fine.
    const loadStates = {};
    try { for (const a of Addons.list()) loadStates[a.id] = a; } catch (_) {}
    let body;
    if (_addonsList === null) {
      body = `<div class="settings-empty">${esc(I18n.t('settings.loading'))}</div>`;
    } else if (!_addonsList.length) {
      body = `<div class="settings-empty">${esc(I18n.t('settings.noAddons'))}</div>`;
    } else {
      body = `<div class="addon-list">${_addonsList.map(a => _addonRow(a, loadStates[a.id])).join('')}</div>`;
    }
    return `
      <div class="settings-editor-head">
        <h2>🧩 ${esc(I18n.t('settings.tabAddons'))}</h2>
        <div class="settings-editor-actions">
          ${(_addonsList && _addonsList.length) ? `<button type="button" class="inline-create-btn"
            ${dataAction('Settings.checkAddonUpdates')}>🔄 ${esc(I18n.t('settings.checkUpdates'))}</button>
          <button type="button" class="inline-create-btn"
            ${dataAction('Settings.updateAllAddons')}>⬆ ${esc(I18n.t('settings.updateAll'))}</button>` : ''}
          <button type="button" class="edit-save-btn"
            ${dataAction('Settings.openAddonWizard')}>＋ ${esc(I18n.t('settings.installFromGitHub'))}</button>
        </div>
      </div>
      <div class="settings-panel">
        <p class="settings-hint" style="margin-bottom:1rem">
          ${esc(I18n.t('settings.addonsIntro'))}
          ${_canRestart ? ' ' + esc(I18n.t('settings.restartMovedHint')) : ''}
        </p>
        ${_conflictsHtml()}
        ${body}
      </div>`;
  }

  // Fragment-override conflicts (Phase 6): ≥2 addons claiming an exclusive
  // (replace/hide) op on the SAME built-in fragment. Until the DM picks a
  // winner the built-in renders (never a silent clobber). Each card is a
  // radio of claimants + a "built-in" option; picking writes the resolution.
  // Map a raw fragment-target id (`characters:section:vazby`, `characters:body`)
  // to a human label so a DM resolving a conflict doesn't have to read developer
  // identifiers. Falls back to the raw id for anything unrecognised.
  function _fragmentLabel(target) {
    const KIND = {
      characters: I18n.t('settings.fragKindCharacter'), locations: I18n.t('settings.fragKindLocation'),
      events: I18n.t('settings.fragKindEvent'), mysteries: I18n.t('settings.fragKindMystery'),
      factions: I18n.t('settings.fragKindFaction'),
    };
    const SEC  = {
      vazby: I18n.t('settings.fragSecVazby'), udalosti: I18n.t('settings.fragSecUdalosti'),
      znalosti: I18n.t('settings.fragSecZnalosti'), otazky: I18n.t('settings.fragSecOtazky'),
      mazlicci: I18n.t('settings.fragSecMazlicci'),
    };
    const p = String(target || '').split(':');
    const kind = KIND[p[0]] || p[0] || '?';
    if (p[1] === 'body')    return I18n.t('settings.fragBody', { kind });
    if (p[1] === 'section') return I18n.t('settings.fragSection', { kind, section: SEC[p[2]] || p[2] || '?' });
    if (p[1] === 'addon')   return I18n.t('settings.fragAddonSection', { kind });
    return target;
  }

  function _conflictsHtml() {
    let conflicts = [];
    try { conflicts = Addons.conflicts() || []; } catch (_) {}
    if (!conflicts.length) return '';
    const opLabel = op => (op === 'hide' ? I18n.t('settings.opHide') : I18n.t('settings.opReplace'));
    const cards = conflicts.map(c => {
      const name = `conf-${c.target}`;
      const opts = c.claimants.map(cl => `
        <label class="addon-conflict-opt">
          <input type="radio" name="${esc(name)}" ${c.resolved === cl.addonId ? 'checked' : ''}
            ${dataOn('change', 'Settings.resolveAddonConflict', c.target, cl.addonId)}>
          <span><strong>${esc(cl.addonId)}</strong> — ${opLabel(cl.op)}</span>
        </label>`).join('');
      const builtin = `
        <label class="addon-conflict-opt">
          <input type="radio" name="${esc(name)}" ${c.resolved === null ? 'checked' : ''}
            ${dataOn('change', 'Settings.resolveAddonConflict', c.target, null)}>
          <span>${esc(I18n.t('settings.builtinNoAddon'))}</span>
        </label>`;
      const unresolved = c.resolved === undefined;
      return `
        <div class="addon-conflict${unresolved ? ' addon-conflict-open' : ''}">
          <div class="addon-conflict-title">${unresolved ? '⚠' : '✓'} ${esc(_fragmentLabel(c.target))}
            <code title="${esc(c.target)}">${esc(c.target)}</code></div>
          <div class="addon-conflict-hint">${esc(unresolved
            ? I18n.t('settings.conflictHint')
            : I18n.t('settings.conflictResolved'))}</div>
          <div class="addon-conflict-opts">${opts}${builtin}</div>
        </div>`;
    }).join('');
    return `<div class="addon-conflicts"><h3 class="addon-conflicts-h">⚠ ${esc(I18n.t('settings.conflicts'))}</h3>${cards}</div>`;
  }

  function resolveAddonConflict(target, winner) {
    if (!_requireDM()) return;
    Store.resolveAddonConflict(target, winner).then(r => {
      if (r && r.ok) _flash(I18n.t('settings.choiceSaved'));
      else _flash((r && r.error) || I18n.t('settings.choiceSaveFailed'), false);
      // The addons-changed SSE reconcile re-renders with the winner applied.
    });
  }

  function _addonRow(a, loadState) {
    const lstate     = loadState && loadState.state;
    const upd        = _addonUpdates[a.id];
    const smokeFails = loadState && Array.isArray(loadState.smoke) ? loadState.smoke : [];

    // ── Status chips: ONE clustered group, a uniform dot+label vocabulary.
    // The dot colour carries severity (so error vs render-warning no longer
    // share a glyph); the label says what it is. Lifecycle first, then server,
    // then update/warning.
    const chip = (tone, label) => `<span class="addon-chip addon-chip-${tone}">${esc(label)}</span>`;
    const chips = [];
    if (lstate === 'error')        chips.push(chip('danger', I18n.t('settings.chipError')));
    else if (lstate === 'blocked') chips.push(chip('danger', I18n.t('settings.chipBlocked')));
    else if (a.enabled)            chips.push(chip('ok', I18n.t('settings.chipActive')));
    else                           chips.push(chip('off', I18n.t('settings.chipDisabled')));
    if (a.server) {
      const SS = { loaded: ['ok', I18n.t('settings.chipServer')], error: ['danger', I18n.t('settings.chipServerError')],
                   blocked: ['danger', I18n.t('settings.chipServerBlocked')], 'pending-restart': ['warn', I18n.t('settings.chipServerRestart')] };
      const s = SS[a.serverState];
      if (s) chips.push(chip(s[0], s[1]));
    }
    if (a.enabled && upd && upd.hasUpdate) chips.push(chip('info', I18n.t('settings.chipUpdate')));
    if (smokeFails.length)                 chips.push(chip('warn', I18n.t('settings.chipRenderTest')));
    const chipsHtml = `<span class="addon-row-chips">${chips.join('')}</span>`;

    // ── Notes: detail that USED to be tooltip-only, now visible (and reachable
    // by keyboard / touch / screen reader).
    const notes = [];
    if ((lstate === 'error' || lstate === 'blocked') && loadState.error)
      notes.push(`<div class="addon-row-err">${esc(loadState.error)}</div>`);
    if (smokeFails.length)
      notes.push(`<div class="addon-row-warn">${esc(I18n.t('settings.renderTestReported', { detail: smokeFails.map(f => `${f.kind} (${f.message || '?'})`).join(' · ') }))}</div>`);
    if (a.server && a.serverState === 'pending-restart')
      notes.push(`<div class="addon-row-warn">${esc(I18n.t('settings.serverRestartNote'))}</div>`);
    else if (a.server && (a.serverState === 'error' || a.serverState === 'blocked'))
      notes.push(`<div class="addon-row-err">${esc(I18n.t('settings.serverPartNote', { state: a.serverState }))}</div>`);

    // ── Permissions: collapsed to a count (the full review happened at install).
    const perms = Array.isArray(a.permissions) ? a.permissions : [];
    const permsLine = perms.length
      ? `<details class="addon-row-perms"><summary>${esc(I18n.plural('settings.permissionsCount', perms.length))}</summary>
           <div class="addon-perms-detail">${perms.map(p =>
             `<span title="${esc(p)}">${esc(Addons.describePermission(p))}</span>`).join(' · ')}</div></details>`
      : '';

    // ── Actions, ranked: primary Update (when available), secondary toggle,
    // rare actions (roll back / remove) behind an overflow menu.
    const updateBtn = (a.enabled && upd && upd.hasUpdate)
      ? `<button type="button" class="edit-save-btn" ${dataAction('Settings.updateAddon', a.id)}>⬆ ${esc(I18n.t('settings.update'))}</button>`
      : '';
    const toggle = a.enabled
      ? `<button type="button" class="inline-create-btn" ${dataAction('Settings.disableAddon', a.id)}>${esc(I18n.t('settings.disable'))}</button>`
      : `<button type="button" class="inline-create-btn" ${dataAction('Settings.enableAddon', a.id)}>${esc(I18n.t('settings.enable'))}</button>`;
    const rollbackItem = (Array.isArray(a.versions) && a.versions.length > 1)
      ? `<button type="button" class="inline-create-btn" ${dataAction('Settings.rollbackAddon', a.id)}>↩ ${esc(I18n.t('settings.rollbackVersion'))}</button>`
      : '';
    const moreMenu = `
      <details class="addon-actions-more">
        <summary aria-label="${esc(I18n.t('settings.moreActions'))}" title="${esc(I18n.t('settings.moreActions'))}">⋯</summary>
        <div class="addon-actions-menu">
          ${rollbackItem}
          <button type="button" class="edit-delete-btn" ${dataAction('Settings.removeAddon', a.id)}>🗑 ${esc(I18n.t('action.remove'))}</button>
        </div>
      </details>`;

    return `
      <div class="addon-row">
        <div class="addon-row-main">
          <span class="addon-row-name">${esc(a.name || a.id)}</span>
          <span class="addon-row-ver">v${esc(a.version || '?')}</span>
          ${chipsHtml}
        </div>
        ${permsLine}
        ${notes.join('')}
        <div class="addon-row-actions">
          ${updateBtn}${toggle}${moreMenu}
        </div>
      </div>`;
  }

  function _addonLifecycle(method, url, okMsg) {
    return fetch(url, { method, credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(() => { _flash(okMsg); return _reloadAddonsIfActive(); })
      .catch(e => _flash((e && e.error) || I18n.t('settings.operationFailed'), false));
  }
  function enableAddon(id)  { _addonLifecycle('POST',   `/api/addons/${encodeURIComponent(id)}/enable`,  I18n.t('settings.addonEnabled')); }
  function disableAddon(id) { delete _addonUpdates[id]; _addonLifecycle('POST', `/api/addons/${encodeURIComponent(id)}/disable`, I18n.t('settings.addonDisabled')); }
  function removeAddon(id) {
    const a = (_addonsList || []).find(x => x.id === id);
    const name = a ? (a.name || a.id) : id;
    if (!confirm(I18n.t('settings.removeAddonQ', { name }))) return;
    delete _addonUpdates[id];   // drop the stale update entry for the gone addon
    _addonLifecycle('DELETE', `/api/addons/${encodeURIComponent(id)}`, I18n.t('settings.addonRemoved'));
  }

  // ── Update check + rollback (Phase 9) ─────────────────────────
  function checkAddonUpdates() {
    if (!_requireDM()) return;
    _flash(I18n.t('settings.checkingUpdates'));
    Store.checkAddonUpdates().then(r => {
      if (!r.ok) { _flash(r.error || I18n.t('settings.checkFailed'), false); return; }
      _addonUpdates = {};
      for (const u of r.updates) if (u && u.id) _addonUpdates[u.id] = u;
      const n = r.updates.filter(u => u.hasUpdate).length;
      _flash(n ? I18n.plural('settings.updatesAvailable', n) : I18n.t('settings.allUpToDate'));
      if (_activeCat === 'addons') render();
    });
  }

  function updateAddon(id) {
    if (!_requireDM()) return;
    const u = _addonUpdates[id];
    if (!u || !u.repo) { _flash(I18n.t('settings.checkUpdatesFirst'), false); return; }
    openAddonWizard(u.repo, 'update');
  }

  function rollbackAddon(id) {
    if (!_requireDM()) return;
    const a = (_addonsList || []).find(x => x.id === id);
    if (!confirm(I18n.t('settings.rollbackAddonQ', { name: (a && (a.name || a.id)) || id }))) return;
    Store.rollbackAddon(id).then(r => {
      if (r.ok) {
        _flash(I18n.t('settings.rolledBackTo', { version: r.version || '?' }) + ((a && a.server) ? I18n.t('settings.rollbackServerSuffix') : ''));
        _addonUpdates = {};   // version changed → the cached update check is stale
        _reloadAddonsIfActive();
      } else _flash(r.error || I18n.t('settings.rollbackFailed'), false);
    });
  }

  // ── Update all + server restart ──────────────────────────────
  function updateAllAddons() {
    if (!_requireDM()) return;
    if (!confirm(I18n.t('settings.updateAllQ'))) return;
    _flash(I18n.t('settings.updatingAll'));
    Store.updateAllAddons().then(r => {
      if (!r.ok) { _flash(r.error || I18n.t('settings.operationFailed'), false); return; }
      const n = (r.updated || []).length;
      const nErr = (r.errors || []).length;
      if (!n && !nErr) { _flash(I18n.t('settings.allUpToDate')); }
      else {
        let msg = n ? I18n.plural('settings.updatedN', n) : I18n.t('settings.operationFailed');
        if (nErr) msg += ' · ' + I18n.plural('settings.updateErrorsN', nErr);
        if (r.serverChanged && _canRestart) msg += ' — ' + I18n.t('settings.restartHint');
        _flash(msg, nErr === 0);
      }
      _addonUpdates = {};
      _reloadAddonsIfActive();
    });
  }

  function restartServer() {
    if (!_requireDM()) return;
    if (!confirm(I18n.t('settings.restartQ'))) return;
    Store.restartServer().then(r => {
      if (!r.ok) { _flash(r.error || I18n.t('settings.restartFailed'), false); return; }
      _showRestartOverlay();
    });
  }

  // Full-screen "restarting…" overlay. Two-phase poll on /api/version: wait for the
  // server to go DOWN (the old process is still answering for ~200 ms after we ask
  // it to exit), then for it to come back UP, then reload. Robust to that window.
  function _showRestartOverlay() {
    let ov = document.getElementById('server-restart-overlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'server-restart-overlay'; document.body.appendChild(ov); }
    ov.innerHTML =
      `<div class="sro-card"><div class="sro-spinner" aria-hidden="true"></div>` +
      `<div class="sro-msg">${esc(I18n.t('settings.restarting'))}</div></div>`;
    let phase = 'down', tries = 0;
    const tick = () => {
      tries++;
      fetch('/api/version', { cache: 'no-store' }).then(r => {
        if (!r.ok) throw new Error('down');
        if (phase === 'up') { window.location.reload(); return; }
        if (tries < 90) setTimeout(tick, 800); else _restartOverlayTimeout(ov);
      }).catch(() => {
        phase = 'up';   // unreachable → it's restarting; now wait for it back
        if (tries < 90) setTimeout(tick, 800); else _restartOverlayTimeout(ov);
      });
    };
    setTimeout(tick, 800);
  }
  function _restartOverlayTimeout(ov) {
    if (!ov) return;
    ov.innerHTML = `<div class="sro-card"><div class="sro-msg">${esc(I18n.t('settings.restartTimeout'))}</div>` +
      `<button type="button" class="edit-save-btn" ${dataAction('reload')}>${esc(I18n.t('settings.reloadNow'))}</button></div>`;
  }

  // ── Install wizard (paste URL → install → live-load) ─────────
  // A focused modal appended to <body> (outside #main-content, so a
  // settings re-render behind it doesn't tear it down). The backup /
  // test / dependency steps arrive in a later phase.
  function openAddonWizard(prefillRepo, mode) {
    if (!_requireDM()) return;
    closeAddonWizard();
    _wizardMode = (mode === 'update') ? 'update' : 'install';
    const title = _wizardMode === 'update' ? `🔄 ${I18n.t('settings.wizardUpdateTitle')}` : `🧩 ${I18n.t('settings.wizardInstallTitle')}`;
    const prefill = (typeof prefillRepo === 'string') ? prefillRepo : '';
    const ov = document.createElement('div');
    ov.id = 'addon-wizard-overlay';
    ov.className = 'addon-wizard-overlay';
    ov.innerHTML = `
      <div class="addon-wizard" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="addon-wizard-head">
          <h3>${esc(title)}</h3>
          <button type="button" class="addon-wizard-x" aria-label="${esc(I18n.t('action.close'))}"
            ${dataAction('Settings.closeAddonWizard')}>✕</button>
        </div>
        <div class="addon-wizard-body" id="addon-wizard-body">
          <p class="settings-hint">${I18n.t('settings.wizardPasteHint')}</p>
          <label class="settings-field" style="margin-top:.6rem">
            <span class="settings-field-label">${esc(I18n.t('settings.githubUrl'))}</span>
            <input class="edit-input" id="addon-wizard-url" type="text" autocomplete="off"
                   placeholder="https://github.com/owner/muj-doplnek" value="${esc(prefill)}"
                   ${dataOn('keydown', 'Settings.addonWizardKey', '$ev')}>
          </label>
          <div class="addon-wizard-status" id="addon-wizard-status"></div>
        </div>
        <div class="addon-wizard-foot" id="addon-wizard-foot">
          <button type="button" class="inline-create-btn"
            ${dataAction('Settings.closeAddonWizard')}>${esc(I18n.t('action.cancel'))}</button>
          <button type="button" class="edit-save-btn" id="addon-wizard-go"
            ${dataAction('Settings.previewAddon')}>${esc(I18n.t('settings.wizardLoad'))}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', e => { if (e.target === ov) closeAddonWizard(); });
    _addonWizardEsc = (e) => { if (e.key === 'Escape') closeAddonWizard(); };
    document.addEventListener('keydown', _addonWizardEsc);
    // Update mode arrives with the repo pre-filled → resolve it straight away.
    if (prefill) setTimeout(() => previewAddon(), 0);
    else setTimeout(() => { const i = document.getElementById('addon-wizard-url'); if (i) i.focus(); }, 0);
  }

  function closeAddonWizard() {
    const ov = document.getElementById('addon-wizard-overlay');
    if (ov) ov.remove();
    if (_addonWizardEsc) { document.removeEventListener('keydown', _addonWizardEsc); _addonWizardEsc = null; }
    _wizardPreview = null;
  }

  function addonWizardKey(ev) {
    if (ev && ev.key === 'Enter') { ev.preventDefault(); previewAddon(); }
  }

  function _wizardStatus(html) {
    const el = document.getElementById('addon-wizard-status');
    if (el) el.innerHTML = html || '';
  }

  // Step 1 — resolve addon.json for DM review (no download / install yet).
  function previewAddon() {
    const input = document.getElementById('addon-wizard-url');
    const url = ((input && input.value) || '').trim();
    if (!url) { _wizardStatus(`<span class="addon-wizard-err">${esc(I18n.t('settings.wizardPasteRepo'))}</span>`); return; }
    const go = document.getElementById('addon-wizard-go');
    if (go)    go.disabled = true;
    if (input) input.disabled = true;
    _wizardStatus(`<span class="addon-wizard-busy">⏳ ${esc(I18n.t('settings.wizardLoadingManifest'))}</span>`);
    fetch('/api/addons/preview', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: url }),
    })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(p => { _wizardPreview = { repo: p.repo, ref: p.ref, sha: p.sha }; _renderWizardPreview(p); })
      .catch(e => {
        if (go)    go.disabled = false;
        if (input) input.disabled = false;
        _wizardStatus(`<span class="addon-wizard-err">${esc((e && e.error) || I18n.t('settings.previewFailed'))}</span>`);
      });
  }

  // Render the manifest + requested permissions for the DM to review.
  function _renderWizardPreview(p) {
    const m = p.manifest || {};
    const body = document.getElementById('addon-wizard-body');
    const foot = document.getElementById('addon-wizard-foot');
    const perms = Array.isArray(m.permissions) ? m.permissions : [];
    const permList = perms.length
      ? `<ul class="addon-perm-list">${perms.map(pr =>
          `<li><span>${esc(Addons.describePermission(pr))}</span> <code>${esc(pr)}</code></li>`).join('')}</ul>`
      : `<p class="settings-hint">${esc(I18n.t('settings.noSpecialPermissions'))}</p>`;
    const serverWarn = m.server
      ? `<div class="addon-perm-server">⚠ ${esc(I18n.t('settings.serverCodeWarn'))}</div>` : '';
    const errBox = p.ok ? ''
      : `<div class="addon-wizard-err" style="margin-top:.6rem">⚠ ${esc(I18n.t('settings.cannotInstall'))}: ${esc((p.errors || []).join('; '))}</div>`;
    if (body) body.innerHTML = `
      <div class="addon-preview">
        <div class="addon-preview-name">${esc(m.name || m.id || '?')}
          <span class="addon-row-ver">v${esc(m.version || '?')}</span></div>
        ${m.summary ? `<p class="settings-hint" style="margin:.3rem 0 .6rem">${esc(m.summary)}</p>` : ''}
        <div class="addon-perm-title">${esc(I18n.t('settings.addonRequestsPermissions'))}</div>
        ${permList}
        ${serverWarn}
        ${errBox}
      </div>
      <div class="addon-wizard-status" id="addon-wizard-status"></div>`;
    const confirmLabel = _wizardMode === 'update' ? `🔄 ${I18n.t('settings.update')}` : I18n.t('settings.installAndEnable');
    if (foot) foot.innerHTML = `
      <button type="button" class="inline-create-btn"
        ${dataAction('Settings.closeAddonWizard')}>${esc(I18n.t('action.cancel'))}</button>
      ${p.ok ? `<button type="button" class="edit-save-btn" id="addon-wizard-confirm"
        ${dataAction('Settings.confirmInstallAddon')}>${esc(confirmLabel)}</button>` : ''}`;
  }

  // Step 2 — backup → install/update the reviewed commit (sha-pinned; ref kept
  // for future update checks). The server runs the addon's server self-tests as
  // a green-gate during install (Phase 8) — a red set surfaces here as an error.
  function confirmInstallAddon() {
    if (!_wizardPreview) return;
    const go = document.getElementById('addon-wizard-confirm');
    if (go) go.disabled = true;
    const verb = _wizardMode === 'update' ? I18n.t('settings.wizardUpdating') : I18n.t('settings.wizardInstalling');
    _wizardStatus(`<span class="addon-wizard-busy">⏳ ${esc(I18n.t('settings.wizardCreatingBackup'))}</span>`);
    // Backup step: snapshot the dataset (incl. the addon registry) BEFORE the
    // change, so the install/update is one-click revertible from Záloha. Best-
    // effort — a snapshot failure doesn't block the install.
    fetch('/api/snapshots', { method: 'POST', credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : {}).catch(() => ({}))
      .then(snap => {
        const backupNote = (snap && snap.id) ? `✓ ${I18n.t('settings.wizardBackupNote')} · ` : '';
        _wizardStatus(`<span class="addon-wizard-busy">${esc(backupNote)}⏳ ${esc(verb)}…</span>`);
        return fetch('/api/addons/install', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: _wizardPreview.repo, ref: _wizardPreview.ref, sha: _wizardPreview.sha }),
        })
          .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
          .then(j => ({ j, backupNote }));
      })
      .then(({ j, backupNote }) => {
        const a = j.addon || {};
        const done = _wizardMode === 'update' ? I18n.t('settings.wizardUpdated') : I18n.t('settings.wizardInstalled');
        _wizardStatus(`<span class="addon-wizard-ok">${esc(backupNote)}✓ ${esc(done)}: <strong>${esc(a.id || '')}</strong> v${esc(a.version || '')}.</span>`);
        const foot = document.getElementById('addon-wizard-foot');
        if (foot) foot.innerHTML = `<button type="button" class="edit-save-btn" ${dataAction('Settings.closeAddonWizard')}>${esc(I18n.t('settings.done'))}</button>`;
        _flash(_wizardMode === 'update' ? I18n.t('settings.addonUpdated') : I18n.t('settings.addonInstalled'));
        _addonUpdates = {};   // stale after a change — a fresh check is needed
        // Refresh the list behind the modal; the addons-changed SSE event also
        // live-loads/reconciles via Addons.reconcile() in app.js.
        _reloadAddonsIfActive();
      })
      .catch(e => {
        if (go) go.disabled = false;
        _wizardStatus(`<span class="addon-wizard-err">${esc((e && e.error) || I18n.t('settings.installFailed'))}</span>`);
      });
  }

  return {
    render,
    selectCategory, startNew, startEdit, cancelEdit,
    commit, requestDelete, commitDelete, closeModal,
    resetDefaults,
    uploadWorldMap,
    renameMapView, deleteMapView,
    applySidebarVisibility,
    refreshSnapshots, createSnapshot, restoreSnapshot,
    deleteSnapshot, revertLastN, uploadRestore,
    toggleIconPanel, setIconStrategy,
    uploadIconFiles, deleteIconFile,
    updateStrengthReadout,
    selectMap, uploadSubMap,
    updateMapZoomRatioReadout, commitMapZoomRatio,
    isPendingSelfCommit,
    logout,
    changePassword,
    previewDefaultIcon,
    savePlayerParty,
    uploadLogo, deleteLogo, saveBranding, applyBranding,
    changeTheme, applyTheme,
    enableAddon, disableAddon, removeAddon, resolveAddonConflict,
    checkAddonUpdates, updateAddon, updateAllAddons, rollbackAddon, restartServer,
    openAddonWizard, closeAddonWizard, addonWizardKey,
    previewAddon, confirmInstallAddon,
  };
})();
