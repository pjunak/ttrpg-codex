// ═══════════════════════════════════════════════════════════════
//  WIDGETS — auto-mounting Combobox + MultiSelect.
//
//  Usage in HTML strings:
//    Single-select  →  <div class="cb-mount" data-cb-id="..." data-cb-source="character" data-cb-value="..."></div>
//    Multi-select   →  <div id="some-id" class="ms-mount" data-ms-source="character" data-ms-value="id1,id2"></div>
//
//  After any DOM update, call Widgets.mountAll(rootEl?) to initialize
//  every unmounted placeholder. Already-mounted ones are skipped.
//
//  Compatibility shims so existing form-read code keeps working:
//    Combobox creates a hidden <input type="hidden" id={data-cb-id}> with
//      .value matching the current selection. saveX() calls
//      document.getElementById(id).value as before.
//    MultiSelect uses the placeholder's own id as the queryable container.
//      Inside it, hidden <input type="checkbox" checked value=...> elements
//      are kept in sync with selection so _checkVals(containerId) works.
// ═══════════════════════════════════════════════════════════════

import { Store } from '../store.js';
import { esc, norm, debounce } from '../utils.js';
import { TagFilter } from './tagfilter.js';
import { I18n } from '../i18n.js';

// ── Outside-click tracking ──────────────────────────────────────
// Every Combobox/MultiSelect needs to close when the user clicks
// outside of it. Originally each mount added its own
// `document.addEventListener('mousedown', …)` — that never got
// removed, so navigating between pages leaked hundreds of listeners.
// One module-level listener dispatches to every open widget via a
// Set-tracked registry instead.
const _openWidgets = new Set();
function _registerOpen(el)   { _openWidgets.add(el); }
function _unregisterOpen(el) { _openWidgets.delete(el); }
document.addEventListener('mousedown', (e) => {
  if (_openWidgets.size === 0) return;
  for (const el of [..._openWidgets]) {
    if (!el.isConnected) { _openWidgets.delete(el); continue; }
    if (!el.contains(e.target) && typeof el._closePop === 'function') {
      el._closePop();
    }
  }
});

// ── Source resolvers ────────────────────────────────────────────
// Each returns an array of {value, label, badge?, color?, sublabel?}.
// Sorting matches the existing UX (faction badge prefix, faction order,
// then alphabetical by Czech locale).
function _factionOrder() {
  return Object.keys(Store.getFactions());
}
function _sortChars(chars) {
  const order = _factionOrder();
  return [...chars].sort((a, b) => {
    const ia = order.indexOf(a.faction); const ib = order.indexOf(b.faction);
    const fa = ia < 0 ? 999 : ia; const fb = ib < 0 ? 999 : ib;
    if (fa !== fb) return fa - fb;
    return (a.name || '').localeCompare(b.name || '', 'cs');
  });
}
function _charOption(c) {
  const f = Store.getFactions()[c.faction] || {};
  return {
    value:    c.id,
    label:    c.name || c.id,
    badge:    f.badge || '',
    color:    f.color || '',
    sublabel: c.title || '',
  };
}
function _locOption(l) {
  return { value: l.id, label: l.name || l.id, sublabel: l.type || '' };
}

const SOURCES = {
  character: (excludeId) => {
    const all = Store.getCharacters().filter(c => !excludeId || c.id !== excludeId);
    return _sortChars(all).map(_charOption);
  },
  location: () => Store.getLocations().map(_locOption),
};

function _resolveOptions(source, excludeId) {
  const fn = SOURCES[source];
  return fn ? fn(excludeId) : [];
}

// ── Inline create — minimal-fields entity creation from picker UI ──
// Returns the new entity's id, or null on failure.
function _createInline(source, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const id = Store.generateId(trimmed);
  if (source === 'character') {
    const ok = Store.saveCharacter({
      id, name: trimmed,
      faction: 'neutral', status: 'alive', knowledge: 3,
      title: '', description: '', portrait: '',
      known: [], unknown: [], tags: [],
    });
    return ok === false ? null : id;
  }
  if (source === 'location') {
    Store.saveLocation({
      id, name: trimmed,
      type: '', status: '', description: '', notes: '', characters: [],
    });
    return id;
  }
  return null;
}

