import { Store } from './store.js';
import { PIN_TYPES, PIN_SIZE_MIN, PIN_SIZE_MAX } from './map.js';
// Relationship/connection kinds come from Store.getKinds('connections').
import { esc, dataAction, dataOn } from './utils.js';
import { I18n } from './i18n.js';

export const EditTemplates = (() => {

  function _dynRow(value) {
    return `<div class="dyn-item">
      <input class="edit-input" value="${esc(value)}" placeholder="…">
      <button class="dyn-remove-btn"${dataAction('removeAncestor', '$el')}>×</button>
    </div>`;
  }

  /** Multi-select chip row for "Postoje k partě" (attitudes).
   *  Each chip is a plain on/off toggle — the visual `intensity` of
   *  the resulting glow is set per-attitude in Settings, not per
   *  entity, so chips carry no per-chip sliders. Read back
   *  via `EditMode._readAttitudeChipRow(rowId)`. */
  function _attitudeChipRow(rowId, currentEntries) {
    const enums = Store.getEnum('attitudes') || [];
    // Tolerate the legacy `[{id, strength}]` and string-array shapes
    // so the editor doesn't wipe data if someone hits Save before
    // migrations finish on a very fresh install. The strength field
    // (when present) is dropped — it's now sourced from the enum.
    const checkedIds = new Set();
    for (const e of (currentEntries || [])) {
      if (typeof e === 'string') checkedIds.add(e);
      else if (e && e.id)        checkedIds.add(e.id);
    }
    const items = enums.map(a => {
      const checked = checkedIds.has(a.id);
      const color   = a.labelColor || a.bg || '#888';
      return `
        <div class="attitude-chip-item" data-att-id="${esc(a.id)}" style="--attitude-color: ${esc(color)}">
          <label class="attitude-chip">
            <input type="checkbox" value="${esc(a.id)}" ${checked ? 'checked' : ''}>
            <span class="attitude-chip-dot"></span>
            <span class="attitude-chip-label">${esc(a.label)}</span>
          </label>
        </div>`;
    }).join('');
    return `<div class="attitude-chip-row" id="${rowId}">${items}</div>`;
  }

  // ─ DM section (twin-aware) ───────────────────────────────────
  // Per-entity DM controls: only the visibility select (public /
  // DM) lives at the bottom of the editor. The twin link/unlink
  // row was promoted to the form header (see `_twinHeaderRow`)
  // so it's reachable without scrolling. The visibility select is
  // DISABLED whenever the entity has a linked twin — flipping
  // visibility on one side would put both sides in the same
  // space, an incoherent state. The server enforces the same
  // rule (400 on flip with twin set) as defence in depth.
  //
  // Wiki routes per collection — mirrors KIND_ROUTE in app.js so
  // this template module can construct twin-jump links without
  // importing anything from app.js. Keep in sync.
  const TWIN_ROUTE_PREFIX = {
    characters:       'postava',
    locations:        'misto',
    events:           'udalost',
    mysteries:        'zahada',
    factions:         'frakce',
    pantheon:         'buh',
    artifacts:        'artefakt',
    historicalEvents: 'historicka-udalost',
  };

  /** Render the twin link/badge/unlink controls for placement inside
   *  the editor's sticky header (between the title and save/delete).
   *  Returns empty string when the collection has no visibility model
   *  OR when the entity is unsaved (no id yet — same rule as the
   *  bottom DM section). CSS gates the whole element behind
   *  `body.is-dm` via `.edit-hdr-twin`. */
  function _twinHeaderRow(uid, entity, collection) {
    if (!Object.prototype.hasOwnProperty.call(TWIN_ROUTE_PREFIX, collection)) return '';
    const isNew = !entity || !entity.id;
    if (isNew) return '';  // can't twin an unsaved entity
    const linkedId = entity.linkedTwinId;
    const twin     = linkedId ? (Store.getTwin ? Store.getTwin(collection, entity) : null) : null;
    if (linkedId) {
      const route   = TWIN_ROUTE_PREFIX[collection];
      const twinNm  = twin ? twin.name : linkedId;
      const twinVis = twin && twin.visibility === 'dm' ? I18n.t('editform.twinVisDm') : I18n.t('editform.twinVisPlayer');
      return `
        <div class="edit-hdr-twin">
          <a class="dm-twin-badge dm-twin-badge-linked"
             href="#/${route}/${esc(linkedId)}"
             title="${esc(I18n.t('editform.twinOpen'))}">
            ✓ ${esc(twinNm)} <span class="dm-twin-badge-vis">(${esc(twinVis)})</span> →
          </a>
          <button type="button" class="dm-twin-btn dm-twin-btn-unlink" title="${esc(I18n.t('editform.twinUnlink'))}"
            ${dataAction('EditMode.unlinkTwin', collection, entity.id)}>🔗 ${esc(I18n.t('editform.twinUnlink'))}</button>
        </div>`;
    }
    const visibility    = entity.visibility === 'dm' ? 'dm' : 'public';
    const oppositeLabel = visibility === 'dm' ? I18n.t('editform.twinVisPlayer') : I18n.t('editform.twinVisDm');
    return `
      <div class="edit-hdr-twin">
        <button type="button" class="dm-twin-btn dm-twin-btn-link"
          ${dataAction('EditMode.openTwinPicker', collection, entity.id)}>
          🔗 ${esc(I18n.t('editform.twinLink', { label: oppositeLabel }))}
        </button>
      </div>`;
  }

  /** Build the DM-only controls section for an edit form. Returns
   *  empty string when the collection doesn't participate in the
   *  visibility model (the template just doesn't render anything).
   *  CSS gates the whole thing behind `body.is-dm` so non-DM
   *  viewers never see it.
   *
   *  @param {string} uid          - The form's per-entity unique id.
   *  @param {object} entity       - The current record (or new-record defaults).
   *  @param {string} collection   - Collection name, e.g. 'characters'.
   *  @param {{isPc?: boolean}} [opts] - When true, the DM-only option is
   *                                     disabled (PCs are pinned public).
   *  @returns {string}
   */
  function _dmSection(uid, entity, collection, opts = {}) {
    if (!Object.prototype.hasOwnProperty.call(TWIN_ROUTE_PREFIX, collection)) return '';
    const visibility = (entity && entity.visibility === 'dm') ? 'dm' : 'public';
    const isPc       = !!opts.isPc;
    const linkedId   = entity && entity.linkedTwinId;

    // Visibility select. Disabled when a twin exists (flip would
    // break the pair — twin controls now live in the header) OR
    // when the entity is a PC (server-pinned public).
    const visDisabled = (linkedId || isPc) ? 'disabled' : '';
    const visNote = isPc
      ? `<small class="edit-hint">${esc(I18n.t('editform.visNotePc'))}</small>`
      : linkedId
        ? `<small class="edit-hint">${esc(I18n.t('editform.visNoteTwin'))}</small>`
        : '';

    return `
      <div class="edit-section visibility-section" id="vis-section-${esc(uid)}">
        <div class="edit-section-title">🛡 ${esc(I18n.t('editform.visTitle'))}</div>
        <div class="edit-field">
          <label class="edit-label">${esc(I18n.t('editform.visLabel'))}</label>
          <select class="edit-select" id="vis-${esc(uid)}" ${visDisabled}>
            <option value="public" ${visibility==='public'?'selected':''}>${esc(I18n.t('editform.visPublic'))}</option>
            <option value="dm"     ${visibility==='dm'?'selected':''}>${esc(I18n.t('editform.visDmOnly'))}</option>
          </select>
          ${visNote}
        </div>
      </div>`;
  }

  /** Read the DM section's state back out. Returns `{ visibility }`
   *  with canonicalised value. Falls back to `'public'` when the
   *  section isn't on the page (player views or stripped-down
   *  editors). `linkedTwinId` and twin pairing are server-managed
   *  via /api/twin — not part of the form submission.
   *
   *  @param {string} uid - The form's per-entity unique id.
   *  @returns {{visibility: 'public'|'dm'}}
   */
  function _readDmSection(uid) {
    const sel = document.getElementById(`vis-${uid}`);
    const visibility = (sel && sel.value === 'dm') ? 'dm' : 'public';
    return { visibility };
  }

  // Back-compat aliases — old helper names still used by save
  // handlers in editmode.js. Both delegate to the new twin-aware
  // implementations.
  const _visibilitySection      = _dmSection;
  const _readVisibilitySection  = _readDmSection;

  /** Sort characters by faction order then alphabetically, with faction badge prefix.
   *  Returns the sorted array (does not mutate the original). */
  function _sortedChars(chars) {
    const factions = Store.getFactions();
    const fOrder   = Object.keys(factions);
    return [...chars].sort((a, b) => {
      const fa = fOrder.indexOf(a.faction);
      const fb = fOrder.indexOf(b.faction);
      const ia = fa < 0 ? 999 : fa;
      const ib = fb < 0 ? 999 : fb;
      if (ia !== ib) return ia - ib;
      return (a.name || '').localeCompare(b.name || '', 'cs');
    });
  }

  function _charBadge(c) {
    if (c && c.faction === 'party') {
      const pp = Store.getPlayerParty();
      return (pp.badge || pp.icon || '🛡') + ' ';
    }
    const f = Store.getFactions()[c.faction];
    return f ? f.badge + ' ' : '';
  }

  // Relationship/connection types come from the data-driven CONNECTION KINDS
  // registry (Store.getKinds('connections') — settings, seeded from REL_TYPES,
  // plus any addon-registered kinds). Resolved PER CALL so DM/addon edits + a
  // language switch show without a reload.
  const _relKinds  = () => Store.getKinds('connections');
  const _relIds    = () => _relKinds().map(t => t.id);
  const _relConfig = () => Object.fromEntries(_relKinds().map(t => [t.id, t]));

  // Direction labels read lazily (per-render) so a language switch is
  // reflected — a module-level frozen object would capture boot-time text.
  function _dirLabel(d) {
    if (d === 'from') return I18n.t('editform.dirFrom');
    if (d === 'to')   return I18n.t('editform.dirTo');
    if (d === 'both') return I18n.t('editform.dirBoth');
    return d;
  }

  /** Build a Combobox placeholder for the relationship target picker.
   *  Replaces the legacy <select> + <option> list — values are still readable
   *  via document.getElementById(`${prefix}-target`).value because the
   *  Combobox renders a hidden <input type="hidden"> with that id. */
  function _targetMount(type, charId, selectedId, prefix) {
    const all     = _relConfig();
    const cfg     = all[type] || all.commands || { target: 'character' };
    const source  = cfg.target === 'location' ? 'location' : 'character';
    const exclude = cfg.target === 'character' ? charId : '';
    const placeholder = cfg.target === 'location' ? I18n.t('editform.pickLocation') : I18n.t('editform.pickCharacter');
    return `<div class="cb-mount rel-target-cb"
              data-cb-id="${prefix}-target"
              data-cb-source="${source}"
              data-cb-exclude="${esc(exclude)}"
              data-cb-value="${esc(selectedId || '')}"
              data-cb-placeholder="${esc(placeholder)}"
              data-cb-on-create="${source}"></div>`;
  }

  /** Build <option> list for directions based on type config */
  function _dirOpts(type, selectedDir) {
    const all = _relConfig();
    const cfg = all[type] || all.commands || {};
    const dirs = Array.isArray(cfg.dirs) ? cfg.dirs : ['from', 'to'];
    return dirs.map(d =>
      `<option value="${d}" ${d===selectedDir?'selected':''}>${esc(_dirLabel(d))}</option>`
    ).join('');
  }

  /** Render a single relationship row (existing or new) */
  function _relRow(charId, r, idx) {
    const isNew    = idx === 'new';
    const prefix   = isNew ? `rf-new-${charId}` : `rf-${idx}-${charId}`;
    const _cfg     = _relConfig();
    const type     = r ? r.type : (_relIds()[0] || 'commands');
    const label    = r ? (r.label || '') : '';

    // Determine current direction and other end from existing relationship
    let dir = 'from', targetId = '';
    if (r) {
      if (r.source === charId)      { dir = 'from'; targetId = r.target; }
      else if (r.target === charId) { dir = 'to';   targetId = r.source; }
    }

    const typeOpts   = _relIds().map(rid =>
      `<option value="${rid}" ${rid===type?'selected':''}>${esc((_cfg[rid] && _cfg[rid].label) || rid)}</option>`
    ).join('');
    const dirOptions = _dirOpts(type, dir);
    const tgtMount   = _targetMount(type, charId, targetId, prefix);

    const saveAttr = isNew
      ? dataAction('EditMode.addRelationship', charId)
      : dataAction('EditMode.updateRelationship', charId, idx);
    const deleteBtn  = isNew ? '' :
      `<button class="rel-delete-btn" title="${esc(I18n.t('action.delete'))}"
         ${dataAction('EditMode.deleteRelationship', r.source, r.target, r.type, charId)}>×</button>`;
    const saveLabel  = isNew ? '+ ' + I18n.t('action.add') : '💾';
    const saveTitle  = isNew ? I18n.t('editform.addRelationship') : I18n.t('editform.saveChanges');

    return `<div class="rel-edit-row" data-idx="${idx}">
      <select class="edit-select edit-select-sm" id="${prefix}-type"
        ${dataOn('change', 'EditMode.relTypeChanged', charId, prefix)}>${typeOpts}</select>
      <select class="edit-select edit-select-sm" id="${prefix}-dir">${dirOptions}</select>
      <div class="rel-target-wrap">${tgtMount}</div>
      <input class="edit-input edit-input-sm" id="${prefix}-label" value="${esc(label)}"
        placeholder="${esc((_cfg[type] && _cfg[type].label) || type)}">
      <button class="edit-add-btn"${saveAttr} title="${esc(saveTitle)}">${esc(saveLabel)}</button>
      ${deleteBtn}
      <button type="button" class="rel-cancel-btn" title="${esc(I18n.t('action.cancel'))}"${dataAction('EditMode.cancelRel', charId)}>↩</button>
    </div>`;
  }

  // A saved relationship as a pretty, clickable chip — the other end's name +
  // direction + relation label. Clicking opens that one connection for editing
  // (EditMode.editRel). `isOpen` highlights the connection being edited.
  function _relChip(charId, r, idx, isOpen) {
    const otherId  = r.source === charId ? r.target : r.source;
    const other    = Store.getCharacter(otherId) || Store.getLocation(otherId);
    const name     = other ? other.name : otherId;
    const dir      = r.source === charId ? '→' : '←';
    const cfg      = _relConfig();
    const relLabel = r.label || (cfg[r.type] && cfg[r.type].label) || r.type;
    return `<button type="button" class="rel-chip-editable${isOpen ? ' is-open' : ''}" title="${esc(I18n.t('action.edit'))}"`
      + `${dataAction('EditMode.editRel', charId, idx)}>`
      + `<span class="rel-chip-name">${esc(name)}</span>`
      + `<span class="rel-chip-rel">${esc(dir)} ${esc(relLabel)}</span></button>`;
  }

  // Relationships: saved connections render as chips; clicking one reveals its
  // editor row below. `openIdx` = the index being edited, 'new' for the add
  // form, or null for the pretty read state (the form passes null → all chips
  // + an Add button). EditMode.editRel / cancelRel drive the open state.
  function _relSection(charId, openIdx = null) {
    const rels = Store.getRelationships().filter(r => r.source === charId || r.target === charId);
    const chips = rels.map((r, i) => _relChip(charId, r, i, String(i) === String(openIdx))).join('');
    const addBtn = openIdx === null
      ? `<button type="button" class="rel-add-btn"${dataAction('EditMode.editRel', charId, 'new')}>＋ ${esc(I18n.t('editform.addRelationship'))}</button>`
      : '';
    const chipRow = (rels.length || openIdx === null)
      ? `<div class="rel-chip-row">${chips || `<span class="edit-hint">${esc(I18n.t('editform.noRelationships'))}</span>`}${addBtn}</div>`
      : '';
    let editor = '';
    if (openIdx === 'new') editor = _relRow(charId, null, 'new');
    else if (openIdx !== null && rels[openIdx]) editor = _relRow(charId, rels[openIdx], openIdx);
    return `
      <div class="edit-section" id="rel-section-${charId}">
        <div class="edit-section-title">${esc(I18n.t('editform.relationships'))}</div>
        ${chipRow}
        ${editor ? `<div class="rel-edit-open">${editor}</div>` : ''}
      </div>`;
  }

  function renderCharacterEditor(c) {
    const isNew = !c || !c.id;
    if (isNew) {
      const defaults = { id:"", name:"", title:"", faction:"neutral", status:"alive",
                         knowledge:3, description:"", portrait:"", location:"",
                         rankChain:"", rank:"", locationRoles:[],
                         species:"", gender:"", age:"", circumstances:"",
                         known:[], unknown:[], tags:[] };
      c = { ...defaults, ...(c || {}) };
    }
    const uid = c.id || "new";
    const factions  = Store.getFactions();
    const statusMap = Store.getStatusMap();
    const KNAMES = [
      I18n.t('editform.know0'), I18n.t('editform.know1'), I18n.t('editform.know2'),
      I18n.t('editform.know3'), I18n.t('editform.know4'),
    ];

    // Synthetic "Naše parta" option at the top — the player party
    // moved out of the factions collection (it lives in
    // settings.playerParty now, edited via Settings → Naše parta),
    // but `character.faction === 'party'` is still the marker for
    // party membership. Surfacing it here keeps the character
    // editor's faction picker as the single place to set PC status.
    const pp = Store.getPlayerParty();
    const realFactions = Object.entries(factions).filter(([id]) => id !== 'party');
    // A character is "neutral / unaligned" when it isn't a party PC and its
    // faction id doesn't match a real faction — covers the default
    // `faction:'neutral'`, an empty value, or a deleted faction. We MUST offer
    // an explicit option for this: a <select> with no matching <option> falls
    // back to its FIRST entry, and on a fresh instance (no factions yet) that
    // first entry is "Naše parta" — silently turning every new NPC into a
    // party PC and hiding it from /postavy. List it first so it's the default
    // selection for new characters.
    const isRealFaction = realFactions.some(([id]) => id === c.faction);
    const neutralSelected = c.faction !== 'party' && !isRealFaction;
    const neutralOption = `<option value="neutral" ${neutralSelected ? "selected" : ""}>👤 ${esc(I18n.t('editform.noFaction'))}</option>`;
    const partyOption = `<option value="party" ${c.faction==='party'?"selected":""}>${esc(pp.badge || pp.icon || '🛡')} ${esc(pp.name || I18n.t('editform.ourParty'))}</option>`;
    const fOpts = neutralOption + partyOption + realFactions.map(([id,f]) =>
      `<option value="${esc(id)}" ${c.faction===id?"selected":""}>${esc(f.badge || '⬡')} ${esc(f.name)}</option>`).join("");
    // Include the current value even when it's an orphan (renamed/removed
    // enum id) so saving never silently flips it to the first option —
    // the same trap the mystery priority picker guards against. Labels
    // and icons are user-edited settings content → esc().
    const sEntries = Object.entries(statusMap);
    if (c.status && !statusMap[c.status]) sEntries.unshift([c.status, { icon: '', label: c.status }]);
    const sOpts = sEntries.map(([id,s]) =>
      `<option value="${esc(id)}" ${c.status===id?"selected":""}>${esc(s.icon)} ${esc(s.label)}</option>`).join("");
    // Attitudes (multi-pick chip row + per-chip strength slider).
    // Empty = no stance set; renderer falls back to the character's
    // faction. Party members (faction==='party') always render with the
    // `party` palette regardless of this field, so it's safe to leave
    // blank for PCs.
    const attitudeChipRowHtml = _attitudeChipRow(`ef-attitudes-${c.id || 'new'}`, c.attitudes || []);
    const knownRows   = (c.known   || []).map(_dynRow).join("");
    // `unknown[]` is now `{text, answer}` objects post-migration —
    // `_qaRowHtml` handles both shapes defensively (legacy string
    // entries render with answer:'').
    const unknownRows = (c.unknown || []).map(_qaRowHtml).join("");
    // PCs (c.faction === 'party') fall back to the player party's
    // badge from settings, not the generic 👤, so the portrait
    // placeholder for a PC matches the rest of the party branding.
    const badge = c.faction === 'party'
      ? (Store.getPlayerParty().badge || Store.getPlayerParty().icon || '🛡')
      : (factions[c.faction]?.badge || "👤");

    // Gender: dynamic list from user-editable settings + an "Ostatní
    // (specifikuj)" reveal for free-text values. Existing records may
    // hold either an id or a label — match both when picking the
    // currently-selected option so neither shape gets dropped on save.
    const genderList = Store.getKinds('genders');
    const currentGender = c.gender || '';
    const matchedGender = genderList.find(g => g.id === currentGender || g.label === currentGender);
    const isOtherGender = !!(currentGender && !matchedGender);
    const genderSelectValue = !currentGender ? '' : (isOtherGender ? '__other__' : (matchedGender?.id || ''));
    const genderOpts = [
      `<option value="" ${genderSelectValue===''?'selected':''}>${esc(I18n.t('editform.notSpecified'))}</option>`,
      ...genderList.map(g =>
        `<option value="${esc(g.id)}" ${genderSelectValue===g.id?'selected':''}>${esc(g.label)}</option>`
      ),
      `<option value="__other__" ${genderSelectValue==='__other__'?'selected':''}>${esc(I18n.t('editform.otherSpecify'))}</option>`,
    ].join('');

    // Species: free-text input (the species wiki collection was removed —
    // D&D species now live in a separate addon). `character.species` is a
    // plain string; keep the same id so the save-collect code is unchanged.
    const speciesMount = `<input class="edit-input"
      id="ef-species-${uid}"
      value="${esc(c.species || '')}"
      placeholder="${esc(I18n.t('editform.pickSpecies'))}">`;

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← ${esc(I18n.t('action.cancel'))}</button>
          <h2 class="edit-form-title">${isNew ? "✦ " + esc(I18n.t('editform.newCharacter')) : "✏ " + esc(c.name)}</h2>
          ${_twinHeaderRow(uid, c, 'characters')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveCharacter', c.id)}>💾 ${esc(I18n.t('action.save'))}</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteCharacter', c.id)}>🗑 ${esc(I18n.t('action.delete'))}</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-main-grid">
            <div class="edit-portrait-col">
              <div class="edit-portrait-preview" id="ep-preview-${uid}">
                ${c.portrait
                  ? `<img src="${esc(c.portrait)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:top">`
                  : `<span style="font-size:2.5rem">${esc(badge)}</span>`}
              </div>
              <label class="edit-upload-btn">
                📷 ${esc(I18n.t('editform.uploadPortrait'))}
                <input type="file" accept="image/*" style="display:none"
                  ${dataOn('change', 'EditMode.handlePortraitChange', uid, '$el')}>
              </label>
              ${c.portrait ? `<button class="edit-remove-portrait-btn"
                ${dataAction('EditMode.clearPortrait', uid, badge)}>
                × ${esc(I18n.t('action.remove'))}
              </button>` : ""}
              <input type="hidden" id="ep-data-${uid}" value="${esc(c.portrait)}">
            </div>
            <div class="edit-fields-col">
              <div class="edit-row-2">
                <div class="edit-field">
                  <label class="edit-label">${esc(I18n.t('editform.nameRequired'))}</label>
                  <input class="edit-input" id="ef-name-${uid}" value="${esc(c.name)}" placeholder="${esc(I18n.t('editform.charNamePh'))}">
                </div>
                <div class="edit-field">
                  <label class="edit-label">${esc(I18n.t('editform.titleShortDesc'))}</label>
                  <input class="edit-input" id="ef-title-${uid}" value="${esc(c.title)}" placeholder="${esc(I18n.t('editform.titlePh'))}">
                </div>
              </div>
              <div class="edit-row-2">
                <div class="edit-field">
                  <label class="edit-label">${esc(I18n.t('editform.faction'))}</label>
                  <select class="edit-select" id="ef-faction-${uid}"
                    ${dataOn('change', 'EditMode.onCharacterFactionChange', uid, '$value')}>${fOpts}</select>
                </div>
                <div class="edit-field">
                  <label class="edit-label">${esc(I18n.t('editform.status'))}</label>
                  <select class="edit-select" id="ef-status-${uid}">${sOpts}</select>
                </div>
              </div>
              <!-- NPC-only fields. Gated on Store.isPartyMember(c). When adding
                   new fields that don't apply to PCs (e.g. anything about
                   stance / outside perception / knowledge), add them inside
                   this wrapper so they participate in the same toggle. -->
              <div id="ef-npc-only-${uid}" style="${Store.isPartyMember(c) ? 'display:none' : ''}">
                <div class="edit-field">
                  <label class="edit-label" title="${esc(I18n.t('editform.attitudesHelp'))}">${esc(I18n.t('editform.attitudes'))} <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">${esc(I18n.t('editform.attitudesInheritHint'))}</span></label>
                  ${attitudeChipRowHtml}
                </div>
              </div>
              <div class="edit-row-3">
                <div class="edit-field">
                  <label class="edit-label">${esc(I18n.t('editform.species'))}</label>
                  ${speciesMount}
                </div>
                <div class="edit-field">
                  <label class="edit-label">${esc(I18n.t('editform.gender'))}</label>
                  <select class="edit-select" id="ef-gender-${uid}"
                    ${dataOn('change', 'EditMode.onGenderChange', uid)}>${genderOpts}</select>
                  <input class="edit-input" id="ef-gender-other-${uid}" type="text"
                    placeholder="${esc(I18n.t('editform.specifyPh'))}"
                    value="${isOtherGender ? esc(c.gender) : ''}"
                    style="margin-top:0.4rem;display:${isOtherGender ? '' : 'none'}">
                </div>
                <div class="edit-field">
                  <label class="edit-label">${esc(I18n.t('editform.age'))}</label>
                  <input class="edit-input" id="ef-age-${uid}" value="${esc(c.age)}" placeholder="${esc(I18n.t('editform.agePh'))}">
                </div>
              </div>
              <div class="edit-field">
                <label class="edit-label">${esc(I18n.t('editform.circumstances'))}</label>
                <input class="edit-input" id="ef-circumstances-${uid}" value="${esc(c.circumstances || '')}" placeholder="${esc(I18n.t('editform.circumstancesPh'))}">
              </div>
              <div class="edit-field">
                <label class="edit-label" id="ef-kl-${uid}">${esc(I18n.t('editform.knowledge'))} (${c.knowledge}/4) — ${esc(KNAMES[c.knowledge])}</label>
                <input type="range" class="edit-range" id="ef-knowledge-${uid}" min="0" max="4" value="${c.knowledge}"
                  ${dataOn('input', 'EditMode.updateKnowledgeLabel', uid)}>
                <div class="edit-range-labels"><span>${esc(I18n.t('editform.know0'))}</span><span>${esc(I18n.t('editform.know4'))}</span></div>
              </div>
            </div>
          </div>
          <div class="edit-section">
            <div class="edit-section-title">${esc(I18n.t('editform.whatWeKnow'))}</div>
            <div class="dyn-list" id="dyn-known-${uid}">${knownRows}</div>
            <button class="dyn-add-btn"${dataAction('EditMode.addDynRow', `dyn-known-${uid}`)}>+ ${esc(I18n.t('action.add'))}</button>
          </div>
          <div class="edit-section">
            <div class="edit-section-title">
              ${esc(I18n.t('editform.openQuestions'))}
              <span class="settings-hint" style="font-weight:normal">${esc(I18n.t('editform.questionAnswerHint'))}</span>
            </div>
            <div class="qa-list" id="dyn-unknown-${uid}">${unknownRows}</div>
            <button class="dyn-add-btn" type="button"${dataAction('EditMode.addQARow', `dyn-unknown-${uid}`)}>+ ${esc(I18n.t('editform.addQuestion'))}</button>
          </div>
          ${!isNew ? _relSection(c.id) : `
            <div class="edit-section">
              <div class="edit-section-title">${esc(I18n.t('editform.relationships'))}</div>
              <p class="edit-hint">${esc(I18n.t('editform.saveCharFirst'))}</p>
            </div>`}
          ${_visibilitySection(uid, c, 'characters', { isPc: Store.isPartyMember(c) })}
          <div class="addon-editor-fields" data-addon-kind="characters" data-addon-uid="${uid}"></div>
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">${esc(I18n.t('editform.descCharacter'))}</label>
            ${_mdTextarea(`ef-desc-${uid}`, c.description, 30, I18n.t('editform.descCharacterPh'))}
          </div>
        </div>
      </div>
    `;
  }

  function renderLocationEditor(l) {
    const isNew = !l || !l.id;
    if (isNew) {
      const defaults = { id:"", name:"", type:"", description:"", notes:"",
                         parentId:"", localMap:"" };
      l = { ...defaults, ...(l || {}) };
    }
    const uid = l.id || "new_loc";

    // Characters present here: driven by character.location (single source of truth).
    const presentChars = l.id ? Store.getCharactersInLocation(l.id) : [];
    const presentIds   = presentChars.map(c => c.id).join(',');
    const charsPicker = l.id ? `<div class="ms-mount"
      id="lf-chars-${uid}"
      data-ms-source="character"
      data-ms-value="${esc(presentIds)}"
      data-ms-placeholder="${esc(I18n.t('editform.searchAddCharacter'))}"
      data-ms-on-create="character"
      data-loc-id="${esc(l.id)}"></div>
      <div class="edit-hint" style="margin-top:0.25rem">${esc(I18n.t('editform.onePlaceHint'))}</div>`
      : `<div class="edit-hint">${esc(I18n.t('editform.saveLocFirstChars'))}</div>`;

    // Typ dropdown: PIN_TYPES entries with their icons, plus "custom"
    // fallback. The id-based `pinType` field wins; if a record only
    // carries the human-readable `type` text, try to match it back to
    // a PIN_TYPES label so the dropdown shows the right selection.
    let selectedPinType = l.pinType || '';
    if (!selectedPinType && l.type) {
      const match = Object.entries(PIN_TYPES).find(([, v]) => v.label === l.type);
      if (match) selectedPinType = match[0];
    }
    const typeOpts = `<option value="" ${!selectedPinType?'selected':''}>${esc(I18n.t('editform.undetermined'))}</option>` +
      Object.entries(PIN_TYPES)
        .map(([k, v]) => `<option value="${esc(k)}" ${selectedPinType===k?'selected':''}>${v.icon} ${esc(v.label)}</option>`)
        .join('');

    // Subplace hierarchy: parent picker excludes self (and could exclude
    // descendants but a deep cycle check belongs in save).
    const parentMount = `<div class="cb-mount"
      data-cb-id="lf-parent-${uid}"
      data-cb-source="location"
      data-cb-value="${esc(l.parentId || '')}"
      data-cb-exclude="${esc(l.id || '')}"
      data-cb-allow-empty="1"
      data-cb-empty-label="${esc(I18n.t('editform.noneStandalone'))}"
      data-cb-placeholder="${esc(I18n.t('editform.pickParentLocation'))}"></div>`;

    // Attitudes toward the party (multi-select with per-attitude
    // strength). A place can hold a mixed stance — "Chrám je z 80%
    // spojenec, ale z 50% nebezpečný" — and renderers stack a glow
    // halo per active attitude scaled to its strength.
    const attitudeChipRowHtml = _attitudeChipRow(`lf-attitudes-${uid}`, l.attitudes || []);

    const onMap = (typeof l.x === 'number' && typeof l.y === 'number');
    const mapBadge = onMap
      ? `<span class="badge" style="background:rgba(46,125,50,0.18);color:#a5d6a7">📍 ${esc(I18n.t('editform.onMap'))}</span>`
      : `<span class="badge" style="background:rgba(255,255,255,0.07);color:var(--text-muted)">${esc(I18n.t('editform.notOnMap'))}</span>`;

    const mapControls = isNew
      ? `<div class="edit-hint">${esc(I18n.t('editform.pinAfterSaveLoc'))}</div>`
      : onMap
        ? `<div class="inline-create-row">
             <button type="button" class="inline-create-btn"${dataAction('WorldMap.showPin', l.id)}>🧭 ${esc(I18n.t('editform.showOnMap'))}</button>
             <button type="button" class="inline-create-btn"${dataAction('WorldMap.startPlacingPin', l.id)}>📍 ${esc(I18n.t('editform.relocate'))}</button>
             <button type="button" class="edit-delete-btn"${dataAction('WorldMap.deletePin', l.id)}>🗑 ${esc(I18n.t('editform.removeFromMap'))}</button>
           </div>`
        : `<div class="inline-create-row">
             <button type="button" class="inline-create-btn"${dataAction('WorldMap.startPlacingPin', l.id)}>📍 ${esc(I18n.t('editform.placeOnMap'))}</button>
           </div>`;

    const localMapPreview = l.localMap
      ? `<div class="lf-localmap-preview"><img src="${esc(l.localMap)}" alt=""></div>`
      : '';

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← ${esc(I18n.t('action.cancel'))}</button>
          <h2 class="edit-form-title">${isNew ? "✦ " + esc(I18n.t('editform.newLocation')) : "✏ " + esc(l.name)}</h2>
          ${_twinHeaderRow(uid, l, 'locations')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveLocation', l.id)}>💾 ${esc(I18n.t('action.save'))}</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteLocation', l.id)}>🗑 ${esc(I18n.t('action.delete'))}</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.titleRequired'))}</label>
              <input class="edit-input" id="lf-name-${uid}" value="${esc(l.name)}" placeholder="${esc(I18n.t('editform.locNamePh'))}">
            </div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.type'))}</label>
              <select class="edit-input" id="lf-type-${uid}">${typeOpts}</select>
            </div>
          </div>
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.attitudes'))} <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">${esc(I18n.t('editform.attitudesStrengthHint'))}</span></label>
            ${attitudeChipRowHtml}
          </div>
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.secretNotes'))}</label>
            ${_mdTextarea(`lf-notes-${uid}`, l.notes || '', 3, I18n.t('editform.gmNotesPh'))}
          </div>

          <div class="edit-section">
            <div class="edit-section-title">${esc(I18n.t('editform.hierarchyAndMap'))} <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">${mapBadge}</span></div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.pinOnMap'))}</label>
              ${mapControls}
            </div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.markerSize'))} <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">${esc(I18n.t('editform.markerSizeHint', { min: PIN_SIZE_MIN, max: PIN_SIZE_MAX }))}</span></label>
              <input class="edit-input" type="number" id="lf-size-${uid}"
                min="${PIN_SIZE_MIN}" max="${PIN_SIZE_MAX}" step="2"
                value="${typeof l.size === 'number' ? l.size : ''}"
                placeholder="${esc(I18n.t('editform.defaultByType'))}">
            </div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.parentLocation'))}</label>
              ${parentMount}
              <div class="edit-hint" style="margin-top:0.25rem">${esc(I18n.t('editform.parentLocationHint'))}</div>
            </div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.customMap'))}</label>
              <div class="lf-localmap-row">
                <input class="edit-input" id="lf-localmap-${uid}" value="${esc(l.localMap||'')}" placeholder="${esc(I18n.t('editform.localMapPh'))}">
                ${!isNew ? `<label class="edit-upload-btn" title="${esc(I18n.t('editform.uploadImage'))}">
                  📤 ${esc(I18n.t('action.upload'))}
                  <input type="file" accept="image/*" style="display:none"
                    ${dataOn('change', 'EditMode.handleLocalMapChange', l.id, `lf-localmap-${uid}`, '$el')}>
                </label>` : `<span class="edit-hint" style="align-self:center">${esc(I18n.t('editform.saveLocThenUpload'))}</span>`}
              </div>
              ${localMapPreview}
              <div class="edit-hint" style="margin-top:0.25rem">${esc(I18n.t('editform.customMapHint'))}</div>
            </div>
          </div>

          <div class="edit-section">
            <div class="edit-section-title">${esc(I18n.t('editform.presentCharacters'))}</div>
            ${charsPicker}
          </div>
          ${_visibilitySection(uid, l, 'locations')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">${esc(I18n.t('editform.description'))}</label>
            ${_mdTextarea(`lf-desc-${uid}`, l.description, 20, I18n.t('editform.descLocationPh'))}
          </div>
        </div>
      </div>
    `;
  }

  function renderEventEditor(e) {
    const isNew = !e || !e.id;
    if (isNew) {
      const defaults = { id:"", name:"", sitting:null, short:"", description:"", characters:[], locations:[] };
      e = { ...defaults, ...(e || {}) };
    }
    const uid = e.id || "new_ev";

    const charsValue = (e.characters || []).join(',');
    const locsValue  = (e.locations  || []).join(',');
    const charPicker = `<div id="evf-chars-${uid}" class="ms-mount"
      data-ms-source="character"
      data-ms-value="${esc(charsValue)}"
      data-ms-placeholder="${esc(I18n.t('editform.searchCharacter'))}"
      data-ms-on-create="character"></div>`;
    const locPicker  = `<div id="evf-locs-${uid}" class="ms-mount"
      data-ms-source="location"
      data-ms-value="${esc(locsValue)}"
      data-ms-placeholder="${esc(I18n.t('editform.searchLocation'))}"
      data-ms-on-create="location"></div>`;

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← ${esc(I18n.t('action.cancel'))}</button>
          <h2 class="edit-form-title">${isNew ? "✦ " + esc(I18n.t('editform.newEvent')) : "✏ " + esc(e.name)}</h2>
          ${_twinHeaderRow(uid, e, 'events')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveEvent', e.id)}>💾 ${esc(I18n.t('action.save'))}</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteEvent', e.id)}>🗑 ${esc(I18n.t('action.delete'))}</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.titleRequired'))}</label>
            <input class="edit-input" id="evf-name-${uid}" value="${esc(e.name)}" placeholder="${esc(I18n.t('editform.eventNamePh'))}">
            <div class="edit-hint" style="margin-top:0.25rem">${esc(I18n.t('editform.eventSittingHint'))}</div>
          </div>
          <input type="hidden" id="evf-sitting-${uid}" value="${e.sitting ?? ''}">
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.shortDescription'))}</label>
            <input class="edit-input" id="evf-short-${uid}" value="${esc(e.short)}" placeholder="${esc(I18n.t('editform.oneSentencePh'))}">
          </div>
          <div class="edit-section" style="margin-top:0">
            <div class="edit-section-title">${esc(I18n.t('editform.involvedCharacters'))}
              <button type="button" class="inline-create-btn" style="margin-left:.5rem"
                ${dataAction('EditMode.addPartyToEvent', `evf-chars-${uid}`)}>🛡 + ${esc(I18n.t('editform.ourParty'))}</button>
            </div>
            ${charPicker}
          </div>
          <div class="edit-section">
            <div class="edit-section-title">${esc(I18n.t('editform.locations'))}</div>
            ${locPicker}
          </div>
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.eventPinOnMap'))}</label>
            ${isNew
              ? `<div class="edit-hint">${esc(I18n.t('editform.pinAfterSaveEvent'))}</div>`
              : (typeof e.mapX === 'number' && typeof e.mapY === 'number')
                ? `<div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
                    <button type="button" class="inline-create-btn"${dataAction('WorldMap.showEventPin', e.id)}>🧭 ${esc(I18n.t('editform.showPin'))}</button>
                    <button type="button" class="inline-create-btn"${dataAction('WorldMap.startPlacingEventPin', e.id)}>📍 ${esc(I18n.t('editform.relocate'))}</button>
                    <button type="button" class="edit-delete-btn"${dataAction('WorldMap.clearEventPin', e.id)}>🗑 ${esc(I18n.t('editform.removePin'))}</button>
                  </div>`
                : `<button type="button" class="inline-create-btn"${dataAction('WorldMap.startPlacingEventPin', e.id)}>📍 ${esc(I18n.t('editform.placePinOnMap'))}</button>`}
          </div>
          ${_visibilitySection(uid, e, 'events')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">${esc(I18n.t('editform.detailedDescription'))}</label>
            ${_mdTextarea(`evf-desc-${uid}`, e.description, 20, I18n.t('editform.descEventPh'))}
          </div>
        </div>
      </div>
    `;
  }

  // Build a single text+answer row used by mystery questions AND the
  // character "Otevřené otázky" section. The two share the same shape
  // (`{text, answer}`) post-migration so they can share the same HTML.
  // `removeAncestor` strips this row when the trash button is clicked.
  function _qaRowHtml(item) {
    const text   = (item && typeof item === 'object') ? (item.text   || '') : String(item || '');
    const answer = (item && typeof item === 'object') ? (item.answer || '') : '';
    const solved = !!(answer && answer.trim());
    return `
      <div class="qa-row ${solved ? 'is-solved' : ''}">
        <input class="edit-input qa-q-text" placeholder="${esc(I18n.t('editform.questionPh'))}" value="${esc(text)}">
        <input class="edit-input qa-q-answer" placeholder="${esc(I18n.t('editform.answerPh'))}" value="${esc(answer)}">
        <button type="button" class="dyn-remove-btn"
          ${dataAction('removeAncestor', '$el', '.qa-row')} title="${esc(I18n.t('editform.removeQuestion'))}">×</button>
      </div>`;
  }
  function _qaListHtml(items) {
    return (items || []).map(_qaRowHtml).join('');
  }

  function renderMysteryEditor(m) {
    const isNew = !m || !m.id;
    if (isNew) m = { id:"", name:"", priority:"střední", description:"", characters:[], questions:[] };
    const uid = m.id || "new_mys";
    // Priority options come from the canonical `eventPriorities` enum (NOT a
    // hardcoded subset) so all four levels are offered and Settings edits are
    // reflected. The current value is always included even if it's an orphan
    // (renamed/removed enum id) so saving never silently flips it — the same
    // first-option-fallback trap the faction picker had.
    const priEnum = Store.getKinds('priorities') || [];
    const priList = (m.priority && !priEnum.some(p => p.id === m.priority))
      ? [{ id: m.priority, label: m.priority }, ...priEnum]
      : priEnum;
    const priOpts = priList.map(p =>
      `<option value="${esc(p.id)}" ${m.priority===p.id?"selected":""}>${esc(p.label || p.id)}</option>`).join("");
    const charsValue = (m.characters || []).join(',');
    const charPicker = `<div id="mf-chars-${uid}" class="ms-mount"
      data-ms-source="character"
      data-ms-value="${esc(charsValue)}"
      data-ms-placeholder="${esc(I18n.t('editform.searchCharacter'))}"
      data-ms-on-create="character"></div>`;
    const questionRows = _qaListHtml(m.questions || []);

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← ${esc(I18n.t('action.cancel'))}</button>
          <h2 class="edit-form-title">${isNew ? "✦ " + esc(I18n.t('editform.newMystery')) : "✏ " + esc(m.name)}</h2>
          ${_twinHeaderRow(uid, m, 'mysteries')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveMystery', m.id)}>💾 ${esc(I18n.t('action.save'))}</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteMystery', m.id)}>🗑 ${esc(I18n.t('action.delete'))}</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.mysteryNameRequired'))}</label>
              <input class="edit-input" id="mf-name-${uid}" value="${esc(m.name)}" placeholder="${esc(I18n.t('editform.mysteryNamePh'))}">
            </div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.priority'))}</label>
              <select class="edit-select" id="mf-pri-${uid}">${priOpts}</select>
            </div>
          </div>
          <div class="edit-section">
            <div class="edit-section-title">
              ${esc(I18n.t('editform.questionsAnswers'))}
              <span class="settings-hint" style="font-weight:normal">${esc(I18n.t('editform.mysterySolvedHint'))}</span>
            </div>
            <div class="qa-list" id="mf-questions-${uid}">${questionRows}</div>
            <button type="button" class="dyn-add-btn" style="margin-top:0.4rem"
              ${dataAction('EditMode.addQARow', `mf-questions-${uid}`)}>+ ${esc(I18n.t('editform.addQuestion'))}</button>
          </div>
          <div class="edit-section">
            <div class="edit-section-title">${esc(I18n.t('editform.linkedCharacters'))}</div>
            ${charPicker}
          </div>
          ${_visibilitySection(uid, m, 'mysteries')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">${esc(I18n.t('editform.descWhatWeKnow'))}</label>
            ${_mdTextarea(`mf-desc-${uid}`, m.description, 20, I18n.t('editform.descMysteryPh'))}
          </div>
        </div>
      </div>
    `;
  }

  function _chainEditHtml(chain, uid, ci) {
    const ranksHtml = (chain.ranks || []).map(r => `
      <div class="dyn-item">
        <input class="edit-input" value="${esc(r)}" placeholder="${esc(I18n.t('editform.rankPh'))}">
        <button class="dyn-remove-btn"${dataAction('removeAncestor', '$el')}>×</button>
      </div>`).join("");
    return `
      <div class="rank-chain-edit" data-chain-id="${esc(chain.id || '')}">
        <div class="rank-chain-edit-header">
          <input class="edit-input edit-input-sm rank-chain-name" placeholder="${esc(I18n.t('editform.chainNamePh'))}" value="${esc(chain.name || '')}" style="flex:1">
          <button class="dyn-remove-btn" title="${esc(I18n.t('editform.removeChain'))}"${dataAction('removeAncestor', '$el', '.rank-chain-edit')}>✕</button>
        </div>
        <div class="dyn-list rank-ranks-list" id="ranks-${uid}-${ci}">
          ${ranksHtml}
        </div>
        <button class="dyn-add-btn" style="margin-top:0.3rem"
          ${dataAction('EditMode.addRankRow', `ranks-${uid}-${ci}`)}>+ ${esc(I18n.t('editform.addRank'))}</button>
      </div>`;
  }

  function renderFactionEditor(f, facId) {
    const isNew = !f || facId === "new";
    if (isNew) f = { name:"", color:"#555555", textColor:"#E0E0E0", badge:"⚐", description:"", rankChains:[], attitudes:[] };
    const uid = (isNew ? "new_fac" : facId).replace(/[^a-z0-9_]/gi, "_");
    const chainsHtml = (f.rankChains || []).map((ch, ci) => _chainEditHtml(ch, uid, ci)).join("");
    // Faction-level attitudes — members with empty own-attitudes
    // inherit from here (live fallback in Store.getEffectiveAttitudes).
    const factionAttRowHtml = _attitudeChipRow(`ff-attitudes-${uid}`, f.attitudes || []);

    return `
      <div class="edit-form" style="max-width:760px">
        <div class="edit-form-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← ${esc(I18n.t('action.cancel'))}</button>
          <h2 class="edit-form-title">${isNew ? "✦ " + esc(I18n.t('editform.newFaction')) : "✏ " + esc(f.name)}</h2>
          ${_twinHeaderRow(uid, isNew ? null : { ...f, id: facId }, 'factions')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveFaction', isNew ? "" : facId)}>💾 ${esc(I18n.t('action.save'))}</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteFaction', facId)}>🗑 ${esc(I18n.t('action.delete'))}</button>` : ""}
          </div>
        </div>

        <div class="edit-row-2">
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.nameRequired'))}</label>
            <input class="edit-input" id="ff-name-${uid}" value="${esc(f.name)}" placeholder="${esc(I18n.t('editform.factionNamePh'))}">
          </div>
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.badge'))}</label>
            <input class="edit-input" id="ff-badge-${uid}" value="${esc(f.badge)}" placeholder="🐉" style="font-size:1.4rem">
          </div>
        </div>
        <div class="edit-row-2">
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.backgroundColor'))}</label>
            <div style="display:flex;gap:0.5rem;align-items:center">
              <input type="color" id="ff-color-${uid}" value="${esc(f.color)}"
                style="width:44px;height:34px;padding:2px;cursor:pointer;background:none;border:1px solid rgba(212,184,122,0.2);border-radius:4px"
                ${dataOn('input', 'copyValue', `ff-color-${uid}`, `ff-color-text-${uid}`)}>
              <input class="edit-input" id="ff-color-text-${uid}" value="${esc(f.color)}" placeholder="#RRGGBB" style="flex:1"
                ${dataOn('input', 'copyValue', `ff-color-text-${uid}`, `ff-color-${uid}`)}>
            </div>
          </div>
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.textColor'))}</label>
            <div style="display:flex;gap:0.5rem;align-items:center">
              <input type="color" id="ff-textcolor-${uid}" value="${esc(f.textColor)}"
                style="width:44px;height:34px;padding:2px;cursor:pointer;background:none;border:1px solid rgba(212,184,122,0.2);border-radius:4px"
                ${dataOn('input', 'copyValue', `ff-textcolor-${uid}`, `ff-textcolor-text-${uid}`)}>
              <input class="edit-input" id="ff-textcolor-text-${uid}" value="${esc(f.textColor)}" placeholder="#RRGGBB" style="flex:1"
                ${dataOn('input', 'copyValue', `ff-textcolor-text-${uid}`, `ff-textcolor-${uid}`)}>
            </div>
          </div>
        </div>
        <div class="edit-field">
          <label class="edit-label">${esc(I18n.t('editform.factionDescription'))}</label>
          ${_mdTextarea(`ff-desc-${uid}`, f.description || '', 6, I18n.t('editform.factionDescriptionPh'))}
        </div>
        <div class="edit-field">
          <label class="edit-label">${esc(I18n.t('editform.attitudes'))} <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">${esc(I18n.t('editform.attitudesFactionHint'))}</span></label>
          ${factionAttRowHtml}
        </div>

        <div class="edit-section">
          <div class="edit-section-title">${esc(I18n.t('editform.rankChains'))}
            <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">${esc(I18n.t('editform.highestToLowest'))}</span>
          </div>
          <div id="chains-${uid}">${chainsHtml}</div>
          <button class="dyn-add-btn" style="margin-top:0.5rem"
            ${dataAction('EditMode.addRankChain', `chains-${uid}`, uid)}>+ ${esc(I18n.t('editform.addChain'))}</button>
        </div>

        ${_visibilitySection(uid, f, 'factions')}

      </div>
    `;
  }

  // Markdown-enabled textarea with a 👁 Náhled preview toggle.
  // Consumed by every long-description field so GMs can write wiki-style
  // articles with headings, lists, links, bold/italic, etc.
  // Markdown-enabled textarea. EasyMDE upgrades it after mount
  // (see EditMode._mountEasyMDE). With `forceSync:true`, every
  // keystroke mirrors back into this <textarea>, so existing save
  // code reading `document.getElementById(id).value` keeps working.
  function _mdTextarea(id, value, rows = 6, placeholder = '') {
    const v   = value == null ? '' : value;
    const eid = esc(id);
    return `
      <textarea class="md-easy"
        id="${eid}"
        rows="${rows}"
        placeholder="${esc(placeholder)}">${esc(v)}</textarea>`;
  }

  // ── Pantheon (deity) editor ────────────────────────────────────
  function renderBuhEditor(g) {
    const isNew = !g || !g.id;
    if (isNew) g = { id:'', name:'', domain:'', alignment:'', symbol:'', description:'', tags:[] };
    const uid = g.id || 'new_god';
    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← ${esc(I18n.t('action.cancel'))}</button>
          <h2 class="edit-form-title">${isNew ? "✦ " + esc(I18n.t('editform.newDeity')) : "✏ " + esc(g.name)}</h2>
          ${_twinHeaderRow(uid, g, 'pantheon')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveBuh', g.id)}>💾 ${esc(I18n.t('action.save'))}</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteBuh', g.id)}>🗑 ${esc(I18n.t('action.delete'))}</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.nameRequired'))}</label>
              <input class="edit-input" id="gf-name-${uid}" value="${esc(g.name)}" placeholder="${esc(I18n.t('editform.deityNamePh'))}">
            </div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.symbol'))}</label>
              <input class="edit-input" id="gf-symbol-${uid}" value="${esc(g.symbol)}" placeholder="☀ / 🌙 / ⚔">
            </div>
          </div>
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.domain'))}</label>
              <input class="edit-input" id="gf-domain-${uid}" value="${esc(g.domain)}" placeholder="${esc(I18n.t('editform.domainPh'))}">
            </div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.alignment'))}</label>
              <input class="edit-input" id="gf-alignment-${uid}" value="${esc(g.alignment)}" placeholder="${esc(I18n.t('editform.alignmentPh'))}">
            </div>
          </div>
          ${_visibilitySection(uid, g, 'pantheon')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">${esc(I18n.t('editform.description'))}</label>
            ${_mdTextarea(`gf-desc-${uid}`, g.description, 20, I18n.t('editform.descDeityPh'))}
          </div>
        </div>
      </div>`;
  }

  // ── Artifact editor ────────────────────────────────────────────
  function renderArtifactEditor(a) {
    const isNew = !a || !a.id;
    if (isNew) a = { id:'', name:'', ownerCharacterId:'', locationId:'', description:'', tags:[] };
    const uid = a.id || 'new_art';

    const ownerMount = `<div class="cb-mount"
      data-cb-id="af-owner-${uid}"
      data-cb-source="character"
      data-cb-value="${esc(a.ownerCharacterId || '')}"
      data-cb-allow-empty="1"
      data-cb-empty-label="${esc(I18n.t('editform.nobody'))}"
      data-cb-placeholder="${esc(I18n.t('editform.pickCharacter'))}"
      data-cb-on-create="character"></div>`;

    const locMount = `<div class="cb-mount"
      data-cb-id="af-loc-${uid}"
      data-cb-source="location"
      data-cb-value="${esc(a.locationId || '')}"
      data-cb-allow-empty="1"
      data-cb-empty-label="${esc(I18n.t('editform.undetermined'))}"
      data-cb-placeholder="${esc(I18n.t('editform.pickLocation'))}"
      data-cb-on-create="location"></div>`;

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← ${esc(I18n.t('action.cancel'))}</button>
          <h2 class="edit-form-title">${isNew ? "✦ " + esc(I18n.t('editform.newArtifact')) : "✏ " + esc(a.name)}</h2>
          ${_twinHeaderRow(uid, a, 'artifacts')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveArtifact', a.id)}>💾 ${esc(I18n.t('action.save'))}</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteArtifact', a.id)}>🗑 ${esc(I18n.t('action.delete'))}</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.titleRequired'))}</label>
            <input class="edit-input" id="af-name-${uid}" value="${esc(a.name)}" placeholder="${esc(I18n.t('editform.artifactNamePh'))}">
          </div>
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.holder'))}</label>
              ${ownerMount}
            </div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.placement'))}</label>
              ${locMount}
            </div>
          </div>
          ${_visibilitySection(uid, a, 'artifacts')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">${esc(I18n.t('editform.description'))}</label>
            ${_mdTextarea(`af-desc-${uid}`, a.description, 20, I18n.t('editform.descArtifactPh'))}
          </div>
        </div>
      </div>`;
  }

  // ── Historical event editor ────────────────────────────────────
  function renderHistoricalEventEditor(h) {
    const isNew = !h || !h.id;
    if (isNew) h = {
      id:'', name:'', start:'', end:'', summary:'', body:'',
      characters:[], locations:[], tags:[],
    };
    const uid = h.id || 'new_hist';

    const charsMount = `<div class="ms-mount"
      id="he-chars-${uid}"
      data-ms-source="character"
      data-ms-value="${esc((h.characters || []).join(','))}"
      data-ms-placeholder="${esc(I18n.t('editform.pickCharacters'))}"
      data-ms-on-create="character"></div>`;

    const locsMount = `<div class="ms-mount"
      id="he-locs-${uid}"
      data-ms-source="location"
      data-ms-value="${esc((h.locations || []).join(','))}"
      data-ms-placeholder="${esc(I18n.t('editform.pickLocations'))}"
      data-ms-on-create="location"></div>`;

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← ${esc(I18n.t('action.cancel'))}</button>
          <h2 class="edit-form-title">${isNew ? "✦ " + esc(I18n.t('editform.newHistoricalEvent')) : "✏ " + esc(h.name)}</h2>
          ${_twinHeaderRow(uid, h, 'historicalEvents')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveHistoricalEvent', h.id)}>💾 ${esc(I18n.t('action.save'))}</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteHistoricalEvent', h.id)}>🗑 ${esc(I18n.t('action.delete'))}</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.titleRequired'))}</label>
            <input class="edit-input" id="he-name-${uid}" value="${esc(h.name)}" placeholder="${esc(I18n.t('editform.histNamePh'))}">
          </div>
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.start'))}</label>
              <input class="edit-input" id="he-start-${uid}" value="${esc(h.start)}" placeholder="−339 DR">
            </div>
            <div class="edit-field">
              <label class="edit-label">${esc(I18n.t('editform.end'))}</label>
              <input class="edit-input" id="he-end-${uid}" value="${esc(h.end)}" placeholder="−180 DR">
            </div>
          </div>
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.summary'))}</label>
            <textarea class="edit-textarea" id="he-summary-${uid}" rows="4" placeholder="${esc(I18n.t('editform.summaryPh'))}">${esc(h.summary)}</textarea>
          </div>
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.characters'))}</label>
            ${charsMount}
          </div>
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.locations'))}</label>
            ${locsMount}
          </div>
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.tags'))}</label>
            <input class="edit-input" id="he-tags-${uid}" value="${esc((h.tags || []).join(', '))}" placeholder="${esc(I18n.t('editform.tagsPh'))}">
          </div>
          ${_visibilitySection(uid, h, 'historicalEvents')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field">
            <label class="edit-label">${esc(I18n.t('editform.text'))}</label>
            ${_mdTextarea(`he-body-${uid}`, h.body, 20, I18n.t('editform.descHistEventPh'))}
          </div>
        </div>
      </div>`;
  }

  /** Read the attitude chip row built by `_attitudeChipRow`.
   *  Returns `[{id}]` — strength now lives on the `attitudes` settings
   *  enum item, not on the entity. The object shape is preserved (vs
   *  `[id]`) for forward compatibility with future per-entry fields.
   *  Used by EditMode (character/location/faction save) AND by
   *  map.js's pin-form save. */
  function _readAttitudeChipRow(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return [];
    const items = row.querySelectorAll('.attitude-chip-item');
    const out = [];
    items.forEach(item => {
      const cb = item.querySelector('input[type="checkbox"]');
      if (!cb || !cb.checked) return;
      const id = cb.value;
      if (!id) return;
      out.push({ id });
    });
    return out;
  }

  return {
    renderCharacterEditor,
    renderLocationEditor,
    renderEventEditor,
    renderMysteryEditor,
    renderFactionEditor,
    renderBuhEditor,
    renderArtifactEditor,
    renderHistoricalEventEditor,
    getDynRowHtml: _dynRow,
    qaRowHtml: _qaRowHtml,
    qaListHtml: _qaListHtml,
    getRelSectionHtml: _relSection,
    getDirOptsHtml: _dirOpts,
    getTargetMountHtml: _targetMount,
    getRelConfig: () => _relConfig(),
    getChainEditHtml: _chainEditHtml,
    getMdTextareaHtml: _mdTextarea,
    attitudeChipRow:     _attitudeChipRow,
    readAttitudeChipRow: _readAttitudeChipRow,
    // Twin-aware DM section (visibility select + twin link row).
    // Old names kept as back-compat aliases for any external caller.
    dmSection:             _dmSection,
    readDmSection:         _readDmSection,
    visibilitySection:     _visibilitySection,
    readVisibilitySection: _readVisibilitySection,
    twinHeaderRow:         _twinHeaderRow,
  };

})();
