// ═══════════════════════════════════════════════════════════════
//  EDIT MODE — inline editing overlay for the wiki
//  Toggled by the ✏ button. When active, article pages render
//  edit forms instead of read-only views, and list pages show
//  "+ New" cards and pencil overlays on existing items.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { EditTemplates } from './edit_templates.js';
import { Widgets } from './widgets/widgets.js';
import { PIN_TYPES, PIN_SIZE_MIN, PIN_SIZE_MAX, PIN_SIZE_DEFAULT } from './map.js';
import { renderMarkdown } from './utils.js';
import { PARTY_FACTION_ID } from './constants.js';

export const EditMode = (() => {

  let _active = false;

  // ── Prefill state for new-entity creation ──────────────────────
  // Set by startNewCharacter / startNewLocation / startNewEvent and
  // consumed once by the corresponding renderXxxEditor(null). Lets
  // "+ Nová postava ve frakci" (and similar) pre-fill context fields
  // instead of sending the user to a blank form.
  let _prefill = { character: null, location: null, event: null,
                   species: null, buh: null, artifact: null,
                   historicalEvent: null };
  function _consumePrefill(kind) {
    const p = _prefill[kind];
    _prefill[kind] = null;
    return p || null;
  }

  // One-shot callbacks that run after a new entity has been saved.
  // Used by "+ Postava zde" to link the new character into the source
  // location's characters[] after the character is persisted.
  let _afterSave = { character: null, location: null, event: null };
  function _runAfterSave(kind, id) {
    const fn = _afterSave[kind];
    _afterSave[kind] = null;
    if (typeof fn === 'function') {
      try { fn(id); } catch (e) { console.warn(e); }
    }
  }

  // ── Toast ──────────────────────────────────────────────────────
  // Supports an optional `opts.action = { label, onClick }` for undo-
  // style buttons. When an action is present the toast stays up for
  // `opts.timeout` ms (default 8s) so the user has time to react.
  function _toast(msg, ok = true, opts = {}) {
    let t = document.getElementById("edit-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "edit-toast";
      document.body.appendChild(t);
    }
    const timeout = opts.timeout ?? (opts.action ? 8000 : 2500);
    t.innerHTML = '';
    const textEl = document.createElement('span');
    textEl.className = 'edit-toast-msg';
    textEl.textContent = msg;
    t.appendChild(textEl);
    if (opts.action && typeof opts.action.onClick === 'function') {
      const btn = document.createElement('button');
      btn.className = 'edit-toast-action';
      btn.type = 'button';
      btn.textContent = opts.action.label || '↶ Vrátit';
      btn.addEventListener('click', () => {
        try { opts.action.onClick(); } finally { t.classList.remove('show'); }
      });
      t.appendChild(btn);
    }
    t.className = "edit-toast show " + (ok ? "ok" : "err");
    clearTimeout(t._tid);
    t._tid = setTimeout(() => t.classList.remove("show"), timeout);
  }

  // ── Drafts & dirty-state guard ────────────────────────────────
  // Every `.md-easy` textarea autosaves its markdown to localStorage
  // on change (debounced 500ms + flushed on pagehide). If a draft is
  // found on mount that differs from the loaded entity content, a
  // banner above the editor offers [Obnovit koncept] / [Zahodit].
  // Drafts are scoped per-textarea-id, so switching entities doesn't
  // cross-contaminate. Successful save → _markClean() clears the
  // dirty flag and removes drafts for every currently-mounted editor.
  // Unguarded close/refresh triggers a browser beforeunload prompt;
  // internal link clicks go through a capture listener that confirms
  // if dirty.
  const DRAFT_PREFIX  = 'md_draft:';
  const DRAFT_DEBOUNCE_MS = 500;
  const DRAFT_TTL_MS  = 30 * 24 * 60 * 60 * 1000;  // 30 days
  let   _dirty        = false;
  const _draftTimers  = new Map();    // textareaId → setTimeout id

  function _draftKey(textareaId) { return DRAFT_PREFIX + textareaId; }

  function _loadDraft(textareaId) {
    try {
      const raw = localStorage.getItem(_draftKey(textareaId));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.content !== 'string') return null;
      if (obj.savedAt && Date.now() - obj.savedAt > DRAFT_TTL_MS) {
        localStorage.removeItem(_draftKey(textareaId));
        return null;
      }
      return obj;
    } catch { return null; }
  }

  function _saveDraft(textareaId, content) {
    try {
      localStorage.setItem(_draftKey(textareaId), JSON.stringify({
        content, savedAt: Date.now(),
      }));
    } catch (_) { /* quota / disabled */ }
  }

  function _clearDraft(textareaId) {
    try { localStorage.removeItem(_draftKey(textareaId)); } catch (_) {}
  }

  // Flush any pending debounced saves to localStorage. Called from
  // pagehide so the last keystrokes aren't lost on tab close.
  function _flushAllDrafts() {
    for (const [id, timer] of _draftTimers) {
      clearTimeout(timer);
      const ta = document.getElementById(id);
      if (ta && ta.classList.contains('md-easy')) {
        _saveDraft(id, ta.value || '');
      }
    }
    _draftTimers.clear();
  }

  // Called by each save*() at the end of a successful Store.saveXxx.
  // Clears dirty flag and wipes drafts for every currently-mounted
  // editor — once saved, the entity's content matches the draft.
  function _markClean() {
    const wasDirty = _dirty;
    _dirty = false;
    document.querySelectorAll('textarea.md-easy').forEach(ta => {
      if (ta.id) _clearDraft(ta.id);
    });
    if (wasDirty) window.dispatchEvent(new CustomEvent('editmode:clean'));
  }

  function _setDirty() {
    if (_dirty) return;
    _dirty = true;
    window.dispatchEvent(new CustomEvent('editmode:dirty'));
  }

  function isDirty() { return _dirty; }

  function _showDraftBanner(textarea, draft, mde) {
    // Place banner directly above the EasyMDE wrapper so it's visually
    // attached to this specific editor (multi-editor forms possible).
    const host = textarea.closest('.EasyMDEContainer')?.parentElement || textarea.parentElement;
    if (!host || host.querySelector(`.md-draft-banner[data-for="${textarea.id}"]`)) return;
    const when = new Date(draft.savedAt || Date.now()).toLocaleString('cs-CZ', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const banner = document.createElement('div');
    banner.className = 'md-draft-banner';
    banner.setAttribute('data-for', textarea.id);
    banner.innerHTML = `
      <span class="md-draft-banner-icon">💾</span>
      <span class="md-draft-banner-text">Nalezen nedokončený koncept z ${when}. Obnovit?</span>
      <button type="button" class="md-draft-btn md-draft-btn-restore">Obnovit</button>
      <button type="button" class="md-draft-btn md-draft-btn-discard">Zahodit</button>
    `;
    banner.querySelector('.md-draft-btn-restore').addEventListener('click', () => {
      if (mde && typeof mde.value === 'function') mde.value(draft.content);
      else textarea.value = draft.content;
      _setDirty();   // restoring a draft counts as unsaved edits
      banner.remove();
    });
    banner.querySelector('.md-draft-btn-discard').addEventListener('click', () => {
      _clearDraft(textarea.id);
      banner.remove();
    });
    host.insertBefore(banner, host.firstChild);
  }

  function _wireEasyMDEDraft(mde, textarea) {
    // Autosave on change, flush on pagehide, offer restore banner when
    // a stored draft differs from the loaded content.
    const id = textarea.id;
    if (!id) return;

    // 1) Restore banner if a draft exists and differs from current value.
    const draft = _loadDraft(id);
    if (draft && draft.content !== (textarea.value || '')) {
      _showDraftBanner(textarea, draft, mde);
    } else if (draft) {
      // Draft matches current content — stale, auto-clean.
      _clearDraft(id);
    }

    // 2) Autosave on every CodeMirror change.
    try {
      mde.codemirror.on('change', () => {
        _setDirty();
        clearTimeout(_draftTimers.get(id));
        _draftTimers.set(id, setTimeout(() => {
          const ta = document.getElementById(id);
          if (ta) _saveDraft(id, ta.value || '');
        }, DRAFT_DEBOUNCE_MS));
      });
    } catch (_) { /* older EasyMDE API */ }
  }

  // Dirty on any input/change inside an .edit-form (covers non-MD fields).
  document.addEventListener('input', (e) => {
    if (e.target.closest && e.target.closest('.edit-form')) _setDirty();
  }, true);
  document.addEventListener('change', (e) => {
    if (e.target.closest && e.target.closest('.edit-form')) _setDirty();
  }, true);

  // Warn if the user tries to close/refresh the tab with unsaved edits.
  window.addEventListener('beforeunload', (e) => {
    if (_dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // Flush pending autosaves on close. pagehide fires reliably even when
  // beforeunload is bypassed (mobile back, tab discard).
  window.addEventListener('pagehide', _flushAllDrafts);

  // Intercept link clicks for in-app navigation (SPA hash routes).
  // hashchange itself is non-cancelable, so we guard at the click level.
  document.addEventListener('click', (e) => {
    if (!_dirty) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href^="#/"]') : null;
    if (!a) return;
    if (!confirm('Máš neuložené změny. Opravdu opustit stránku?')) {
      e.preventDefault();
      e.stopPropagation();
    } else {
      _dirty = false;
    }
  }, true);

  // ── Navigate to `hash` and force a re-render. ──────────────────
  // If the hash is already current, hashchange wouldn't fire and the
  // page would stay rendered with stale data — dispatch a synthetic
  // hashchange in that case. Otherwise just set the hash and let the
  // browser fire the event naturally.
  function _refreshTo(hash) {
    if (window.location.hash === hash) {
      window.dispatchEvent(new Event("hashchange"));
    } else {
      window.location.hash = hash;
    }
  }

  // ── Password prompt modal ─────────────────────────────────────
  // Replaces the native `prompt()` for the edit-mode unlock flow:
  //   - works on mobile (native prompt suppressed in some browsers),
  //   - lets password managers autofill (input is type="password"
  //     with name=password + autocomplete="current-password"),
  //   - has a 👁 visibility toggle.
  // Returns a Promise that resolves to the typed string on submit
  // and `null` on cancel/Esc/backdrop click.
  function _passwordPrompt(message) {
    return new Promise(resolve => {
      let settled = false;
      const finish = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };

      const overlay = document.createElement('div');
      overlay.className = 'pw-modal';
      overlay.innerHTML = `
        <div class="pw-backdrop"></div>
        <form class="pw-panel" autocomplete="on">
          <div class="pw-title">${message || 'Tato sekce je zabezpečena. Zadej heslo:'}</div>
          <div class="pw-row">
            <input class="pw-input" type="password" name="password"
                   autocomplete="current-password" autofocus
                   spellcheck="false" autocapitalize="off">
            <button type="button" class="pw-toggle" aria-label="Zobrazit heslo">👁</button>
          </div>
          <div class="pw-actions">
            <button type="button" class="pw-btn pw-cancel">Zrušit</button>
            <button type="submit" class="pw-btn pw-ok">Odemknout</button>
          </div>
        </form>
      `;
      document.body.appendChild(overlay);

      const form  = overlay.querySelector('.pw-panel');
      const input = overlay.querySelector('.pw-input');
      const back  = overlay.querySelector('.pw-backdrop');
      const tog   = overlay.querySelector('.pw-toggle');
      const cnl   = overlay.querySelector('.pw-cancel');

      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
      }
      function cleanup() {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
      }
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        finish(input.value);
      });
      cnl.addEventListener('click', () => finish(null));
      back.addEventListener('click', () => finish(null));
      tog.addEventListener('click', () => {
        const isPwd = input.type === 'password';
        input.type = isPwd ? 'text' : 'password';
        tog.setAttribute('aria-label', isPwd ? 'Skrýt heslo' : 'Zobrazit heslo');
        input.focus();
      });
      document.addEventListener('keydown', onKey, true);
      // Focus after layout — autofocus alone misses on some mobile browsers.
      requestAnimationFrame(() => input.focus());
    });
  }

  // ── State ──────────────────────────────────────────────────────
  function isActive() { return _active; }

  async function toggle() {
    // Toggling re-renders the page (synthetic hashchange below) which
    // would silently lose any unsaved edits in the active form. Confirm
    // first if dirty so the user can cancel and save.
    if (_dirty && !confirm('Máš neuložené změny. Opravdu opustit režim úprav?')) {
      return;
    }

    if (!_active) {
      try {
        const check = await fetch('/api/auth');
        if (!check.ok) {
           const pwd = await _passwordPrompt('Tato sekce je zabezpečena. Zadej heslo:');
           if (pwd) {
             const res = await fetch('/api/login', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ password: pwd })
             });
             if (!res.ok) {
                _toast("Špatné heslo", false);
                return;
             }
             _toast("Přístup povolen ✓");
           } else {
             return;
           }
        }
      } catch(e) {
         console.warn(e);
      }
    }

    // Re-rendering replaces the form DOM, so dirty state is meaningless
    // beyond this point. Clear without firing events (the user already
    // confirmed; we don't want a "saved" indication).
    _dirty = false;
    _active = !_active;
    document.body.classList.toggle("edit-mode", _active);
    document.querySelectorAll(".edit-mode-toggle").forEach(btn => {
      const isBtn = btn.tagName === "BUTTON";
      if (isBtn) {
        btn.textContent = _active ? "✓ Hotovo" : "✏ Úpravy";
      } else {
        // bottom-item with icon + label spans
        const icon  = btn.querySelector(".bottom-icon");
        const label = btn.querySelector(".bottom-label");
        if (icon)  icon.textContent  = _active ? "✓" : "✏";
        if (label) label.textContent = _active ? "Hotovo" : "Úpravy";
      }
      btn.classList.toggle("active", _active);
    });
    // Re-render current page
    window.dispatchEvent(new Event("hashchange"));
  }

  // ── Dynamic fact rows ──────────────────────────────────────────
  function addDynRow(wrapperId) {
    const list = document.getElementById(wrapperId);
    if (!list) return;
    const div = document.createElement("div");
    div.innerHTML = EditTemplates.getDynRowHtml("");
    list.appendChild(div.firstElementChild);
    list.lastElementChild?.querySelector("input")?.focus();
  }

  // ── Helpers for the data-action dispatcher ─────────────────────
  // Replace inline DOM-manipulation handlers that used to live in
  // edit_templates.js as multi-statement `onclick="…"` strings.
  // Naming convention: same as the inline expression they superseded.
  function clearPortrait(uid, badge) {
    const preview = document.getElementById('ep-preview-' + uid);
    const hidden  = document.getElementById('ep-data-' + uid);
    if (preview) preview.innerHTML = `<span style="font-size:2.5rem">${badge || ''}</span>`;
    if (hidden)  hidden.value = '';
  }
  function updateKnowledgeLabel(uid) {
    const KNAMES = ["Neznámý","Tušený","Základní","Dobře znám","Plně zmapován"];
    const range = document.getElementById('ef-knowledge-' + uid);
    const label = document.getElementById('ef-kl-' + uid);
    if (!range || !label) return;
    const v = +range.value;
    label.textContent = `Znalost (${v}/4) — ${KNAMES[v]}`;
  }
  function handlePortraitChange(uid, el) {
    if (el?.files?.[0]) handlePortraitUpload(el, uid);
  }
  function handleLocalMapChange(locId, inputId, el) {
    if (el?.files?.[0]) uploadLocalMap(locId, el.files[0], inputId);
  }

  // ── Portrait upload ────────────────────────────────────────────
  async function handlePortraitUpload(input, uid) {
    const file = input.files[0];
    if (!file) return;
    try {
      _toast("Nahrávám obrázek…");
      // Always upload to a subfolder: data/portraits/{charId}/portrait.ext
      // New characters use "_new" as a temporary charId; the server migrates
      // the file to the real subfolder when the character is first saved.
      const charId = (uid && uid !== "new") ? uid : "_new";
      const url    = await Store.uploadPortrait(file, charId);
      const preview = document.getElementById("ep-preview-" + uid);
      const hidden  = document.getElementById("ep-data-" + uid);
      // Show with cache-buster, but store the clean URL (no ?v=) in data
      if (preview) preview.innerHTML = `<img src="${url}?v=${Date.now()}" style="width:100%;height:100%;object-fit:cover;object-position:top">`;
      if (hidden)  hidden.value = url;
      _toast("Obrázek nahrán ✓");
    } catch(e) {
      _toast("Chyba při nahrávání obrázku", false);
      console.error(e);
    }
  }

  // ── Gather helpers ─────────────────────────────────────────────
  function _dynVals(id) {
    return Array.from(document.querySelectorAll(`#${id} .edit-input`))
      .map(i => i.value.trim()).filter(Boolean);
  }
  function _checkVals(id) {
    return Array.from(document.querySelectorAll(`#${id} input[type="checkbox"]:checked`))
      .map(cb => cb.value);
  }

  // Read-back delegated to EditTemplates so the chip-row HTML and the
  // matching parser stay co-located (and map.js's pin form can reuse
  // the same parser without duplicating the DOM walk).
  const _readAttitudeChipRow = EditTemplates.readAttitudeChipRow;

  // (Per-chip strength sliders were removed when strength moved off
  // the entity onto the `attitudes` settings enum item — see
  // `Settings.updateStrengthReadout` for the live-readout helper that
  // now drives the strength slider in the Postoje k partě editor.)

  // ══════════════════════════════════════════════════════════════
  //  CHARACTER EDITOR
  // ══════════════════════════════════════════════════════════════
  function renderCharacterEditor(c) {
    if (!c || !c.id) {
      const pf = _consumePrefill('character');
      if (pf) return EditTemplates.renderCharacterEditor(pf);
    }
    return EditTemplates.renderCharacterEditor(c);
  }

  /** Prefill a new character's fields, then navigate to the new-character form. */
  function startNewCharacter(prefill) {
    _prefill.character = prefill || {};
    _afterSave.character = null;
    _refreshTo('#/postava/new');
  }

  /** "+ Postava zde" — create a new character and auto-link it to a location.
   *  character.location is the canonical source of truth (a character can
   *  only be in one place at a time). */
  function startNewCharacterInLocation(locId) {
    _prefill.character = { location: locId };
    _afterSave.character = null;
    _refreshTo('#/postava/new');
  }

  // ── Character save / delete ────────────────────────────────────
  function saveCharacter(originalId) {
    const uid  = originalId || "new";
    const name = document.getElementById(`ef-name-${uid}`)?.value.trim();
    if (!name) { _toast("Jméno je povinné", false); return; }

    const newId   = originalId || Store.generateId(name);
    // Preserve fields that the inline editor doesn't expose
    const existing = originalId
      ? (Store.getCharacters().find(c => c.id === originalId) || {})
      : {};

    // Resolve portrait URL: strip any ?v= cache-busters (display-only, never stored),
    // and remap the _new temp subfolder to the real charId now that we know it.
    let portrait = (document.getElementById(`ep-data-${uid}`)?.value || "").split('?')[0];
    if (portrait.startsWith('/portraits/_new/')) {
      const ext = portrait.substring(portrait.lastIndexOf('.'));
      portrait = `/portraits/${newId}/portrait${ext}`;
      // Server will physically move _new/ → newId/ when it processes the PATCH
    }

    // Delete old portrait only when moving to a genuinely different location.
    // Same-folder replacements (e.g. PNG→JPG in the same charId subfolder) are
    // cleaned up server-side during upload, so no extra delete is needed here.
    const oldPortrait = (existing.portrait || "").split('?')[0];
    if (oldPortrait && oldPortrait !== portrait && oldPortrait.startsWith('/portraits/')) {
      const oldSegment = oldPortrait.replace('/portraits/', '').split('/')[0];
      const newSegment = portrait.replace('/portraits/', '').split('/')[0];
      if (oldSegment !== newSegment) Store.deletePortrait(oldPortrait);
    }

    // Gender select has a special "__other__" sentinel revealing a free-text input.
    let gender = document.getElementById(`ef-gender-${uid}`)?.value || "";
    if (gender === '__other__') {
      gender = document.getElementById(`ef-gender-other-${uid}`)?.value.trim() || "";
    }

    const next = {
      // Preserve all fields from existing record first, then overwrite editable ones
      ...existing,
      id:          newId,
      name,
      title:       document.getElementById(`ef-title-${uid}`)?.value.trim()        || "",
      faction:     document.getElementById(`ef-faction-${uid}`)?.value             || "neutral",
      status:      document.getElementById(`ef-status-${uid}`)?.value              || "alive",
      // Multi-attitude chip row + per-attitude strength slider. Empty
      // array = no own stance (renderer falls back to faction).
      attitudes:   _readAttitudeChipRow(`ef-attitudes-${uid}`),
      species:     document.getElementById(`ef-species-${uid}`)?.value.trim()      || "",
      gender,
      age:         document.getElementById(`ef-age-${uid}`)?.value.trim()          || "",
      circumstances: document.getElementById(`ef-circumstances-${uid}`)?.value.trim() || "",
      knowledge:   (() => {
        const n = parseInt(document.getElementById(`ef-knowledge-${uid}`)?.value, 10);
        return Number.isNaN(n) ? 3 : n;
      })(),
      description: document.getElementById(`ef-desc-${uid}`)?.value.trim()         || "",
      portrait,
      known:       _dynVals(`dyn-known-${uid}`),
      unknown:     _dynVals(`dyn-unknown-${uid}`),
    };
    // Defensive: if a pre-migration record still carries the legacy
    // singular `attitude` field, scrub it out now that we always
    // write the array form.
    delete next.attitude;
    const ok = Store.saveCharacter(next);
    if (ok === false) {
      _toast("⚠ Uložení selhalo – úložiště je plné.", false);
      return;
    }
    _runAfterSave('character', newId);
    _toast("✓ Postava uložena");
    _markClean();
    _refreshTo(`#/postava/${newId}`);
  }

  function deleteCharacter(id) {
    Store.deleteCharacter(id); // store also clears relationships + snapshots for undo
    _toast("Postava smazána", true, {
      action: { label: '↶ Vrátit', onClick: () => {
        Store.undelete('characters', id);
        _toast('Postava obnovena');
      }},
    });
    window.location.hash = "#/postavy";
  }

  // ── Relationship add / update / delete ──────────────────────────
  /** Read type, dir, target, label from a relationship row by prefix */
  function _readRelRow(prefix) {
    const type   = document.getElementById(`${prefix}-type`)?.value;
    const dir    = document.getElementById(`${prefix}-dir`)?.value;
    const target = document.getElementById(`${prefix}-target`)?.value;
    const label  = document.getElementById(`${prefix}-label`)?.value.trim() || '';
    return { type, dir, target, label };
  }

  /** Build source/target based on direction relative to charId */
  function _relFromDir(charId, dir, targetId, type, label) {
    if (dir === 'both') {
      // Create two symmetric relationships
      return [
        { source: charId,   target: targetId, type, label },
        { source: targetId, target: charId,   type, label },
      ];
    }
    return [{
      source: dir === 'from' ? charId : targetId,
      target: dir === 'from' ? targetId : charId,
      type, label,
    }];
  }

  function addRelationship(charId) {
    const prefix = `rf-new-${charId}`;
    const { type, dir, target, label } = _readRelRow(prefix);
    if (!target) { _toast('Vyber cíl', false); return; }

    const rels = _relFromDir(charId, dir, target, type, label);
    rels.forEach(r => Store.saveRelationship(r));
    _toast('✓ Vazba přidána');
    _refreshRelSection(charId);
  }

  function updateRelationship(charId, idx) {
    // Get the original relationship to delete it first
    const allRels = Store.getRelationships().filter(r => r.source === charId || r.target === charId);
    const original = allRels[idx];
    if (!original) return;

    const prefix = `rf-${idx}-${charId}`;
    const { type, dir, target, label } = _readRelRow(prefix);
    if (!target) { _toast('Vyber cíl', false); return; }

    // Delete old
    Store.deleteRelationship(original.source, original.target, original.type);
    // Save new
    const rels = _relFromDir(charId, dir, target, type, label);
    rels.forEach(r => Store.saveRelationship(r));
    _toast('✓ Vazba upravena');
    _refreshRelSection(charId);
  }

  /** Called when the type dropdown changes — refreshes direction and target options */
  function relTypeChanged(charId, prefix) {
    const type = document.getElementById(`${prefix}-type`)?.value;
    if (!type) return;

    // Refresh direction options
    const dirEl = document.getElementById(`${prefix}-dir`);
    if (dirEl) {
      const currentDir = dirEl.value;
      dirEl.innerHTML = EditTemplates.getDirOptsHtml(type, currentDir);
    }
    // Re-mount the target combobox with the source matching the new type
    // (character ↔ location). The combobox's hidden input id is `${prefix}-target`,
    // which is what _readRelRow reads.
    const cfg = EditTemplates.getRelConfig()[type];
    const tgtHidden = document.getElementById(`${prefix}-target`);
    const wrap = tgtHidden?.closest('.rel-target-wrap');
    if (wrap && cfg) {
      const currentTgt = tgtHidden.value || '';
      wrap.innerHTML = EditTemplates.getTargetMountHtml(type, charId, currentTgt, prefix);
      Widgets.mountAll(wrap);
    }
    // Update placeholder on label field
    const lblEl = document.getElementById(`${prefix}-label`);
    if (lblEl && cfg) lblEl.placeholder = cfg.label;
  }

  function deleteRelationship(source, target, type, charId) {
    Store.deleteRelationship(source, target, type);
    _toast('Vazba odebrána');
    _refreshRelSection(charId);
  }

  function _refreshRelSection(charId) {
    const section = document.getElementById(`rel-section-${charId}`);
    if (section) {
      const tmp = document.createElement("div");
      tmp.innerHTML = EditTemplates.getRelSectionHtml(charId);
      const newSection = tmp.firstElementChild;
      if (newSection) {
        section.replaceWith(newSection);
        Widgets.mountAll(newSection);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  LOCATION EDITOR
  // ══════════════════════════════════════════════════════════════
  function renderLocationEditor(l) {
    if (!l || !l.id) {
      const pf = _consumePrefill('location');
      if (pf) return EditTemplates.renderLocationEditor(pf);
    }
    return EditTemplates.renderLocationEditor(l);
  }

  function startNewLocation(prefill) {
    _prefill.location = prefill || {};
    _refreshTo('#/misto/new');
  }

  function saveLocation(originalId) {
    const uid  = originalId || "new_loc";
    const name = document.getElementById(`lf-name-${uid}`)?.value.trim();
    if (!name) { _toast("Název je povinný", false); return; }
    const newId = originalId || Store.generateId(name);
    // Preserve map-only fields (x, y, pinType, mapNotes) that this
    // form doesn't expose. Attitudes, status, and size ARE exposed in
    // both the wiki and the map's pin form, so those stay in sync.
    // Note: location.characters is no longer written here — character.location
    // is the canonical source of truth, managed via the MultiSelect picker.
    const existing = originalId ? (Store.getLocation(originalId) || {}) : {};
    const parentId = document.getElementById(`lf-parent-${uid}`)?.value.trim() || "";
    const localMap = document.getElementById(`lf-localmap-${uid}`)?.value.trim() || "";

    // Typ dropdown stores a PIN_TYPES key; derive the human label into
    // l.type for wiki search/display back-compat. Empty = unset.
    const pinTypeKey = document.getElementById(`lf-type-${uid}`)?.value || "";
    const pinTypeDef = pinTypeKey ? PIN_TYPES[pinTypeKey] : null;
    const typeLabel  = pinTypeDef ? pinTypeDef.label : "";

    // Attitude chips: multi-select with per-attitude strength.
    // Empty array = no own stance (rendered with no glow).
    const attitudes = _readAttitudeChipRow(`lf-attitudes-${uid}`);

    // Marker size — empty input = inherit type default; numeric input
    // matching the type default also reverts to inheritance so changing
    // the type default later still moves un-customised places.
    const sizeRaw = document.getElementById(`lf-size-${uid}`)?.value;
    const sizeNum = sizeRaw === '' || sizeRaw == null ? null : parseInt(sizeRaw, 10);
    const typeForSize = pinTypeKey || existing.pinType || '';
    const typeDefault = (Store.getEnumValue('pinTypes', typeForSize) || {}).size
      || (PIN_TYPES[typeForSize] && PIN_TYPES[typeForSize].size)
      || PIN_SIZE_DEFAULT;
    let size;
    if (Number.isFinite(sizeNum) && sizeNum >= PIN_SIZE_MIN && sizeNum <= PIN_SIZE_MAX
        && sizeNum !== typeDefault) {
      size = sizeNum;
    }

    const next = {
      ...existing,
      id: newId, name,
      pinType:     pinTypeKey || existing.pinType || undefined,
      type:        typeLabel,
      attitudes,
      size,
      description: document.getElementById(`lf-desc-${uid}`)?.value.trim()   || "",
      notes:       document.getElementById(`lf-notes-${uid}`)?.value.trim()  || "",
      parentId:    parentId || undefined,
      localMap:    localMap || undefined,
    };
    if (size === undefined) delete next.size;
    // The legacy `locationStatuses` enum is gone — strip any stale
    // `status` carried over from `existing` so it doesn't get re-persisted.
    delete next.status;
    Store.saveLocation(next);
    _runAfterSave('location', newId);
    _toast("✓ Místo uloženo");
    _markClean();
    _refreshTo(`#/misto/${newId}`);
  }

  // ── Local map upload ──────────────────────────────────────────
  async function uploadLocalMap(locId, file, inputId) {
    if (!file || !locId) return;
    try {
      _toast("Nahrávám mapu…");
      const url = await Store.uploadLocalMap(file, locId);
      const input = document.getElementById(inputId);
      if (input) input.value = url;
      _toast("Mapa nahrána ✓");
    } catch (e) {
      _toast("Chyba při nahrávání mapy", false);
      console.error(e);
    }
  }

  // ── MultiSelect → character.location sync ─────────────────────
  // The location editor mounts a MultiSelect with data-loc-id. Each
  // change diffs added/removed and updates character.location. This
  // enforces "character can only be in one place at a time":
  // adding a character here moves it from its previous location.
  document.addEventListener('w-ms-change', (ev) => {
    const el = ev.target;
    if (!el || !el.dataset) return;
    const locId = el.dataset.locId;
    if (!locId) return;
    const newIds = new Set(ev.detail?.value || []);
    const prevIds = new Set((el.dataset.msValue || '').split(',').map(s => s.trim()).filter(Boolean));
    // Added: set their .location to locId
    newIds.forEach(cid => {
      if (prevIds.has(cid)) return;
      const c = Store.getCharacter(cid);
      if (!c) return;
      Store.saveCharacter({ ...c, location: locId });
    });
    // Removed: clear their .location (only if it still points here)
    prevIds.forEach(cid => {
      if (newIds.has(cid)) return;
      const c = Store.getCharacter(cid);
      if (!c) return;
      if (c.location === locId) Store.saveCharacter({ ...c, location: '' });
    });
    el.dataset.msValue = [...newIds].join(',');
  });

  function deleteLocation(id) {
    Store.deleteLocation(id);
    _toast("Místo smazáno", true, {
      action: { label: '↶ Vrátit', onClick: () => {
        Store.undelete('locations', id);
        _toast('Místo obnoveno');
      }},
    });
    window.location.hash = "#/mista";
  }

  // ══════════════════════════════════════════════════════════════
  //  EVENT EDITOR
  // ══════════════════════════════════════════════════════════════
  function renderEventEditor(e) {
    if (!e || !e.id) {
      const pf = _consumePrefill('event');
      if (pf) return EditTemplates.renderEventEditor(pf);
    }
    return EditTemplates.renderEventEditor(e);
  }

  function startNewEvent(prefill) {
    _prefill.event = prefill || {};
    _refreshTo('#/udalost/new');
  }

  function saveEvent(originalId) {
    const uid  = originalId || "new_ev";
    const name = document.getElementById(`evf-name-${uid}`)?.value.trim();
    if (!name) { _toast("Název je povinný", false); return; }
    const newId = originalId || Store.generateId(name);
    const sittingRaw = document.getElementById(`evf-sitting-${uid}`)?.value.trim();
    const sitting    = sittingRaw ? (parseInt(sittingRaw) || null) : null;
    // Preserve fields not exposed in the editor
    const existingEv = originalId ? (Store.getEvent(originalId) || {}) : {};
    // Order is no longer user-editable — it's owned by the timeline
    // drag-drop. On first save, park the event at the end of its sitting
    // so it gets a stable slot. Existing events keep whatever order the
    // timeline has already assigned them; if sitting changed, rebase to
    // the tail of the new sitting group.
    let order = existingEv.order;
    const sittingChanged = existingEv.sitting !== sitting;
    if (order == null || sittingChanged) {
      const tail = Store.getEvents()
        .filter(ev => ev.id !== newId && (ev.sitting ?? null) === sitting)
        .reduce((m, ev) => Math.max(m, ev.order ?? 0), 0);
      order = tail + 1;
    }
    Store.saveEvent({
      ...existingEv,
      id: newId, name,
      order,
      sitting,
      short:       document.getElementById(`evf-short-${uid}`)?.value.trim()     || "",
      description: document.getElementById(`evf-desc-${uid}`)?.value.trim()      || "",
      characters:  _checkVals(`evf-chars-${uid}`),
      locations:   _checkVals(`evf-locs-${uid}`),
    });
    _runAfterSave('event', newId);
    _toast("✓ Událost uložena");
    _markClean();
    _refreshTo(`#/udalost/${newId}`);
  }

  function deleteEvent(id) {
    Store.deleteEvent(id);
    _toast("Událost smazána", true, {
      action: { label: '↶ Vrátit', onClick: () => {
        Store.undelete('events', id);
        _toast('Událost obnovena');
      }},
    });
    window.location.hash = "#/casova-osa";
  }

  // Merge all player-party characters into the given MultiSelect mount.
  function addPartyToEvent(mountId) {
    const el = document.getElementById(mountId);
    if (!el || !el._multiselect) { _toast("Widget nepřipraven", false); return; }
    const partyIds = Store.getCharacters()
      .filter(c => c.faction === PARTY_FACTION_ID)
      .map(c => c.id);
    if (!partyIds.length) { _toast("Parta je prázdná", false); return; }
    const current = el._multiselect.getValue();
    const merged  = Array.from(new Set([...current, ...partyIds]));
    const added   = merged.length - current.length;
    el._multiselect.setValue(merged);
    _toast(added ? `+ ${added} postav` : "Všichni už jsou přidáni");
  }

  // ══════════════════════════════════════════════════════════════
  //  MYSTERY EDITOR
  // ══════════════════════════════════════════════════════════════
  function renderMysteryEditor(m) {
    return EditTemplates.renderMysteryEditor(m);
  }

  function saveMystery(originalId) {
    const uid  = originalId || "new_mys";
    const name = document.getElementById(`mf-name-${uid}`)?.value.trim();
    if (!name) { _toast("Název je povinný", false); return; }
    const newId = originalId || Store.generateId(name);
    // Preserve fields that the inline editor doesn't expose (questions, clues, etc.)
    const existing = originalId
      ? (Store.getMysteries().find(m => m.id === originalId) || {})
      : {};
    Store.saveMystery({
      ...existing,
      id: newId, name,
      priority:    document.getElementById(`mf-pri-${uid}`)?.value         || "střední",
      description: document.getElementById(`mf-desc-${uid}`)?.value.trim() || "",
      characters:  _checkVals(`mf-chars-${uid}`),
    });
    _toast("✓ Záhada uložena");
    _markClean();
    _refreshTo(`#/zahada/${newId}`);
  }

  function deleteMystery(id) {
    Store.deleteMystery(id);
    _toast("Záhada smazána", true, {
      action: { label: '↶ Vrátit', onClick: () => {
        Store.undelete('mysteries', id);
        _toast('Záhada obnovena');
      }},
    });
    window.location.hash = "#/zahady";
  }

  // ══════════════════════════════════════════════════════════════
  //  FACTION EDITOR
  // ══════════════════════════════════════════════════════════════
  function renderFactionEditor(f, facId) {
    return EditTemplates.renderFactionEditor(f, facId);
  }

  function addRankChain(containerId, uid) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const ci = container.querySelectorAll('.rank-chain-edit').length;
    const div = document.createElement('div');
    div.innerHTML = EditTemplates.getChainEditHtml({ id:'', name:'', ranks:[] }, uid, 'n' + ci);
    container.appendChild(div.firstElementChild);
    container.lastElementChild?.querySelector('input')?.focus();
  }

  function addRankRow(listId) {
    const list = document.getElementById(listId);
    if (!list) return;
    const div = document.createElement('div');
    div.innerHTML = EditTemplates.getDynRowHtml("");
    list.appendChild(div.firstElementChild);
    list.lastElementChild?.querySelector('input')?.focus();
  }

  function saveFaction(originalId) {
    const uid  = (originalId || "new_fac").replace(/[^a-z0-9_]/gi, "_");
    const name = document.getElementById(`ff-name-${uid}`)?.value.trim();
    if (!name) { _toast("Název je povinný", false); return; }
    const newId     = originalId || Store.generateId(name);
    const color     = document.getElementById(`ff-color-text-${uid}`)?.value.trim() || "#555555";
    const textColor = document.getElementById(`ff-textcolor-text-${uid}`)?.value.trim() || "#E0E0E0";
    const badge     = document.getElementById(`ff-badge-${uid}`)?.value.trim() || "⚐";
    const desc      = document.getElementById(`ff-desc-${uid}`)?.value.trim() || "";

    const chainEls  = document.querySelectorAll(`#chains-${uid} .rank-chain-edit`);
    const rankChains = Array.from(chainEls).map(el => {
      const chainName = el.querySelector('input[placeholder="Název řetězce"]')?.value.trim() || "";
      const chainId   = el.dataset.chainId || Store.generateId(chainName) || ("chain_" + Date.now());
      const rankInputs = el.querySelectorAll('.rank-ranks-list .edit-input');
      const ranks = Array.from(rankInputs).map(i => i.value.trim()).filter(Boolean);
      return { id: chainId, name: chainName, ranks };
    }).filter(ch => ch.name);

    // Faction-level attitudes — character renderers fall back to these
    // when a member has no own attitudes set.
    const attitudes = _readAttitudeChipRow(`ff-attitudes-${uid}`);

    // Preserve any fields not in the editor (e.g., if faction had extra properties)
    const existing = originalId ? (Store.getFaction(originalId) || {}) : {};
    Store.saveFaction(newId, { ...existing, name, color, textColor, badge, description: desc, rankChains, attitudes });
    _toast("✓ Frakce uložena");
    _markClean();
    _refreshTo(`#/frakce/${newId}`);
  }

  function deleteFaction(id) {
    Store.deleteFaction(id);
    _toast("Frakce smazána (postavy mají id zachované)", true, {
      action: { label: '↶ Vrátit', onClick: () => {
        Store.undelete('factions', id);
        _toast('Frakce obnovena');
      }},
    });
    window.location.hash = "#/frakce";
  }

  // ── Gender "Ostatní (specifikuj)" reveal ──────────────────────
  function onGenderChange(uid) {
    const sel   = document.getElementById(`ef-gender-${uid}`);
    const other = document.getElementById(`ef-gender-other-${uid}`);
    if (!sel || !other) return;
    if (sel.value === '__other__') {
      other.style.display = '';
      other.focus();
    } else {
      other.style.display = 'none';
      other.value = '';
    }
  }

  // ── EasyMDE mount ─────────────────────────────────────────────
  // Track every mounted EasyMDE instance. When `navigate()` replaces
  // the page DOM (innerHTML) the old textareas become detached but their
  // EasyMDE/CodeMirror wrappers retain document-level listeners and
  // memory until GC'd. We sweep before each mount: any tracked instance
  // whose textarea is no longer connected gets `toTextArea()`-ed (the
  // documented teardown that removes the wrapper + listeners).
  const _mountedEasyMDE = new Set();
  function _cleanupOrphanedEasyMDE() {
    for (const mde of _mountedEasyMDE) {
      const ta = mde.element || (mde.codemirror?.getTextArea?.() ?? null);
      if (ta && ta.isConnected) continue;
      try { mde.toTextArea(); } catch (_) { /* already torn down */ }
      _mountedEasyMDE.delete(mde);
    }
  }

  // Any <textarea class="md-easy"> rendered by edit templates gets
  // upgraded to a CodeMirror-backed EasyMDE instance on next
  // Widgets.mountAll pass. `forceSync:true` keeps the underlying
  // <textarea>'s `.value` in sync on every keystroke, so existing
  // save code reading `document.getElementById(id).value` just works.
  // Preview goes through our sanitized renderMarkdown (marked+DOMPurify).
  function mountEasyMDE(root) {
    _cleanupOrphanedEasyMDE();
    const scope = root || document;
    if (typeof window.EasyMDE !== 'function') return;
    const tas = scope.querySelectorAll('textarea.md-easy:not([data-md-mounted])');
    tas.forEach(ta => {
      ta.setAttribute('data-md-mounted', '1');
      try {
        const mde = new EasyMDE({
          element: ta,
          forceSync: true,
          spellChecker: false,
          autofocus: false,
          status: ['lines', 'words'],
          minHeight: '320px',
          placeholder: ta.getAttribute('placeholder') || '',
          previewRender: (txt) => renderMarkdown(txt),
          toolbar: [
            'bold', 'italic', 'strikethrough', '|',
            'heading-1', 'heading-2', 'heading-3', '|',
            'quote', 'unordered-list', 'ordered-list', '|',
            'link', 'image', 'table', 'code', 'horizontal-rule', '|',
            'preview', 'side-by-side', 'fullscreen', '|',
            'undo', 'redo', '|',
            'guide',
          ],
          shortcuts: {
            toggleBold:          'Ctrl-B',
            toggleItalic:        'Ctrl-I',
            drawLink:            'Ctrl-K',
            toggleHeadingSmaller:'Ctrl-H',
            togglePreview:       'Ctrl-P',
            toggleSideBySide:    'F9',
            toggleFullScreen:    'F11',
          },
        });
        ta._easymde = mde;
        _mountedEasyMDE.add(mde);
        _wireEasyMDEDraft(mde, ta);
      } catch (e) {
        console.warn('EasyMDE mount failed', e);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  SPECIES / PANTHEON / ARTIFACT editors
  // ══════════════════════════════════════════════════════════════
  function renderSpeciesEditor(s) {
    if (!s || !s.id) {
      const pf = _consumePrefill('species');
      if (pf) return EditTemplates.renderSpeciesEditor(pf);
    }
    return EditTemplates.renderSpeciesEditor(s);
  }
  function startNewSpecies(prefill) {
    _prefill.species = prefill || {};
    _refreshTo('#/druh/new');
  }
  function saveSpecies(originalId) {
    const uid  = originalId || 'new_sp';
    const name = document.getElementById(`sf-name-${uid}`)?.value.trim();
    if (!name) { _toast('Název je povinný', false); return; }
    const newId = originalId || Store.generateId(name);
    const existing = originalId ? (Store.getSpeciesItem(originalId) || {}) : {};
    Store.saveSpecies({
      ...existing,
      id: newId, name,
      description: document.getElementById(`sf-desc-${uid}`)?.value.trim() || '',
    });
    _toast('✓ Druh uložen');
    _markClean();
    _refreshTo(`#/druh/${newId}`);
  }
  function deleteSpecies(id) {
    Store.deleteSpecies(id);
    _toast('Druh smazán', true, {
      action: { label: '↶ Vrátit', onClick: () => {
        Store.undelete('species', id);
        _toast('Druh obnoven');
      }},
    });
    window.location.hash = '#/druhy';
  }

  function renderBuhEditor(g) {
    if (!g || !g.id) {
      const pf = _consumePrefill('buh');
      if (pf) return EditTemplates.renderBuhEditor(pf);
    }
    return EditTemplates.renderBuhEditor(g);
  }
  function startNewBuh(prefill) {
    _prefill.buh = prefill || {};
    _refreshTo('#/buh/new');
  }
  function saveBuh(originalId) {
    const uid  = originalId || 'new_god';
    const name = document.getElementById(`gf-name-${uid}`)?.value.trim();
    if (!name) { _toast('Jméno je povinné', false); return; }
    const newId = originalId || Store.generateId(name);
    const existing = originalId ? (Store.getBuh(originalId) || {}) : {};
    Store.saveBuh({
      ...existing,
      id: newId, name,
      symbol:      document.getElementById(`gf-symbol-${uid}`)?.value.trim()   || '',
      domain:      document.getElementById(`gf-domain-${uid}`)?.value.trim()   || '',
      alignment:   document.getElementById(`gf-alignment-${uid}`)?.value.trim()|| '',
      description: document.getElementById(`gf-desc-${uid}`)?.value.trim()     || '',
    });
    _toast('✓ Božstvo uloženo');
    _markClean();
    _refreshTo(`#/buh/${newId}`);
  }
  function deleteBuh(id) {
    Store.deleteBuh(id);
    _toast('Božstvo smazáno', true, {
      action: { label: '↶ Vrátit', onClick: () => {
        Store.undelete('pantheon', id);
        _toast('Božstvo obnoveno');
      }},
    });
    window.location.hash = '#/panteon';
  }

  function renderArtifactEditor(a) {
    if (!a || !a.id) {
      const pf = _consumePrefill('artifact');
      if (pf) return EditTemplates.renderArtifactEditor(pf);
    }
    return EditTemplates.renderArtifactEditor(a);
  }
  function startNewArtifact(prefill) {
    _prefill.artifact = prefill || {};
    _refreshTo('#/artefakt/new');
  }
  function saveArtifact(originalId) {
    const uid  = originalId || 'new_art';
    const name = document.getElementById(`af-name-${uid}`)?.value.trim();
    if (!name) { _toast('Název je povinný', false); return; }
    const newId = originalId || Store.generateId(name);
    const existing = originalId ? (Store.getArtifact(originalId) || {}) : {};
    const next = {
      ...existing,
      id: newId, name,
      ownerCharacterId: document.getElementById(`af-owner-${uid}`)?.value.trim()    || '',
      locationId:       document.getElementById(`af-loc-${uid}`)?.value.trim()      || '',
      description:      document.getElementById(`af-desc-${uid}`)?.value.trim()     || '',
    };
    // The legacy `artifactStates` enum is gone — strip any stale
    // `state` carried over from `existing` so it doesn't get re-persisted.
    delete next.state;
    Store.saveArtifact(next);
    _toast('✓ Artefakt uložen');
    _markClean();
    _refreshTo(`#/artefakt/${newId}`);
  }
  function deleteArtifact(id) {
    Store.deleteArtifact(id);
    _toast('Artefakt smazán', true, {
      action: { label: '↶ Vrátit', onClick: () => {
        Store.undelete('artifacts', id);
        _toast('Artefakt obnoven');
      }},
    });
    window.location.hash = '#/artefakty';
  }

  // ── Historical events ──────────────────────────────────────────
  function renderHistoricalEventEditor(h) {
    if (!h || !h.id) {
      const pf = _consumePrefill('historicalEvent');
      if (pf) return EditTemplates.renderHistoricalEventEditor(pf);
    }
    return EditTemplates.renderHistoricalEventEditor(h);
  }
  function startNewHistoricalEvent(prefill) {
    _prefill.historicalEvent = prefill || {};
    _refreshTo('#/historicka-udalost/new');
  }
  function saveHistoricalEvent(originalId) {
    const uid  = originalId || 'new_hist';
    const name = document.getElementById(`he-name-${uid}`)?.value.trim();
    if (!name) { _toast('Název je povinný', false); return; }
    const newId    = originalId || Store.generateId(name);
    const existing = originalId ? (Store.getHistoricalEvent(originalId) || {}) : {};
    const tags = (document.getElementById(`he-tags-${uid}`)?.value || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    Store.saveHistoricalEvent({
      ...existing,
      id: newId, name,
      start:      document.getElementById(`he-start-${uid}`)?.value.trim()   || '',
      end:        document.getElementById(`he-end-${uid}`)?.value.trim()     || '',
      summary:    document.getElementById(`he-summary-${uid}`)?.value.trim() || '',
      body:       document.getElementById(`he-body-${uid}`)?.value.trim()    || '',
      characters: _checkVals(`he-chars-${uid}`),
      locations:  _checkVals(`he-locs-${uid}`),
      tags,
    });
    _toast('✓ Historická událost uložena');
    _markClean();
    _refreshTo(`#/historicka-udalost/${newId}`);
  }
  function deleteHistoricalEvent(id) {
    Store.deleteHistoricalEvent(id);
    _toast('Historická událost smazána', true, {
      action: { label: '↶ Vrátit', onClick: () => {
        Store.undelete('historicalEvents', id);
        _toast('Historická událost obnovena');
      }},
    });
    window.location.hash = '#/historie';
  }

  // ── Public API ─────────────────────────────────────────────────
  return {
    isActive, toggle, isDirty,
    addDynRow, handlePortraitUpload,
    clearPortrait, updateKnowledgeLabel,
    handlePortraitChange, handleLocalMapChange,
    addRankChain, addRankRow,
    saveCharacter, deleteCharacter, onGenderChange,
    addRelationship, updateRelationship, deleteRelationship, relTypeChanged,
    saveLocation, deleteLocation, uploadLocalMap,
    saveEvent, deleteEvent, addPartyToEvent,
    saveMystery, deleteMystery,
    saveFaction, deleteFaction,
    saveSpecies, deleteSpecies,
    saveBuh, deleteBuh,
    saveArtifact, deleteArtifact,
    saveHistoricalEvent, deleteHistoricalEvent,
    mountEasyMDE,
    toast: _toast,
    renderCharacterEditor,
    renderLocationEditor,
    renderEventEditor,
    renderMysteryEditor,
    renderFactionEditor,
    renderSpeciesEditor,
    renderBuhEditor,
    renderArtifactEditor,
    renderHistoricalEventEditor,
    startNewCharacter, startNewLocation, startNewEvent,
    startNewSpecies, startNewBuh, startNewArtifact,
    startNewHistoricalEvent,
    startNewCharacterInLocation,
  };

})();