// Returns the i18n key for the entity-kind noun used in the inline
// "Create {kind} «typed»" option (resolved via I18n.t at render time).
function _createKindLabel(source) {
  if (source === 'location') return 'widget.kindLocation';
  return 'widget.kindCharacter';
}

// ── Combobox (single-select, searchable) ────────────────────────
function _mountCombobox(el) {
  if (el.dataset.mounted === '1') return;
  el.dataset.mounted = '1';

  const hiddenId  = el.dataset.cbId || ('cb_' + Math.random().toString(36).slice(2));
  const source    = el.dataset.cbSource || 'character';
  const excludeId = el.dataset.cbExclude || '';
  const placeholder = el.dataset.cbPlaceholder || I18n.t('widget.selectPlaceholder');
  const allowEmpty  = el.dataset.cbAllowEmpty === '1';
  const emptyLabel  = el.dataset.cbEmptyLabel || I18n.t('widget.emptyOption');
  const onCreate  = el.dataset.cbOnCreate || ''; // 'character' | 'location' | ''

  let options = _resolveOptions(source, excludeId);
  if (allowEmpty) options = [{ value: '', label: emptyLabel }, ...options];

  let value = el.dataset.cbValue || '';
  let open  = false;
  let highlight = -1;
  let filterText = '';

  el.classList.add('w-cb');
  el.innerHTML = `
    <input type="hidden" id="${esc(hiddenId)}" value="${esc(value)}">
    <button type="button" class="w-cb-trigger" tabindex="0">
      <span class="w-cb-trigger-label"></span>
      <span class="w-cb-caret">▾</span>
    </button>
    <div class="w-cb-pop" hidden>
      <input type="text" class="w-cb-search" placeholder="${esc(placeholder)}" autocomplete="off">
      <div class="w-cb-list" role="listbox"></div>
    </div>`;

  const hidden  = el.querySelector('input[type="hidden"]');
  const trigger = el.querySelector('.w-cb-trigger');
  const labelEl = el.querySelector('.w-cb-trigger-label');
  const pop     = el.querySelector('.w-cb-pop');
  const search  = el.querySelector('.w-cb-search');
  const listEl  = el.querySelector('.w-cb-list');

  function _byVal(v) { return options.find(o => o.value === v) || null; }
  function _renderTrigger() {
    const opt = _byVal(value);
    if (!opt) {
      labelEl.innerHTML = `<span class="w-cb-empty">${esc(placeholder)}</span>`;
      return;
    }
    const badge = opt.badge ? `<span class="w-cb-badge">${esc(opt.badge)}</span>` : '';
    labelEl.innerHTML = badge + esc(opt.label);
  }
  function _filtered() {
    const q = norm(filterText);
    if (!q) return options;
    return options.filter(o =>
      norm(o.label).includes(q) || norm(o.sublabel || '').includes(q)
    );
  }
  function _createRowHtml() {
    const typed = filterText.trim();
    if (!onCreate || !typed) return '';
    const q = norm(typed);
    const exact = options.some(o => norm(o.label) === q);
    if (exact) return '';
    const kind = _createKindLabel(onCreate);
    return `<div class="w-cb-create" data-create="${esc(typed)}" role="option">
      ${esc(I18n.t('widget.createOption', { kind: I18n.t(kind), typed }))}
    </div>`;
  }
  function _renderList() {
    const items = _filtered();
    const createRow = _createRowHtml();
    if (!items.length && !createRow) {
      listEl.innerHTML = `<div class="w-cb-empty-row">${esc(I18n.t('widget.noResults'))}</div>`;
      return;
    }
    listEl.innerHTML = items.map((o, i) => {
      const sel  = o.value === value ? ' is-selected' : '';
      const hi   = i === highlight ? ' is-active' : '';
      const badge = o.badge ? `<span class="w-cb-badge">${esc(o.badge)}</span>` : '';
      const sub   = o.sublabel ? `<span class="w-cb-sub">${esc(o.sublabel)}</span>` : '';
      return `<div class="w-cb-item${sel}${hi}" data-val="${esc(o.value)}" role="option">
        ${badge}<span class="w-cb-lbl">${esc(o.label)}</span>${sub}
      </div>`;
    }).join('') + createRow;
  }
  function _doCreate(typedName) {
    const newId = _createInline(onCreate, typedName);
    if (!newId) return;
    // Refresh option list to include the new entity (preserve allowEmpty prefix)
    options = _resolveOptions(source, excludeId);
    if (allowEmpty) options = [{ value: '', label: emptyLabel }, ...options];
    _select(newId);
  }
  function _openPop() {
    if (open) return;
    open = true;
    highlight = Math.max(0, _filtered().findIndex(o => o.value === value));
    pop.hidden = false;
    el.classList.add('is-open');
    _registerOpen(el);
    _renderList();
    setTimeout(() => search.focus(), 0);
  }
  function _closePop() {
    if (!open) return;
    open = false;
    pop.hidden = true;
    el.classList.remove('is-open');
    filterText = '';
    search.value = '';
    _unregisterOpen(el);
  }
  el._closePop = _closePop;
  function _select(v) {
    value = v;
    hidden.value = v;
    _renderTrigger();
    _closePop();
    el.dispatchEvent(new CustomEvent('w-cb-change', { detail: { value: v }, bubbles: true }));
  }

  trigger.addEventListener('click', () => open ? _closePop() : _openPop());
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault(); _openPop();
    }
  });
  search.addEventListener('input', debounce(() => {
    filterText = search.value;
    highlight = 0;
    _renderList();
  }, 80));
  search.addEventListener('keydown', (e) => {
    const items = _filtered();
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight = Math.min(items.length - 1, highlight + 1); _renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight = Math.max(0, highlight - 1); _renderList(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = items[highlight];
      if (pick) { _select(pick.value); return; }
      // No match highlighted — try inline create if enabled and text typed
      if (onCreate && filterText.trim()) _doCreate(filterText.trim());
    }
    else if (e.key === 'Escape') { e.preventDefault(); _closePop(); trigger.focus(); }
  });
  listEl.addEventListener('mousedown', (e) => {
    const create = e.target.closest('.w-cb-create');
    if (create) {
      e.preventDefault();
      _doCreate(create.dataset.create);
      return;
    }
    const item = e.target.closest('.w-cb-item');
    if (!item) return;
    e.preventDefault();
    _select(item.dataset.val);
  });

  // Public API attached to the element so callers can re-source / re-set value
  el._combobox = {
    setValue(v) { _select(v); },
    getValue()  { return value; },
    setSource(newSource, newExclude) {
      options = _resolveOptions(newSource, newExclude || '');
      if (allowEmpty) options = [{ value: '', label: emptyLabel }, ...options];
      if (!_byVal(value)) value = ''; // value no longer in options
      hidden.value = value;
      _renderTrigger();
      if (open) _renderList();
    },
    refresh() {
      options = _resolveOptions(source, excludeId);
      if (allowEmpty) options = [{ value: '', label: emptyLabel }, ...options];
      _renderTrigger();
      if (open) _renderList();
    },
  };

  _renderTrigger();
}

