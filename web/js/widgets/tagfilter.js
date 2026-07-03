// ═══════════════════════════════════════════════════════════════
//  TAG FILTER — search input + removable chip filters.
//  Type a term, press Enter to commit it as a chip. Click × to
//  remove. Combine with AND. Consumers listen for 'tf-change' and
//  run their own matching — this widget is purely presentational.
//
//  Mount via <div class="tf-mount" data-tf-id="…" …>.
//  Read current values with el._tagfilter.getValues() or from the
//  hidden input <input type="hidden" id="{data-tf-id}" value="a,b">.
// ═══════════════════════════════════════════════════════════════

import { esc, norm } from '../utils.js';
import { I18n } from '../i18n.js';

function _emitChange(el, values) {
  const hid = el.querySelector('input[type="hidden"]');
  if (hid) hid.value = values.join(',');
  el.dispatchEvent(new CustomEvent('tf-change', {
    detail: { values: [...values] },
    bubbles: true,
  }));
}

function _mount(el) {
  if (el.dataset.mounted === '1') return;
  el.dataset.mounted = '1';

  const hiddenId   = el.dataset.tfId || ('tf_' + Math.random().toString(36).slice(2));
  const placeholder = el.dataset.tfPlaceholder || I18n.t('widget.tagfilterPlaceholder');
  const hintText   = el.dataset.tfHint || '';
  const initial    = (el.dataset.tfValue || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const values = [];
  initial.forEach(v => { if (!values.some(x => norm(x) === norm(v))) values.push(v); });

  el.classList.add('w-tf');
  el.innerHTML = `
    <input type="hidden" id="${esc(hiddenId)}" value="${esc(values.join(','))}">
    <div class="w-tf-row">
      <div class="w-tf-chips" role="list"></div>
      <input type="text" class="w-tf-input" placeholder="${esc(placeholder)}" autocomplete="off">
    </div>
    ${hintText ? `<div class="w-tf-hint">${esc(hintText)}</div>` : ''}`;

  const chipsEl = el.querySelector('.w-tf-chips');
  const input   = el.querySelector('.w-tf-input');

  function _renderChips() {
    if (!values.length) { chipsEl.innerHTML = ''; return; }
    chipsEl.innerHTML = values.map((v, i) =>
      `<span class="w-tf-chip" role="listitem">
        ${esc(v)}
        <button type="button" class="w-tf-chip-x" data-i="${i}" title="${esc(I18n.t('action.remove'))}">×</button>
      </span>`).join('');
  }
  function _add(raw) {
    const v = String(raw || '').trim();
    if (!v) return;
    if (values.some(x => norm(x) === norm(v))) return;
    values.push(v);
    _renderChips();
    _emitChange(el, values);
  }
  function _removeAt(i) {
    if (i < 0 || i >= values.length) return;
    values.splice(i, 1);
    _renderChips();
    _emitChange(el, values);
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _add(input.value);
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value && values.length) {
      _removeAt(values.length - 1);
    }
  });
  input.addEventListener('blur', () => {
    // Commit on blur so half-typed words aren't lost
    if (input.value.trim()) { _add(input.value); input.value = ''; }
  });
  chipsEl.addEventListener('click', e => {
    const x = e.target.closest('.w-tf-chip-x');
    if (!x) return;
    _removeAt(parseInt(x.dataset.i, 10));
  });

  // Imperative API for consumers (CloudMap, Wiki lists, map search…)
  el._tagfilter = {
    getValues() { return [...values]; },
    setValues(arr) {
      values.length = 0;
      (arr || []).forEach(v => {
        const s = String(v || '').trim();
        if (s && !values.some(x => norm(x) === norm(s))) values.push(s);
      });
      _renderChips();
      _emitChange(el, values);
    },
    clear() { this.setValues([]); },
    focusInput() { input.focus(); },
  };

  _renderChips();
}

export const TagFilter = {
  mountAll(root) {
    const r = root || document.body;
    r.querySelectorAll('.tf-mount').forEach(_mount);
  },
};
