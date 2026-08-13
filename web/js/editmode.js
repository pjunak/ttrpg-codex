// Wiki entity editors and their shared interaction helpers.

import { Store } from './store.js';
import { EditTemplates } from './edit_templates.js';
import { Widgets } from './widgets/widgets.js';
import { PinTypes } from './pin-types.js';
import { renderMarkdown, jaroWinkler, esc, norm, trapFocus } from './utils.js';
import { PARTY_FACTION_ID } from './constants.js';
import { Role } from './role.js';
import { Addons } from './addons.js';
import { I18n } from './i18n.js';
import { CollectionDescriptors } from './collection-descriptors.js';
import { EditDrafts } from './edit-drafts.js';
import { EditLogin } from './edit-login.js';
import { EditLoreController } from './edit-lore-controller.js';
import { MARKDOWN_FORMAT_GROUPS, editMarkdownSelection } from './markdown-formatting.js';

const PIN_SIZE_MIN = PinTypes.sizeMin;
const PIN_SIZE_MAX = PinTypes.sizeMax;
const PIN_SIZE_DEFAULT = PinTypes.sizeDefault;

export const EditMode = (() => {
  const _drafts = EditDrafts.create();
  const {
    discardDirty,
    isDirty,
    markClean: _markClean,
    wireEasyMDE: _wireEasyMDEDraft,
  } = _drafts;

  // ── Prefill state for new-entity creation ──────────────────────
  // Set by startNewCharacter / startNewLocation / startNewEvent and
  // consumed once by the corresponding renderXxxEditor(null). Lets
  // "+ Nová postava ve frakci" (and similar) pre-fill context fields
  // instead of sending the user to a blank form.
  let _prefill = { character: null, location: null, event: null,
                   buh: null, artifact: null,
                   historicalEvent: null };
  function _consumePrefill(kind) {
    const p = _prefill[kind];
    _prefill[kind] = null;
    return p || null;
  }
  const _loreEditors = EditLoreController.create({
    consumePrefill: _consumePrefill,
    setPrefill: (kind, value) => { _prefill[kind] = value; },
    collectVisibility: uid => _collectVisibility(uid),
    checkValues: id => _checkVals(id),
    toast: (message, ok, options) => _toast(message, ok, options),
    markClean: () => _markClean(),
    refreshTo: hash => _refreshTo(hash),
  });
  const {
    renderBuhEditor,
    startNewBuh,
    saveBuh,
    deleteBuh,
    renderArtifactEditor,
    startNewArtifact,
    saveArtifact,
    deleteArtifact,
    renderHistoricalEventEditor,
    startNewHistoricalEvent,
    saveHistoricalEvent,
    deleteHistoricalEvent,
  } = _loreEditors;

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

  /**
   * Show a transient status message at the bottom of the screen. The
   * default 2.5 s timeout is bumped to 8 s when an `action` button is
   * supplied (typical use: an undo affordance after a destructive op).
   *
   * @param {string} msg
   * @param {boolean} [ok=true] - `false` styles the toast as an error.
   * @param {{action?: {label: string, onClick: Function}, timeout?: number}} [opts]
   */
  function _toast(msg, ok = true, opts = {}) {
    let t = document.getElementById("edit-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "edit-toast";
      // Announce toasts to assistive tech. `role="status"` makes it a
      // live region; politeness is set per-toast below (assertive for
      // errors so they interrupt, polite otherwise).
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.setAttribute('aria-live', ok ? 'polite' : 'assertive');
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
      btn.textContent = opts.action.label || ('↶ ' + I18n.t('action.undo'));
      btn.addEventListener('click', () => {
        try { opts.action.onClick(); } finally { t.classList.remove('show'); }
      });
      t.appendChild(btn);
    }
    t.className = "edit-toast show " + (ok ? "ok" : "err");
    clearTimeout(t._tid);
    t._tid = setTimeout(() => t.classList.remove("show"), timeout);
  }

  const _login = EditLogin.create({ toast: _toast });
  const { promptLogin } = _login;

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

  // ── Dynamic fact rows ──────────────────────────────────────────
  function addDynRow(wrapperId) {
    const list = document.getElementById(wrapperId);
    if (!list) return;
    const div = document.createElement("div");
    div.innerHTML = EditTemplates.getDynRowHtml("");
    list.appendChild(div.firstElementChild);
    list.lastElementChild?.querySelector("input")?.focus();
  }
  // Question + answer row. Used by the mystery editor (Otázky section)
  // and the character editor (Otevřené otázky section). New row starts
  // empty; user fills in question text and (optionally) answer.
  function addQARow(wrapperId) {
    const list = document.getElementById(wrapperId);
    if (!list) return;
    const div = document.createElement("div");
    div.innerHTML = EditTemplates.qaRowHtml({ text: '', answer: '' });
    list.appendChild(div.firstElementChild);
    list.lastElementChild?.querySelector(".qa-q-text")?.focus();
  }

  // ── Helpers for the data-action dispatcher ─────────────────────
  // DOM-manipulation handlers invoked via `data-action` from
  // edit_templates.js.
  function clearPortrait(uid, badge) {
    const preview = document.getElementById('ep-preview-' + uid);
    const hidden  = document.getElementById('ep-data-' + uid);
    if (preview) preview.innerHTML = `<span style="font-size:2.5rem">${esc(badge || '')}</span>`;
    if (hidden)  hidden.value = '';
  }
  function updateKnowledgeLabel(uid) {
    const KNAMES = [
      I18n.t('editmode.knowledge0'), I18n.t('editmode.knowledge1'),
      I18n.t('editmode.knowledge2'), I18n.t('editmode.knowledge3'),
      I18n.t('editmode.knowledge4'),
    ];
    const range = document.getElementById('ef-knowledge-' + uid);
    const label = document.getElementById('ef-kl-' + uid);
    if (!range || !label) return;
    const v = +range.value;
    label.textContent = I18n.t('editmode.knowledgeLabel', { v, name: KNAMES[v] });
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
      _toast(I18n.t('editmode.uploadingImage'));
      // Always upload to a subfolder: data/portraits/{charId}/portrait.ext
      // New characters use "_new" as a temporary charId; the server migrates
      // the file to the real subfolder when the character is first saved.
      const charId = (uid && uid !== "new") ? uid : "_new";
      const url    = await Store.uploadPortrait(file, charId);
      const preview = document.getElementById("ep-preview-" + uid);
      const hidden  = document.getElementById("ep-data-" + uid);
      // Show with cache-buster, but store the clean URL (no ?v=) in data
      if (preview) preview.innerHTML = `<img src="${esc(url)}?v=${Date.now()}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:top">`;
      if (hidden)  hidden.value = url;
      _toast(I18n.t('editmode.imageUploaded'));
    } catch(e) {
      _toast(I18n.t('editmode.imageUploadError'), false);
      console.error(e);
    }
  }


  // ── Gather helpers ─────────────────────────────────────────────
  // Read every {text, answer} pair from a `.qa-list` container.
  // Drops rows whose question text is empty — answer-only rows are
  // never persisted (would be orphan data).
  function _qaVals(listId) {
    const root = document.getElementById(listId);
    if (!root) return [];
    return [...root.querySelectorAll('.qa-row')].map(row => ({
      text:   row.querySelector('.qa-q-text')?.value?.trim()   || '',
      answer: row.querySelector('.qa-q-answer')?.value?.trim() || '',
    })).filter(qa => qa.text);
  }

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
  // the same parser without duplicating the DOM walk). Strength is per-
  // enum-item now; `Settings.updateStrengthReadout` drives the slider
  // in the Postoje k partě editor.
  const _readAttitudeChipRow = EditTemplates.readAttitudeChipRow;

  /** Read the per-form Viditelnost section into `{ visibility, secrets }`.
   *  Defaults to `'public'` / `{}` for forms that don't carry the section
   *  (collections excluded from the visibility model, or stripped-down
   *  editors). Each save handler spreads this onto the entity before
   *  Store.saveXxx so the cookie / server sees both fields together. */
  function _collectVisibility(uid) {
    return EditTemplates.readVisibilitySection(uid);
  }

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

  /**
   * Read the character editor form for `originalId` (or the "new"
   * placeholder), build the entity record, and persist via
   * `Store.saveCharacter`. Performs portrait migration (the new-
   * entity form uses a `_new` temp folder that gets remapped here),
   * cleans up old portraits when the URL changes, and runs any
   * pending after-save hook (e.g. linking the character into a
   * source location's roster).
   *
   * @param {string} [originalId] - Existing id; absent for new entities.
   */
  function saveCharacter(originalId) {
    const uid  = originalId || "new";
    const name = document.getElementById(`ef-name-${uid}`)?.value.trim();
    if (!name) { _toast(I18n.t('editmode.nameRequired'), false); return; }

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
      // unknown[] is now {text, answer} objects post-migration. The
      // helper drops rows with empty text so dangling answer-only
      // rows don't persist.
      unknown:     _qaVals(`dyn-unknown-${uid}`),
    };
    // PCs always render with the `party` palette via the faction
    // shortcut in Store.getEffectiveAttitudes — their own attitudes[]
    // is dead data. Strip it so the record stays clean.
    if (Store.isPartyMember(next)) next.attitudes = [];
    // Defensive: if a pre-migration record still carries the legacy
    // singular `attitude` field, scrub it out now that we always
    // write the array form.
    delete next.attitude;
    // Visibility (DM mode). PCs are forced to 'public' as defence in
    // depth — the editor disables the option, but a stale cached DOM
    // could in theory submit 'dm'; the server rejects this too.
    const vis = _collectVisibility(uid);
    next.visibility = Store.isPartyMember(next) ? 'public' : vis.visibility;
    next.secrets    = vis.secrets;
    // Addon-contributed editor fields (registerEditorFields) → merge each
    // addon's collected values into its addonData namespace. Namespaces an
    // addon didn't touch already rode in via `...existing`, so they survive.
    try {
      const formRoot = document.getElementById(`ef-name-${uid}`)?.closest('.edit-form') || document;
      const collected = Addons.collectEditorFields('characters', next, formRoot);
      if (collected && Object.keys(collected).length) {
        next.addonData = { ...(next.addonData || {}), ...collected };
      }
    } catch (e) { console.error('[addons] collectEditorFields failed', e); }
    const ok = Store.saveCharacter(next);
    if (ok === false) {
      _toast(I18n.t('editmode.saveFailedStorageFull'), false);
      return;
    }
    _runAfterSave('character', newId);
    _toast(I18n.t('editmode.characterSaved'));
    _markClean();
    _refreshTo(`#/postava/${newId}`);
  }

  /**
   * Delete a character with an inline 8-second undo affordance in the
   * toast. The `Store.deleteCharacter` call cascades through relations
   * and events; the `Store.undelete` call restores the snapshot.
   *
   * @param {string} id
   */
  function deleteCharacter(id) {
    Store.deleteCharacter(id); // store cascades into relationships + snapshots for undo
    _toast(I18n.t('editmode.characterDeleted'), true, {
      action: { label: '↶ ' + I18n.t('action.undo'), onClick: () => {
        Store.undelete('characters', id);
        _toast(I18n.t('editmode.characterRestored'));
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
    if (!target) { _toast(I18n.t('editmode.pickTarget'), false); return; }

    const rels = _relFromDir(charId, dir, target, type, label);
    rels.forEach(r => Store.saveRelationship(r));
    _toast(I18n.t('editmode.relationAdded'));
    _openRel = { charId: null, idx: null };
    _refreshRelSection(charId);
  }

  function updateRelationship(charId, idx) {
    // Get the original relationship to delete it first
    const allRels = Store.getRelationships().filter(r => r.source === charId || r.target === charId);
    const original = allRels[idx];
    if (!original) return;

    const prefix = `rf-${idx}-${charId}`;
    const { type, dir, target, label } = _readRelRow(prefix);
    if (!target) { _toast(I18n.t('editmode.pickTarget'), false); return; }

    // Delete old
    Store.deleteRelationship(original.source, original.target, original.type);
    // Save new
    const rels = _relFromDir(charId, dir, target, type, label);
    rels.forEach(r => Store.saveRelationship(r));
    _toast(I18n.t('editmode.relationUpdated'));
    _openRel = { charId: null, idx: null };
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
    _toast(I18n.t('editmode.relationRemoved'));
    _openRel = { charId: null, idx: null };
    _refreshRelSection(charId);
  }

  // Which single connection (if any) is open for editing. `idx` is the index in
  // the character's relationship list, 'new' for the add row, or null (all chips).
  let _openRel = { charId: null, idx: null };
  /** Open one connection for editing (or the add row); re-render the section. */
  function editRel(charId, idx) {
    _openRel = { charId, idx: (idx === 'new' ? 'new' : Number(idx)) };
    _refreshRelSection(charId);
  }
  /** Collapse the open connection back to its chip. */
  function cancelRel(charId) {
    _openRel = { charId: null, idx: null };
    _refreshRelSection(charId);
  }

  function _refreshRelSection(charId) {
    const section = document.getElementById(`rel-section-${charId}`);
    if (section) {
      const tmp = document.createElement("div");
      const openIdx = _openRel.charId === charId ? _openRel.idx : null;
      tmp.innerHTML = EditTemplates.getRelSectionHtml(charId, openIdx);
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
    if (!name) { _toast(I18n.t('editmode.titleRequired'), false); return; }
    const newId = originalId || Store.generateId(name);
    // Preserve map-only fields (x, y, pinType, mapNotes) that this
    // form doesn't expose. Attitudes, status, and size ARE exposed in
    // both the wiki and the map's pin form, so those stay in sync.
    // Note: location.characters is no longer written here — character.location
    // is the canonical source of truth, managed via the MultiSelect picker.
    const existing = originalId ? (Store.getLocation(originalId) || {}) : {};
    const parentId = document.getElementById(`lf-parent-${uid}`)?.value.trim() || "";
    const localMap = document.getElementById(`lf-localmap-${uid}`)?.value.trim() || "";

    // The type dropdown stores a pin-type id; derive the human label into
    // l.type for wiki search/display back-compat. Empty = unset.
    const pinTypeKey = document.getElementById(`lf-type-${uid}`)?.value || "";
    const pinTypeDef = pinTypeKey
      ? PinTypes.resolve(Store.getKinds('pinTypes'), pinTypeKey)
      : null;
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
      || (PinTypes.byId[typeForSize] && PinTypes.byId[typeForSize].size)
      || PIN_SIZE_DEFAULT;
    let size;
    if (Number.isFinite(sizeNum) && sizeNum >= PIN_SIZE_MIN && sizeNum <= PIN_SIZE_MAX
        && sizeNum !== typeDefault) {
      size = sizeNum;
    }

    const next = {
      ...existing,
      id: newId, name,
      // Trust the form's type picker — it always renders with an explicit
      // "⊘ Neurčeno" empty option, so an empty pick means CLEAR the pin
      // type. Falling back to existing.pinType made that pick a silent
      // no-op while `type` was blanked (inconsistent record).
      pinType:     pinTypeKey || undefined,
      type:        typeLabel,
      attitudes,
      size,
      description: document.getElementById(`lf-desc-${uid}`)?.value.trim()   || "",
      notes:       document.getElementById(`lf-notes-${uid}`)?.value.trim()  || "",
      parentId:    parentId || undefined,
      localMap:    localMap || undefined,
    };
    if (size === undefined) delete next.size;
    if (!next.pinType) delete next.pinType;
    // The legacy `locationStatuses` enum is gone — strip any stale
    // `status` carried over from `existing` so it doesn't get re-persisted.
    delete next.status;
    // Visibility (DM mode). A DM-only location disappears from player
    // payloads, including from the map.
    Object.assign(next, _collectVisibility(uid));
    Store.saveLocation(next);
    _runAfterSave('location', newId);
    _toast(I18n.t('editmode.locationSaved'));
    _markClean();
    _refreshTo(`#/misto/${newId}`);
  }

  // ── Local map upload ──────────────────────────────────────────
  async function uploadLocalMap(locId, file, inputId) {
    if (!file || !locId) return;
    try {
      _toast(I18n.t('editmode.uploadingMap'));
      const url = await Store.uploadLocalMap(file, locId);
      const input = document.getElementById(inputId);
      if (input) input.value = url;
      _toast(I18n.t('editmode.mapUploaded'));
    } catch (e) {
      _toast(I18n.t('editmode.mapUploadError'), false);
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
    _toast(I18n.t('editmode.locationDeleted'), true, {
      action: { label: '↶ ' + I18n.t('action.undo'), onClick: () => {
        Store.undelete('locations', id);
        _toast(I18n.t('editmode.locationRestored'));
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
    if (!name) { _toast(I18n.t('editmode.titleRequired'), false); return; }
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
      ..._collectVisibility(uid),
    });
    _runAfterSave('event', newId);
    _toast(I18n.t('editmode.eventSaved'));
    _markClean();
    _refreshTo(`#/udalost/${newId}`);
  }

  function deleteEvent(id) {
    Store.deleteEvent(id);
    _toast(I18n.t('editmode.eventDeleted'), true, {
      action: { label: '↶ ' + I18n.t('action.undo'), onClick: () => {
        Store.undelete('events', id);
        _toast(I18n.t('editmode.eventRestored'));
      }},
    });
    window.location.hash = "#/casova-osa";
  }

  // Merge all player-party characters into the given MultiSelect mount.
  function addPartyToEvent(mountId) {
    const el = document.getElementById(mountId);
    if (!el || !el._multiselect) { _toast(I18n.t('editmode.widgetNotReady'), false); return; }
    const partyIds = Store.getPartyMembers().map(c => c.id);
    if (!partyIds.length) { _toast(I18n.t('editmode.partyEmpty'), false); return; }
    const current = el._multiselect.getValue();
    const merged  = Array.from(new Set([...current, ...partyIds]));
    const added   = merged.length - current.length;
    el._multiselect.setValue(merged);
    _toast(added ? I18n.plural('editmode.addedChars', added) : I18n.t('editmode.allAlreadyAdded'));
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
    if (!name) { _toast(I18n.t('editmode.titleRequired'), false); return; }
    const newId = originalId || Store.generateId(name);
    // Preserve fields this editor does not expose, such as clues.
    const existing = originalId
      ? (Store.getMysteries().find(m => m.id === originalId) || {})
      : {};
    // Questions: {text, answer} pairs from the QA list. The editor's
    // _qaVals drops rows whose question text is empty.
    const questions = _qaVals(`mf-questions-${uid}`);
    Store.saveMystery({
      ...existing,
      id: newId, name,
      priority:    document.getElementById(`mf-pri-${uid}`)?.value         || "střední",
      description: document.getElementById(`mf-desc-${uid}`)?.value.trim() || "",
      characters:  _checkVals(`mf-chars-${uid}`),
      questions,
      ..._collectVisibility(uid),
    });
    _toast(I18n.t('editmode.mysterySaved'));
    _markClean();
    _refreshTo(`#/zahada/${newId}`);
  }

  function deleteMystery(id) {
    Store.deleteMystery(id);
    _toast(I18n.t('editmode.mysteryDeleted'), true, {
      action: { label: '↶ ' + I18n.t('action.undo'), onClick: () => {
        Store.undelete('mysteries', id);
        _toast(I18n.t('editmode.mysteryRestored'));
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
    if (!name) { _toast(I18n.t('editmode.titleRequired'), false); return; }
    const newId     = originalId || Store.generateId(name);
    const color     = document.getElementById(`ff-color-text-${uid}`)?.value.trim() || "#555555";
    const textColor = document.getElementById(`ff-textcolor-text-${uid}`)?.value.trim() || "#E0E0E0";
    const badge     = document.getElementById(`ff-badge-${uid}`)?.value.trim() || "⚐";
    const desc      = document.getElementById(`ff-desc-${uid}`)?.value.trim() || "";

    const chainEls  = document.querySelectorAll(`#chains-${uid} .rank-chain-edit`);
    const rankChains = Array.from(chainEls).map(el => {
      const chainName = el.querySelector('.rank-chain-name')?.value.trim() || "";
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
    Store.saveFaction(newId, {
      ...existing, name, color, textColor, badge,
      description: desc, rankChains, attitudes,
      ..._collectVisibility(uid),
    });
    _toast(I18n.t('editmode.factionSaved'));
    _markClean();
    _refreshTo(`#/frakce/${newId}`);
  }

  function deleteFaction(id) {
    Store.deleteFaction(id);
    _toast(I18n.t('editmode.factionDeleted'), true, {
      action: { label: '↶ ' + I18n.t('action.undo'), onClick: () => {
        Store.undelete('factions', id);
        _toast(I18n.t('editmode.factionRestored'));
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

  // ── Faction-change reveal: hide NPC-only fields for PCs ───────
  // Wired via dataOn('change', …) on the faction <select>. The
  // wrapped block (#ef-npc-only-${uid}) holds every field that
  // doesn't apply to party PCs — today just the "Postoje k partě"
  // chip row. Future stance/perception fields slot into the same
  // wrapper. Save-time stripping in `saveCharacter` handles the
  // data; this handler is purely about the visible form.
  function onCharacterFactionChange(uid, value) {
    const block = document.getElementById(`ef-npc-only-${uid}`);
    if (!block) return;
    block.style.display = (value === PARTY_FACTION_ID) ? 'none' : '';
  }

  // ── EasyMDE mount ─────────────────────────────────────────────
  // EasyMDE wraps a <textarea> in a CodeMirror instance plus a toolbar,
  // toolbar buttons, and several DOCUMENT-level event listeners
  // (fullscreen toggle, side-by-side preview, etc.). When `navigate()`
  // replaces #main-content via `innerHTML = '...'`, every one of those
  // textareas becomes detached, but the CodeMirror wrappers and their
  // document-level listeners stay rooted in memory — they have no idea
  // their host went away. Without explicit teardown, every route change
  // leaks the previous editor.
  //
  // The fix is the registry below. Every mount records its instance in
  // `_mountedEasyMDE`; on the next mount pass `_cleanupOrphanedEasyMDE`
  // walks the set, finds entries whose textarea is no longer connected,
  // and calls `mde.toTextArea()` (the documented teardown that removes
  // the wrapper, restores the textarea, and unbinds listeners). Without
  // this, navigating between editor pages a few dozen times noticeably
  // slows the entire app because each leaked instance still receives
  // every captured-phase document event.
  const _mountedEasyMDE = new Set();
  function _cleanupOrphanedEasyMDE() {
    for (const mde of _mountedEasyMDE) {
      const ta = mde.element || (mde.codemirror?.getTextArea?.() ?? null);
      if (ta && ta.isConnected) continue;
      try { mde.toTextArea(); } catch (_) { /* already torn down */ }
      _mountedEasyMDE.delete(mde);
    }
  }

  /**
   * Upgrade every `<textarea class="md-easy">` inside `root` (default:
   * the whole document) into a CodeMirror-backed EasyMDE editor. Skips
   * already-mounted textareas (marked via `data-md-mounted`) so it's
   * safe to call repeatedly — `app.js`'s `navigate()` calls this on
   * every route change.
   *
   * `forceSync: true` keeps each underlying textarea's `.value`
   * up-to-date on every keystroke, so existing save code that reads
   * `document.getElementById(id).value` keeps working unchanged.
   *
   * Side-effects: sweeps orphaned instances first (see registry note
   * above), wires draft autosave on each new editor.
   *
   * @param {Element|Document} [root] - Subtree to scan for textareas.
   */
  // Fill addon-contributed editor-field slots (registerEditorFields). The
  // character editor template emits an empty `.addon-editor-fields` placeholder;
  // we resolve the entity from its data-addon-uid, let the host render each
  // addon's block, then mount widgets inside. Runs from mountEasyMDE (called on
  // every navigate) BEFORE the EasyMDE walk, so any `.md-easy` an addon emits is
  // picked up by that same walk.
  function _mountAddonEditorFields(root) {
    const scope = root || document;
    // One-shot per slot (data-addon-mounted): the slot is NAVIGATION-scoped, not
    // reconcile-scoped. Enabling an editor-fields addon while an editor is open
    // won't inject its fields into the already-mounted slot until the next
    // navigate() rebuilds it (the addons-changed SSE handler re-navigates, so it
    // self-heals on any route change) — acceptable since live install-while-editing
    // is rare.
    const slots = scope.querySelectorAll('.addon-editor-fields:not([data-addon-mounted])');
    slots.forEach(slot => {
      slot.setAttribute('data-addon-mounted', '1');
      const kind = slot.dataset.addonKind || '';
      const uid  = slot.dataset.addonUid || '';
      let entity = null;
      if (kind === 'characters' && uid && uid !== 'new') entity = Store.getCharacter(uid);
      let html = '';
      try { html = Addons.editorFields(kind, entity) || ''; }
      catch (e) { console.error('[addons] editorFields failed', e); }
      slot.innerHTML = html;
      if (html) { try { Widgets.mountAll(slot); } catch (_) {} }
    });
  }

  function _applyMarkdownFormat(editor, formatId) {
    const cm = editor?.codemirror;
    if (!cm) return;
    const from = cm.indexFromPos(cm.getCursor('from'));
    const to = cm.indexFromPos(cm.getCursor('to'));
    const result = editMarkdownSelection(
      cm.getValue(),
      from,
      to,
      formatId,
      I18n.t('markdown.placeholder.styledText'),
    );

    if (result.reason === 'inline-only') {
      _toast(I18n.t('markdown.inlineOnly'), false);
      cm.focus();
      return;
    }
    if (!result.changed) {
      cm.focus();
      return;
    }

    cm.operation(() => {
      cm.replaceRange(
        result.replacement,
        cm.posFromIndex(result.from),
        cm.posFromIndex(result.to),
        '+markdown-format',
      );
      cm.setSelection(
        cm.posFromIndex(result.selectionStart),
        cm.posFromIndex(result.selectionEnd),
      );
    });
    cm.focus();
  }

  function _markdownHeadingMenu() {
    return {
      name: 'md-headings',
      className: 'md-format-trigger md-format-headings',
      title: I18n.t('markdown.toolbar.headings'),
      text: 'H',
      children: [1, 2, 3].map(level => ({
        name: `heading-${level}`,
        action: window.EasyMDE[`toggleHeading${level}`],
        className: 'md-format-option md-heading-option',
        title: I18n.t(`markdown.heading.level${level}`),
        text: `H${level}`,
      })),
    };
  }

  function _markdownFormatMenus() {
    return MARKDOWN_FORMAT_GROUPS.map(group => ({
      name: `md-${group.id}`,
      className: `md-format-trigger ${group.toolbarClass}`,
      title: I18n.t(group.labelKey),
      text: group.toolbarText,
      children: group.items.map(format => ({
        name: format.id,
        action: editor => _applyMarkdownFormat(editor, format.id),
        className: [
          'md-format-option',
          format.tone ? `md-format-tone-${format.tone}` : '',
          format.operation !== 'wrap' ? `md-format-${format.operation}` : '',
        ].filter(Boolean).join(' '),
        title: I18n.t(format.labelKey),
        text: I18n.t(format.labelKey),
        attributes: { 'data-md-format': format.id },
      })),
    }));
  }

  function _enhanceMarkdownToolbar(mde) {
    const toolbar = mde?.toolbar_div;
    if (!toolbar) return;
    const editorKey = String(mde.element?.id || 'markdown').replace(/[^A-Za-z0-9_-]/g, '-');
    toolbar.querySelectorAll('.md-format-trigger').forEach((trigger, triggerIndex) => {
      trigger.tabIndex = 0;
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', 'false');
      const menu = trigger.querySelector('.easymde-dropdown-content');
      if (!menu) return;
      menu.id = `${editorKey}-format-menu-${triggerIndex}`;
      menu.setAttribute('role', 'menu');
      trigger.setAttribute('aria-controls', menu.id);
      trigger.addEventListener('focusin', () => trigger.setAttribute('aria-expanded', 'true'));
      trigger.addEventListener('focusout', event => {
        if (!trigger.contains(event.relatedTarget)) trigger.setAttribute('aria-expanded', 'false');
      });
      const items = [...menu.querySelectorAll('button')];
      items.forEach((item, index) => {
        item.tabIndex = 0;
        item.setAttribute('role', 'menuitem');
        item.addEventListener('keydown', event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            mde.codemirror.focus();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            items[(index + direction + items.length) % items.length].focus();
          }
        });
      });
      trigger.addEventListener('keydown', event => {
        if (event.target === trigger && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          items[0]?.focus();
        }
      });
    });
  }

  function mountEasyMDE(root) {
    _cleanupOrphanedEasyMDE();
    _mountAddonEditorFields(root);
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
            _markdownHeadingMenu(),
            ..._markdownFormatMenus(), '|',
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
        _enhanceMarkdownToolbar(mde);
        _wireEasyMDEDraft(mde, ta);
      } catch (e) {
        console.warn('EasyMDE mount failed', e);
      }
    });
  }

  // ── Twin operations (DM-only) ──────────────────────────────────
  // Thin wrappers around Store.linkTwin that surface a toast and
  // navigate to the new twin on create. The data-action dispatcher
  // calls these with (collection, sourceId) from the editor buttons
  // injected by EditTemplates._dmSection.
  async function createTwin(collection, sourceId) {
    if (isDirty() && !confirm(I18n.t('editmode.unsavedEditorContinueQ'))) return;
    _closeTwinPicker();
    const r = await Store.linkTwin('create', collection, sourceId);
    if (!r.ok) { _toast(I18n.t('editmode.twinCreateFailed'), false); return; }
    _toast(I18n.t('editmode.twinCreated'));
    const route = CollectionDescriptors.routeForCollection(collection, r.twinId);
    if (route && r.twinId) _refreshTo(`#${route}`);
  }
  async function unlinkTwin(collection, sourceId) {
    if (!confirm(I18n.t('editmode.twinUnlinkQ'))) return;
    const r = await Store.linkTwin('unlink', collection, sourceId);
    if (!r.ok) { _toast(I18n.t('editmode.twinUnlinkFailed'), false); return; }
    _toast(I18n.t('editmode.twinUnlinked'));
    // Stay on current entity; the SSE refresh re-renders it.
    window.dispatchEvent(new Event('hashchange'));
  }
  async function linkExistingTwin(collection, sourceId, targetId) {
    const r = await Store.linkTwin('link', collection, sourceId, targetId);
    if (!r.ok) { _toast(I18n.t('editmode.twinLinkFailed'), false); return; }
    _closeTwinPicker();
    _toast(I18n.t('editmode.twinLinked'));
    window.dispatchEvent(new Event('hashchange'));
  }

  // ─ Twin picker modal ───────────────────────────────────────────
  // Opens when the DM clicks "🔗 Připojit twin" on an unlinked entity.
  // Top row: [Zrušit] + [Vytvořit nový twin] — both always visible.
  // Below: search input (autofocus, pre-filled with source name and
  // selected so the first keystroke replaces it) + a scrollable
  // candidate list ranked by Jaro–Winkler similarity to whatever's
  // currently in the search box.
  //
  // Candidates are filtered to: same collection, opposite visibility,
  // no existing twin, not the source itself. The server enforces the
  // same constraints on POST /api/twin action:'link'.
  let _picker = null;          // { root, overlay, input, list, footer, source, collection, candidates, highlighted }
  function _ensurePickerDom() {
    if (_picker) return _picker;
    const overlay = document.createElement('div');
    overlay.className = 'twin-picker-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="twin-picker-card" role="dialog" aria-modal="true" aria-label="${esc(I18n.t('editmode.twinPickerTitle'))}">
        <div class="twin-picker-actions">
          <button type="button" class="twin-picker-btn twin-picker-btn-cancel" data-action="EditMode.cancelTwinPicker">✕ ${esc(I18n.t('action.cancel'))}</button>
          <button type="button" class="twin-picker-btn twin-picker-btn-create" data-action="EditMode.createTwinFromPicker">✨ ${esc(I18n.t('editmode.twinCreateNew'))}</button>
        </div>
        <div class="twin-picker-search-row">
          <input type="text" class="twin-picker-search" placeholder="${esc(I18n.t('editmode.searchByName'))}" autocomplete="off">
        </div>
        <div class="twin-picker-list" role="listbox"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const card  = overlay.querySelector('.twin-picker-card');
    const input = overlay.querySelector('.twin-picker-search');
    const list  = overlay.querySelector('.twin-picker-list');

    // Backdrop click closes the picker. Clicks inside the card do
    // NOT propagate to the overlay (otherwise the modal would close
    // when the DM clicks the search input).
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) _closeTwinPicker();
    });
    card.addEventListener('click', (ev) => ev.stopPropagation());

    // Live search — re-rank candidates on every input event.
    input.addEventListener('input', () => _renderPickerCandidates());

    // Keyboard nav: Esc closes; Enter links the highlighted; ↑↓ moves.
    overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); _closeTwinPicker(); return; }
      if (ev.key === 'Enter')  { ev.preventDefault(); _pickerLinkHighlighted(); return; }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); _movePickerHighlight(+1); return; }
      if (ev.key === 'ArrowUp')   { ev.preventDefault(); _movePickerHighlight(-1); return; }
    });

    _picker = { overlay, card, input, list, source: null, collection: null, candidates: [], highlighted: 0 };
    return _picker;
  }

  function openTwinPicker(collection, sourceId) {
    if (!Role.isDM()) { _toast(I18n.t('editmode.dmOnly'), false); return; }
    const source = Store.getCollection(collection).find(e => e && e.id === sourceId);
    if (!source) { _toast(I18n.t('editmode.entityNotFound'), false); return; }
    if (source.linkedTwinId) { _toast(I18n.t('editmode.entityAlreadyHasTwin'), false); return; }

    const p = _ensurePickerDom();
    p.collection = collection;
    p.source     = source;

    // Build the candidate pool ONCE per open: same collection,
    // opposite visibility, no existing twin, not the source itself.
    const targetVis = source.visibility === 'dm' ? 'public' : 'dm';
    const pool = Store.getCollection(collection).filter(e =>
      e && e.id !== source.id
      && !e.linkedTwinId
      && ((e.visibility === 'dm') ? 'dm' : 'public') === targetVis
    );
    p.candidates = pool;
    p.highlighted = 0;

    p.input.value = source.name || '';
    p.input.select();
    _renderPickerCandidates();

    p.overlay.hidden = false;
    document.body.classList.add('twin-picker-open');
    if (p._trap) p._trap();
    p._trap = trapFocus(p.card);
    // Autofocus after the show so the browser doesn't reject the focus.
    requestAnimationFrame(() => { try { p.input.focus(); p.input.select(); } catch (_) {} });
  }

  function _renderPickerCandidates() {
    if (!_picker) return;
    const p = _picker;
    const query  = p.input.value;
    const queryN = norm(query);

    // Rank by Jaro–Winkler similarity to the CURRENT search box value
    // (not the source name) so the DM can type any name and have the
    // list re-sort. A substring boost helps "Frula" → "Frulam" rank
    // above same-JW candidates whose match comes from transpositions.
    const ranked = p.candidates
      .map(e => {
        const nameN = norm(e.name);
        const score = jaroWinkler(query, e.name);
        const substringBoost = (queryN && nameN.includes(queryN)) ? 0.05 : 0;
        return { entity: e, score: Math.min(1, score + substringBoost) };
      })
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      p.list.innerHTML = `<div class="twin-picker-empty">${esc(I18n.t('editmode.noMatchingEntities'))}</div>`;
      p.highlighted = -1;
      return;
    }

    p.highlighted = 0;
    // Stash the ranked entity ids in order on the wrapper so
    // _pickerLinkHighlighted can resolve them by index without
    // re-running the sort.
    p._rankedIds = ranked.map(r => r.entity.id);

    p.list.innerHTML = ranked.map((r, idx) => {
      const pct = Math.round(r.score * 100);
      const colorClass = pct >= 80 ? 'twin-picker-score-high'
                        : pct >= 50 ? 'twin-picker-score-mid'
                                    : 'twin-picker-score-low';
      const visBadge = r.entity.visibility === 'dm' ? '🛡 DM' : ('👤 ' + esc(I18n.t('editmode.playerBadge')));
      return `
        <button type="button" class="twin-picker-row${idx === 0 ? ' is-highlighted' : ''}"
                role="option" data-idx="${idx}"
                data-action="EditMode.linkExistingTwin"
                data-args='${esc(JSON.stringify([p.collection, p.source.id, r.entity.id]))}'>
          <span class="twin-picker-row-name">${esc(r.entity.name || r.entity.id)}</span>
          <span class="twin-picker-row-meta">
            <span class="twin-picker-row-vis">${visBadge}</span>
            <span class="twin-picker-row-score ${colorClass}">${esc(I18n.t('editmode.matchPercent', { pct }))}</span>
          </span>
        </button>`;
    }).join('');
  }

  function _movePickerHighlight(delta) {
    if (!_picker || !_picker._rankedIds || _picker._rankedIds.length === 0) return;
    const max = _picker._rankedIds.length - 1;
    _picker.highlighted = Math.max(0, Math.min(max, (_picker.highlighted ?? 0) + delta));
    const rows = _picker.list.querySelectorAll('.twin-picker-row');
    rows.forEach((row, idx) => row.classList.toggle('is-highlighted', idx === _picker.highlighted));
    rows[_picker.highlighted]?.scrollIntoView({ block: 'nearest' });
  }

  function _pickerLinkHighlighted() {
    if (!_picker || !_picker._rankedIds) return;
    const targetId = _picker._rankedIds[_picker.highlighted];
    if (!targetId) return;
    linkExistingTwin(_picker.collection, _picker.source.id, targetId);
  }

  function _closeTwinPicker() {
    if (!_picker) return;
    if (_picker._trap) { _picker._trap(); _picker._trap = null; }
    _picker.overlay.hidden = true;
    document.body.classList.remove('twin-picker-open');
    _picker.source = null;
    _picker.collection = null;
    _picker.candidates = [];
    _picker._rankedIds = null;
  }

  // Action-dispatcher entry points for the modal's static buttons.
  function cancelTwinPicker() { _closeTwinPicker(); }
  function createTwinFromPicker() {
    if (!_picker || !_picker.collection || !_picker.source) return;
    createTwin(_picker.collection, _picker.source.id);
  }

  // ══════════════════════════════════════════════════════════════
  //  PET EDITOR (Mazlíčci) — lightweight modal
  // ══════════════════════════════════════════════════════════════
  // Pets are a lightweight collection edited through a small modal
  // overlay (no route / article shell), so they can be created and
  // reassigned from anywhere — the Mazlíčci page, the dashboard, a
  // faction or character article. Owner is polymorphic: none / party
  // / a specific character / a faction. Image upload reuses the
  // character portrait pipeline (Store.uploadPortrait keyed by the
  // pet id) and is gated until the pet has been saved once.
  let _petModalEl = null;
  let _petModalTrap = null;

  function _petModalKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); _closePetModal(); }
  }
  function _closePetModal() {
    if (_petModalTrap) { _petModalTrap(); _petModalTrap = null; }
    if (_petModalEl) { _petModalEl.remove(); _petModalEl = null; }
    document.removeEventListener('keydown', _petModalKey, true);
  }

  /** Open the pet create/edit modal. `petId` null → new pet (with an
   *  optional `prefill`, e.g. {ownerType:'faction', ownerId} from a
   *  faction page). Anonymous viewers get the login modal instead. */
  function openPetEditor(petId, prefill) {
    if (Role.isAnonymous()) { promptLogin(); return; }
    if (_petModalEl) return;                  // one modal at a time
    const existing = petId ? Store.getPet(petId) : null;
    const pet = existing ? { ...existing } : {
      id: '', name: '', icon: '🐾', portrait: '', species: '', note: '',
      ownerType: 'none', ownerId: '', ...(prefill || {}),
    };
    const isNew = !pet.id;

    const factions = Store.getFactions();
    const facOpts = Object.entries(factions).map(([fid, f]) =>
      `<option value="${esc(fid)}"${pet.ownerType === 'faction' && pet.ownerId === fid ? ' selected' : ''}>${esc((f.badge ? f.badge + ' ' : '') + f.name)}</option>`).join('');
    const otOpt = (val, label) => `<option value="${val}"${pet.ownerType === val ? ' selected' : ''}>${label}</option>`;

    const overlay = document.createElement('div');
    overlay.className = 'pet-modal';
    overlay.innerHTML = `
      <div class="pet-modal-backdrop"></div>
      <form class="pet-modal-panel" role="dialog" aria-modal="true" aria-labelledby="pet-modal-title" autocomplete="off">
        <div class="pet-modal-title" id="pet-modal-title">${isNew ? '🐾 ' + esc(I18n.t('editmode.petNew')) : '🐾 ' + esc(I18n.t('editmode.petEdit'))}</div>

        <div class="pet-modal-portrait">
          <div id="pet-portrait-preview" class="pet-portrait-preview">
            ${pet.portrait
              ? `<img src="${esc(pet.portrait)}?v=${Date.now()}" alt="">`
              : `<span class="pet-portrait-emoji">${esc(pet.icon || '🐾')}</span>`}
          </div>
          <input type="hidden" id="pet-portrait" value="${esc(pet.portrait || '')}">
          ${isNew
            ? `<div class="pet-modal-hint">${esc(I18n.t('editmode.petImageAfterSave'))}</div>`
            : `<label class="pet-modal-upload">📤 ${esc(I18n.t('editmode.uploadImage'))}
                 <input type="file" id="pet-portrait-file" accept="image/*" hidden></label>`}
        </div>

        <label class="pet-modal-row">
          <span class="pet-modal-label">${esc(I18n.t('editmode.petName'))}</span>
          <input type="text" id="pet-name" class="pet-modal-input" value="${esc(pet.name || '')}" placeholder="${esc(I18n.t('editmode.petNamePlaceholder'))}">
        </label>
        <label class="pet-modal-row">
          <span class="pet-modal-label">${esc(I18n.t('editmode.petEmoji'))}</span>
          <input type="text" id="pet-emoji" class="pet-modal-input pet-modal-emoji" value="${esc(pet.icon || '🐾')}" maxlength="4">
        </label>
        <label class="pet-modal-row">
          <span class="pet-modal-label">${esc(I18n.t('editmode.petSpecies'))}</span>
          <input type="text" id="pet-species" class="pet-modal-input" value="${esc(pet.species || '')}" placeholder="${esc(I18n.t('editmode.petSpeciesPlaceholder'))}">
        </label>
        <label class="pet-modal-row">
          <span class="pet-modal-label">${esc(I18n.t('editmode.petOwner'))}</span>
          <select id="pet-owner-type" class="pet-modal-input">
            ${otOpt('none', esc(I18n.t('editmode.petOwnerNone')))}
            ${otOpt('party', '🛡 ' + esc(I18n.t('editmode.petOwnerParty')))}
            ${otOpt('character', '👤 ' + esc(I18n.t('editmode.petOwnerCharacter')))}
            ${otOpt('faction', '⬡ ' + esc(I18n.t('editmode.petOwnerFaction')))}
          </select>
        </label>
        <div class="pet-modal-row" id="pet-owner-char-row">
          <span class="pet-modal-label"></span>
          <div class="cb-mount" data-cb-id="pet-owner-char" data-cb-source="character"
               data-cb-value="${esc(pet.ownerType === 'character' ? (pet.ownerId || '') : '')}"
               data-cb-placeholder="${esc(I18n.t('editmode.petPickCharacter'))}" data-cb-allow-empty="1"
               data-cb-empty-label="${esc(I18n.t('editmode.petNoneOption'))}"></div>
        </div>
        <div class="pet-modal-row" id="pet-owner-faction-row">
          <span class="pet-modal-label"></span>
          <select id="pet-owner-faction" class="pet-modal-input">${facOpts}</select>
        </div>
        <label class="pet-modal-row">
          <span class="pet-modal-label">${esc(I18n.t('editmode.petNote'))}</span>
          <input type="text" id="pet-note" class="pet-modal-input" value="${esc(pet.note || '')}" placeholder="${esc(I18n.t('editmode.petNotePlaceholder'))}">
        </label>

        <div class="pet-modal-actions">
          ${!isNew ? `<button type="button" class="pet-modal-btn pet-modal-delete">🗑 ${esc(I18n.t('action.delete'))}</button>` : ''}
          <span class="pet-modal-spacer"></span>
          <button type="button" class="pet-modal-btn pet-modal-cancel">${esc(I18n.t('action.cancel'))}</button>
          <button type="submit" class="pet-modal-btn pet-modal-save">${esc(I18n.t('action.save'))}</button>
        </div>
      </form>`;
    document.body.appendChild(overlay);
    _petModalEl = overlay;
    overlay.dataset.petId = pet.id || '';
    Widgets.mountAll(overlay);

    const sel     = overlay.querySelector('#pet-owner-type');
    const charRow = overlay.querySelector('#pet-owner-char-row');
    const facRow  = overlay.querySelector('#pet-owner-faction-row');
    const syncRows = () => {
      charRow.style.display = sel.value === 'character' ? '' : 'none';
      facRow.style.display  = sel.value === 'faction'   ? '' : 'none';
    };
    sel.addEventListener('change', syncRows);
    syncRows();

    overlay.querySelector('.pet-modal-panel').addEventListener('submit', (e) => { e.preventDefault(); savePet(); });
    overlay.querySelector('.pet-modal-cancel').addEventListener('click', _closePetModal);
    overlay.querySelector('.pet-modal-backdrop').addEventListener('click', _closePetModal);
    const delBtn = overlay.querySelector('.pet-modal-delete');
    if (delBtn) delBtn.addEventListener('click', () => deletePet(overlay.dataset.petId));
    const fileInput = overlay.querySelector('#pet-portrait-file');
    if (fileInput) fileInput.addEventListener('change', () => _petPortraitUpload(fileInput, overlay.dataset.petId));

    document.addEventListener('keydown', _petModalKey, true);
    _petModalTrap = trapFocus(overlay.querySelector('.pet-modal-panel'));
    requestAnimationFrame(() => overlay.querySelector('#pet-name')?.focus());
  }

  async function _petPortraitUpload(input, petId) {
    const file = input.files?.[0];
    if (!file || !petId) return;
    try {
      _toast(I18n.t('editmode.uploadingImage'));
      const url = await Store.uploadPortrait(file, petId);
      const hidden  = document.getElementById('pet-portrait');
      const preview = document.getElementById('pet-portrait-preview');
      if (hidden)  hidden.value = url;
      if (preview) preview.innerHTML = `<img src="${esc(url)}?v=${Date.now()}" alt="">`;
      _toast(I18n.t('editmode.imageUploaded'));
    } catch (e) {
      _toast(I18n.t('editmode.imageUploadError'), false);
      console.error(e);
    }
  }

  function savePet() {
    const get = (id) => document.getElementById(id);
    const name = (get('pet-name')?.value || '').trim();
    if (!name) { _toast(I18n.t('editmode.petNameRequired'), false); get('pet-name')?.focus(); return; }
    const id = (_petModalEl?.dataset.petId) || Store.generateId(name);
    let ownerType = get('pet-owner-type')?.value || 'none';
    let ownerId = '';
    if (ownerType === 'character')    ownerId = get('pet-owner-char')?.value || '';
    else if (ownerType === 'faction') ownerId = get('pet-owner-faction')?.value || '';
    // A typed owner with nothing actually selected falls back to unassigned.
    if ((ownerType === 'character' || ownerType === 'faction') && !ownerId) ownerType = 'none';

    const existing = id ? Store.getPet(id) : null;
    const pet = {
      ...(existing || {}),
      id, name,
      icon:     (get('pet-emoji')?.value || '🐾').trim() || '🐾',
      portrait: get('pet-portrait')?.value || '',
      species:  (get('pet-species')?.value || '').trim(),
      note:     (get('pet-note')?.value || '').trim(),
      ownerType, ownerId,
    };
    Store.savePet(pet);
    _closePetModal();
    _toast(I18n.t('editmode.petSaved'));
    _refreshTo(window.location.hash);
  }

  function deletePet(id) {
    if (!id) { _closePetModal(); return; }
    Store.deletePet(id);
    _closePetModal();
    _toast(I18n.t('editmode.petDeleted'), true, {
      action: { label: '↶ ' + I18n.t('action.undo'), onClick: () => {
        Store.undelete('pets', id);
        _toast(I18n.t('editmode.petRestored'));
        _refreshTo(window.location.hash);
      }},
    });
    _refreshTo(window.location.hash);
  }

  // ── Public API ─────────────────────────────────────────────────
  return {
    promptLogin, isDirty, discardDirty,
    openPetEditor, savePet, deletePet,
    addDynRow, addQARow, handlePortraitUpload,
    clearPortrait, updateKnowledgeLabel,
    handlePortraitChange, handleLocalMapChange,
    addRankChain, addRankRow,
    saveCharacter, deleteCharacter, onGenderChange, onCharacterFactionChange,
    addRelationship, updateRelationship, deleteRelationship, relTypeChanged,
    editRel, cancelRel,
    saveLocation, deleteLocation, uploadLocalMap,
    saveEvent, deleteEvent, addPartyToEvent,
    saveMystery, deleteMystery,
    saveFaction, deleteFaction,
    saveBuh, deleteBuh,
    saveArtifact, deleteArtifact,
    saveHistoricalEvent, deleteHistoricalEvent,
    createTwin, unlinkTwin, linkExistingTwin,
    openTwinPicker, cancelTwinPicker, createTwinFromPicker,
    mountEasyMDE,
    // Passthrough so the wiki read view can surface the same relationship
    // editor (add/update/delete + comboboxes) inline for editors; refresh
    // still goes through _refreshRelSection, keeping both in sync.
    getRelSectionHtml: EditTemplates.getRelSectionHtml,
    toast: _toast,
    renderCharacterEditor,
    renderLocationEditor,
    renderEventEditor,
    renderMysteryEditor,
    renderFactionEditor,
    renderBuhEditor,
    renderArtifactEditor,
    renderHistoricalEventEditor,
    startNewCharacter, startNewLocation, startNewEvent,
    startNewBuh, startNewArtifact,
    startNewHistoricalEvent,
    startNewCharacterInLocation,
  };

})();