// ── MultiSelect (chip-based, searchable) ────────────────────────
function _mountMultiSelect(el) {
  if (el.dataset.mounted === '1') return;
  el.dataset.mounted = '1';

  const source      = el.dataset.msSource || 'character';
  const placeholder = el.dataset.msPlaceholder || I18n.t('search.placeholder');
  const onCreate    = el.dataset.msOnCreate || ''; // 'character' | 'location' | ''
  const initial     = (el.dataset.msValue || '').split(',').map(s => s.trim()).filter(Boolean);

  let options = _resolveOptions(source, '');
  const selected = new Set(initial.filter(v => options.some(o => o.value === v)));
  // Ids the viewer can't resolve into an option — e.g. DM-only entities
  // filtered out of a player's dataset. They render no chip but MUST
  // round-trip through the hidden checkboxes: dropping them meant a
  // player save silently stripped the DM's links from the record.
  // (The single-select Combobox already preserves unknown values.)
  let passthrough = initial.filter(v => !options.some(o => o.value === v));

  let open = false;
  let highlight = -1;
  let filterText = '';

  el.classList.add('w-ms');
  el.innerHTML = `
    <div class="w-ms-chips"></div>
    <div class="w-ms-input-row">
      <input type="text" class="w-ms-search" placeholder="${esc(placeholder)}" autocomplete="off">
    </div>
    <div class="w-ms-pop" hidden>
      <div class="w-ms-list" role="listbox"></div>
    </div>
    <div class="w-ms-hidden" hidden></div>`;

  const chipsEl  = el.querySelector('.w-ms-chips');
  const search   = el.querySelector('.w-ms-search');
  const pop      = el.querySelector('.w-ms-pop');
  const listEl   = el.querySelector('.w-ms-list');
  const hiddenEl = el.querySelector('.w-ms-hidden');

  function _byVal(v) { return options.find(o => o.value === v); }
  function _renderHidden() {
    // Hidden checkboxes inside the placeholder's own id container —
    // keeps existing _checkVals(containerId) reads working. Passthrough
    // ids ride along so saves can't strip them.
    hiddenEl.innerHTML = [...passthrough, ...selected].map(v =>
      `<input type="checkbox" value="${esc(v)}" checked>`
    ).join('');
  }
  function _renderChips() {
    if (!selected.size) {
      chipsEl.innerHTML = `<span class="w-ms-chips-empty">${esc(I18n.t('widget.emptyOption'))}</span>`;
      return;
    }
    chipsEl.innerHTML = [...selected].map(v => {
      const o = _byVal(v);
      if (!o) return '';
      const badge = o.badge ? `<span class="w-ms-chip-badge">${esc(o.badge)}</span>` : '';
      return `<span class="w-ms-chip" data-val="${esc(v)}">
        ${badge}${esc(o.label)}
        <button type="button" class="w-ms-chip-x" title="${esc(I18n.t('action.remove'))}">×</button>
      </span>`;
    }).join('');
  }
  function _filtered() {
    const q = norm(filterText);
    let list = options;
    if (q) list = list.filter(o => norm(o.label).includes(q) || norm(o.sublabel || '').includes(q));
    return list;
  }
  function _createRowHtml() {
    const typed = filterText.trim();
    if (!onCreate || !typed) return '';
    const q = norm(typed);
    const exact = options.some(o => norm(o.label) === q);
    if (exact) return '';
    const kind = _createKindLabel(onCreate);
    return `<div class="w-ms-create" data-create="${esc(typed)}" role="option">
      ${esc(I18n.t('widget.createOption', { kind: I18n.t(kind), typed }))}
    </div>`;
  }
  function _renderList() {
    const items = _filtered();
    const createRow = _createRowHtml();
    if (!items.length && !createRow) {
      listEl.innerHTML = `<div class="w-ms-empty-row">${esc(I18n.t('widget.noResults'))}</div>`;
      return;
    }
    listEl.innerHTML = items.map((o, i) => {
      const sel = selected.has(o.value);
      const hi  = i === highlight;
      const badge = o.badge ? `<span class="w-ms-badge">${esc(o.badge)}</span>` : '';
      const check = sel ? '✓ ' : '';
      const sub   = o.sublabel ? `<span class="w-ms-sub">${esc(o.sublabel)}</span>` : '';
      return `<div class="w-ms-item${sel ? ' is-selected' : ''}${hi ? ' is-active' : ''}"
        data-val="${esc(o.value)}" role="option">
        <span class="w-ms-check">${check}</span>${badge}<span class="w-ms-lbl">${esc(o.label)}</span>${sub}
      </div>`;
    }).join('') + createRow;
  }
  function _doCreate(typedName) {
    const newId = _createInline(onCreate, typedName);
    if (!newId) return;
    options = _resolveOptions(source, '');
    selected.add(newId);
    search.value = '';
    filterText = '';
    _renderChips();
    _renderHidden();
    _renderList();
    el.dispatchEvent(new CustomEvent('w-ms-change', { detail: { value: [...selected] }, bubbles: true }));
  }
  function _openPop() {
    if (open) return;
    open = true;
    pop.hidden = false;
    el.classList.add('is-open');
    highlight = 0;
    _registerOpen(el);
    _renderList();
  }
  function _closePop() {
    if (!open) return;
    open = false;
    pop.hidden = true;
    el.classList.remove('is-open');
    _unregisterOpen(el);
  }
  el._closePop = _closePop;
  function _toggle(v) {
    if (selected.has(v)) selected.delete(v); else selected.add(v);
    _renderChips();
    _renderHidden();
    _renderList();
    el.dispatchEvent(new CustomEvent('w-ms-change', { detail: { value: [...selected] }, bubbles: true }));
  }

  search.addEventListener('focus', _openPop);
  search.addEventListener('input', debounce(() => {
    filterText = search.value;
    highlight = 0;
    _openPop();
    _renderList();
  }, 80));
  search.addEventListener('keydown', (e) => {
    const items = _filtered();
    if (e.key === 'ArrowDown') { e.preventDefault(); _openPop(); highlight = Math.min(items.length - 1, highlight + 1); _renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight = Math.max(0, highlight - 1); _renderList(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = items[highlight];
      if (pick) { _toggle(pick.value); search.value = ''; filterText = ''; _renderList(); return; }
      if (onCreate && filterText.trim()) _doCreate(filterText.trim());
    }
    else if (e.key === 'Escape') { e.preventDefault(); _closePop(); }
    else if (e.key === 'Backspace' && !search.value && selected.size) {
      const last = [...selected].pop();
      _toggle(last);
    }
  });
  listEl.addEventListener('mousedown', (e) => {
    const create = e.target.closest('.w-ms-create');
    if (create) {
      e.preventDefault();
      _doCreate(create.dataset.create);
      search.focus();
      return;
    }
    const item = e.target.closest('.w-ms-item');
    if (!item) return;
    e.preventDefault();
    _toggle(item.dataset.val);
    search.focus();
  });
  chipsEl.addEventListener('click', (e) => {
    const x = e.target.closest('.w-ms-chip-x');
    if (!x) return;
    const chip = x.closest('.w-ms-chip');
    if (chip) _toggle(chip.dataset.val);
  });

  el._multiselect = {
    // getValue includes passthrough ids so a getValue→merge→setValue
    // round-trip (e.g. EditMode.addPartyToEvent) can't drop them.
    getValue() { return [...passthrough, ...selected]; },
    setValue(arr) {
      selected.clear();
      passthrough = (arr || []).filter(v => !_byVal(v));
      (arr || []).forEach(v => { if (_byVal(v)) selected.add(v); });
      _renderChips(); _renderHidden();
    },
  };

  _renderChips();
  _renderHidden();
}

// ── Public mounting API ─────────────────────────────────────────
function mountAll(root) {
  const r = root || document.body;
  r.querySelectorAll('.cb-mount').forEach(_mountCombobox);
  r.querySelectorAll('.ms-mount').forEach(_mountMultiSelect);
  TagFilter.mountAll(r);
}

export const Widgets = { mountAll };
