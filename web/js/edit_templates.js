import { Store } from './store.js';
import { PIN_TYPES, PIN_SIZE_MIN, PIN_SIZE_MAX } from './map.js';
import { REL_TYPES } from './data.js';
import { esc, dataAction, dataOn } from './utils.js';

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
   *  entity, so chips no longer carry per-chip sliders. Read back
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
  // The legacy per-field `secrets` toggles and `[secret]` marker
  // buttons were removed in the twin-entity pivot. DM annotations
  // now live in the linked DM-only twin entity instead.
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
    species:          'druh',
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
      const twinVis = twin && twin.visibility === 'dm' ? 'DM' : 'hráčský';
      return `
        <div class="edit-hdr-twin">
          <a class="dm-twin-badge dm-twin-badge-linked"
             href="#/${route}/${esc(linkedId)}"
             title="Otevřít twin">
            ✓ ${esc(twinNm)} <span class="dm-twin-badge-vis">(${esc(twinVis)})</span> →
          </a>
          <button type="button" class="dm-twin-btn dm-twin-btn-unlink" title="Odpárovat twin"
            ${dataAction('EditMode.unlinkTwin', collection, entity.id)}>🔗 Odpárovat</button>
        </div>`;
    }
    const visibility    = entity.visibility === 'dm' ? 'dm' : 'public';
    const oppositeLabel = visibility === 'dm' ? 'hráčský' : 'DM';
    return `
      <div class="edit-hdr-twin">
        <button type="button" class="dm-twin-btn dm-twin-btn-link"
          ${dataAction('EditMode.openTwinPicker', collection, entity.id)}>
          🔗 Připojit ${oppositeLabel} twin
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
      ? `<small class="edit-hint">PC postavy jsou vždy veřejné.</small>`
      : linkedId
        ? `<small class="edit-hint">Tato entita má spárovaný twin — odpárujte ho v hlavičce před změnou viditelnosti.</small>`
        : '';

    return `
      <div class="edit-section visibility-section" id="vis-section-${esc(uid)}">
        <div class="edit-section-title">🛡 Viditelnost (DM)</div>
        <div class="edit-field">
          <label class="edit-label">Viditelnost záznamu</label>
          <select class="edit-select" id="vis-${esc(uid)}" ${visDisabled}>
            <option value="public" ${visibility==='public'?'selected':''}>Veřejné — vidí všichni</option>
            <option value="dm"     ${visibility==='dm'?'selected':''}>Jen DM</option>
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

  // Relationship type config is the canonical REL_TYPES array from
  // data.js. REL_IDS / REL_CONFIG / REL_LABELS are local views for
  // backwards compatibility with the rest of this file's helpers.
  const REL_IDS    = REL_TYPES.map(t => t.id);
  const REL_CONFIG = Object.fromEntries(REL_TYPES.map(t => [t.id, t]));
  const REL_LABELS = Object.fromEntries(REL_TYPES.map(t => [t.id, t.label]));

  const DIR_LABELS = {
    from: 'Tato postava →',
    to:   '← Na tuto postavu',
    both: '↔ Oboustranná',
  };

  /** Build a Combobox placeholder for the relationship target picker.
   *  Replaces the legacy <select> + <option> list — values are still readable
   *  via document.getElementById(`${prefix}-target`).value because the
   *  Combobox renders a hidden <input type="hidden"> with that id. */
  function _targetMount(type, charId, selectedId, prefix) {
    const cfg     = REL_CONFIG[type] || REL_CONFIG.commands;
    const source  = cfg.target === 'location' ? 'location' : 'character';
    const exclude = cfg.target === 'character' ? charId : '';
    const placeholder = cfg.target === 'location' ? 'Vyber místo…' : 'Vyber postavu…';
    return `<div class="cb-mount rel-target-cb"
              data-cb-id="${prefix}-target"
              data-cb-source="${source}"
              data-cb-exclude="${esc(exclude)}"
              data-cb-value="${esc(selectedId || '')}"
              data-cb-placeholder="${placeholder}"
              data-cb-on-create="${source}"></div>`;
  }

  /** Build <option> list for directions based on type config */
  function _dirOpts(type, selectedDir) {
    const cfg = REL_CONFIG[type] || REL_CONFIG.commands;
    return cfg.dirs.map(d =>
      `<option value="${d}" ${d===selectedDir?'selected':''}>${DIR_LABELS[d]}</option>`
    ).join('');
  }

  /** Render a single relationship row (existing or new) */
  function _relRow(charId, r, idx) {
    const isNew    = idx === 'new';
    const prefix   = isNew ? `rf-new-${charId}` : `rf-${idx}-${charId}`;
    const type     = r ? r.type : REL_IDS[0];
    const label    = r ? (r.label || '') : '';

    // Determine current direction and other end from existing relationship
    let dir = 'from', targetId = '';
    if (r) {
      if (r.source === charId)      { dir = 'from'; targetId = r.target; }
      else if (r.target === charId) { dir = 'to';   targetId = r.source; }
    }

    const typeOpts   = REL_IDS.map(id =>
      `<option value="${id}" ${id===type?'selected':''}>${REL_CONFIG[id].label}</option>`
    ).join('');
    const dirOptions = _dirOpts(type, dir);
    const tgtMount   = _targetMount(type, charId, targetId, prefix);

    const saveAttr = isNew
      ? dataAction('EditMode.addRelationship', charId)
      : dataAction('EditMode.updateRelationship', charId, idx);
    const deleteBtn  = isNew ? '' :
      `<button class="rel-delete-btn" title="Smazat"
         ${dataAction('EditMode.deleteRelationship', r.source, r.target, r.type, charId)}>×</button>`;
    const saveLabel  = isNew ? '+ Přidat' : '💾';
    const saveTitle  = isNew ? 'Přidat vazbu' : 'Uložit změny';

    return `<div class="rel-edit-row" data-idx="${idx}">
      <select class="edit-select edit-select-sm" id="${prefix}-type"
        ${dataOn('change', 'EditMode.relTypeChanged', charId, prefix)}>${typeOpts}</select>
      <select class="edit-select edit-select-sm" id="${prefix}-dir">${dirOptions}</select>
      <div class="rel-target-wrap">${tgtMount}</div>
      <input class="edit-input edit-input-sm" id="${prefix}-label" value="${esc(label)}"
        placeholder="${esc(REL_CONFIG[type].label)}">
      <button class="edit-add-btn"${saveAttr} title="${saveTitle}">${saveLabel}</button>
      ${deleteBtn}
    </div>`;
  }

  function _relSection(charId) {
    const rels = Store.getRelationships().filter(r => r.source === charId || r.target === charId);

    const existingRows = rels.map((r, i) => _relRow(charId, r, i)).join('');
    const newRow = _relRow(charId, null, 'new');

    return `
      <div class="edit-section" id="rel-section-${charId}">
        <div class="edit-section-title">Vazby</div>
        <div class="rel-edit-list" id="rel-list-${charId}">
          ${existingRows || `<span class="edit-hint">Žádné vazby</span>`}
        </div>
        <div class="rel-add-form">${newRow}</div>
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
    const KNAMES = ["Neznámý","Tušený","Základní","Dobře znám","Plně zmapován"];

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
    const neutralOption = `<option value="neutral" ${neutralSelected ? "selected" : ""}>👤 Bez frakce (neutrální)</option>`;
    const partyOption = `<option value="party" ${c.faction==='party'?"selected":""}>${esc(pp.badge || pp.icon || '🛡')} ${esc(pp.name || 'Naše parta')}</option>`;
    const fOpts = neutralOption + partyOption + realFactions.map(([id,f]) =>
      `<option value="${id}" ${c.faction===id?"selected":""}>${f.badge} ${esc(f.name)}</option>`).join("");
    const sOpts = Object.entries(statusMap).map(([id,s]) =>
      `<option value="${id}" ${c.status===id?"selected":""}>${s.icon} ${s.label}</option>`).join("");
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
    const genderList = Store.getEnum('genders');
    const currentGender = c.gender || '';
    const matchedGender = genderList.find(g => g.id === currentGender || g.label === currentGender);
    const isOtherGender = !!(currentGender && !matchedGender);
    const genderSelectValue = !currentGender ? '' : (isOtherGender ? '__other__' : (matchedGender?.id || ''));
    const genderOpts = [
      `<option value="" ${genderSelectValue===''?'selected':''}>— nezadáno —</option>`,
      ...genderList.map(g =>
        `<option value="${esc(g.id)}" ${genderSelectValue===g.id?'selected':''}>${esc(g.label)}</option>`
      ),
      `<option value="__other__" ${genderSelectValue==='__other__'?'selected':''}>Ostatní (specifikuj)</option>`,
    ].join('');

    // Species: Combobox over the Druhy collection. Inline-create lets the
    // GM spawn a new species page from this picker.
    const speciesMount = `<div class="cb-mount"
      data-cb-id="ef-species-${uid}"
      data-cb-source="species"
      data-cb-value="${esc(c.species || '')}"
      data-cb-allow-empty="1"
      data-cb-empty-label="— neurčeno —"
      data-cb-placeholder="Vyber druh…"
      data-cb-on-create="species"></div>`;

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← Zrušit</button>
          <h2 class="edit-form-title">${isNew ? "✦ Nová postava" : "✏ " + esc(c.name)}</h2>
          ${_twinHeaderRow(uid, c, 'characters')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveCharacter', c.id)}>💾 Uložit</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteCharacter', c.id)}>🗑 Smazat</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-main-grid">
            <div class="edit-portrait-col">
              <div class="edit-portrait-preview" id="ep-preview-${uid}">
                ${c.portrait
                  ? `<img src="${esc(c.portrait)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:top">`
                  : `<span style="font-size:2.5rem">${badge}</span>`}
              </div>
              <label class="edit-upload-btn">
                📷 Nahrát portrét
                <input type="file" accept="image/*" style="display:none"
                  ${dataOn('change', 'EditMode.handlePortraitChange', uid, '$el')}>
              </label>
              ${c.portrait ? `<button class="edit-remove-portrait-btn"
                ${dataAction('EditMode.clearPortrait', uid, badge)}>
                × Odebrat
              </button>` : ""}
              <input type="hidden" id="ep-data-${uid}" value="${esc(c.portrait)}">
            </div>
            <div class="edit-fields-col">
              <div class="edit-row-2">
                <div class="edit-field">
                  <label class="edit-label">Jméno *</label>
                  <input class="edit-input" id="ef-name-${uid}" value="${esc(c.name)}" placeholder="Jméno postavy">
                </div>
                <div class="edit-field">
                  <label class="edit-label">Titul / Krátký popis</label>
                  <input class="edit-input" id="ef-title-${uid}" value="${esc(c.title)}" placeholder="Titul nebo profese">
                </div>
              </div>
              <div class="edit-row-2">
                <div class="edit-field">
                  <label class="edit-label">Frakce</label>
                  <select class="edit-select" id="ef-faction-${uid}"
                    ${dataOn('change', 'EditMode.onCharacterFactionChange', uid, '$value')}>${fOpts}</select>
                </div>
                <div class="edit-field">
                  <label class="edit-label">Status</label>
                  <select class="edit-select" id="ef-status-${uid}">${sOpts}</select>
                </div>
              </div>
              <!-- NPC-only fields. Gated on Store.isPartyMember(c). When adding
                   new fields that don't apply to PCs (e.g. anything about
                   stance / outside perception / knowledge), add them inside
                   this wrapper so they participate in the same toggle. -->
              <div id="ef-npc-only-${uid}" style="${Store.isPartyMember(c) ? 'display:none' : ''}">
                <div class="edit-field">
                  <label class="edit-label" title="Jak se postava staví k partě a s jakou intenzitou">Postoje k partě <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">— prázdné = převezme od frakce</span></label>
                  ${attitudeChipRowHtml}
                </div>
              </div>
              <div class="edit-row-3">
                <div class="edit-field">
                  <label class="edit-label">Druh</label>
                  ${speciesMount}
                </div>
                <div class="edit-field">
                  <label class="edit-label">Pohlaví</label>
                  <select class="edit-select" id="ef-gender-${uid}"
                    ${dataOn('change', 'EditMode.onGenderChange', uid)}>${genderOpts}</select>
                  <input class="edit-input" id="ef-gender-other-${uid}" type="text"
                    placeholder="Specifikuj…"
                    value="${isOtherGender ? esc(c.gender) : ''}"
                    style="margin-top:0.4rem;display:${isOtherGender ? '' : 'none'}">
                </div>
                <div class="edit-field">
                  <label class="edit-label">Věk</label>
                  <input class="edit-input" id="ef-age-${uid}" value="${esc(c.age)}" placeholder="neznámý">
                </div>
              </div>
              <div class="edit-field">
                <label class="edit-label">Okolnosti (např. zajat, na útěku, v kómatu…)</label>
                <input class="edit-input" id="ef-circumstances-${uid}" value="${esc(c.circumstances || '')}" placeholder="Volný text — zvláštní situace postavy">
              </div>
              <div class="edit-field">
                <label class="edit-label" id="ef-kl-${uid}">Znalost (${c.knowledge}/4) — ${KNAMES[c.knowledge]}</label>
                <input type="range" class="edit-range" id="ef-knowledge-${uid}" min="0" max="4" value="${c.knowledge}"
                  ${dataOn('input', 'EditMode.updateKnowledgeLabel', uid)}>
                <div class="edit-range-labels"><span>Neznámý</span><span>Plně zmapován</span></div>
              </div>
            </div>
          </div>
          <div class="edit-section">
            <div class="edit-section-title">Co víme</div>
            <div class="dyn-list" id="dyn-known-${uid}">${knownRows}</div>
            <button class="dyn-add-btn"${dataAction('EditMode.addDynRow', `dyn-known-${uid}`)}>+ Přidat</button>
          </div>
          <div class="edit-section">
            <div class="edit-section-title">
              Otevřené otázky
              <span class="settings-hint" style="font-weight:normal">vyplň odpověď → otázka je vyřešená</span>
            </div>
            <div class="qa-list" id="dyn-unknown-${uid}">${unknownRows}</div>
            <button class="dyn-add-btn" type="button"${dataAction('EditMode.addQARow', `dyn-unknown-${uid}`)}>+ Přidat otázku</button>
          </div>
          ${!isNew ? _relSection(c.id) : `
            <div class="edit-section">
              <div class="edit-section-title">Vazby</div>
              <p class="edit-hint">Uložte postavu nejprve, pak přidejte vazby.</p>
            </div>`}
          ${_visibilitySection(uid, c, 'characters', { isPc: Store.isPartyMember(c) })}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">Popis — článek o postavě</label>
            ${_mdTextarea(`ef-desc-${uid}`, c.description, 30, 'Detailní popis postavy — podporuje Markdown')}
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
      data-ms-placeholder="Hledej postavu a přidej…"
      data-ms-on-create="character"
      data-loc-id="${esc(l.id)}"></div>
      <div class="edit-hint" style="margin-top:0.25rem">Postava může být vždy jen na jednom místě — přidání sem ji odebere z předchozího místa.</div>`
      : `<div class="edit-hint">Uložte místo, pak přidejte přítomné postavy.</div>`;

    // Typ dropdown: PIN_TYPES entries with their icons, plus "custom"
    // fallback. The id-based `pinType` field wins; if a record only
    // carries the human-readable `type` text, try to match it back to
    // a PIN_TYPES label so the dropdown shows the right selection.
    let selectedPinType = l.pinType || '';
    if (!selectedPinType && l.type) {
      const match = Object.entries(PIN_TYPES).find(([, v]) => v.label === l.type);
      if (match) selectedPinType = match[0];
    }
    const typeOpts = `<option value="" ${!selectedPinType?'selected':''}>— neurčeno —</option>` +
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
      data-cb-empty-label="— žádné (samostatné místo) —"
      data-cb-placeholder="Vyber rodičovské místo…"></div>`;

    // Attitudes toward the party (multi-select with per-attitude
    // strength). A place can hold a mixed stance — "Chrám je z 80%
    // spojenec, ale z 50% nebezpečný" — and renderers stack a glow
    // halo per active attitude scaled to its strength.
    const attitudeChipRowHtml = _attitudeChipRow(`lf-attitudes-${uid}`, l.attitudes || []);

    const onMap = (typeof l.x === 'number' && typeof l.y === 'number');
    const mapBadge = onMap
      ? `<span class="badge" style="background:rgba(46,125,50,0.18);color:#a5d6a7">📍 Na mapě</span>`
      : `<span class="badge" style="background:rgba(255,255,255,0.07);color:var(--text-muted)">Není na mapě</span>`;

    const mapControls = isNew
      ? `<div class="edit-hint">Pin lze umístit po prvním uložení místa.</div>`
      : onMap
        ? `<div class="inline-create-row">
             <button type="button" class="inline-create-btn"${dataAction('WorldMap.showPin', l.id)}>🧭 Zobrazit na mapě</button>
             <button type="button" class="inline-create-btn"${dataAction('WorldMap.startPlacingPin', l.id)}>📍 Přemístit</button>
             <button type="button" class="edit-delete-btn"${dataAction('WorldMap.deletePin', l.id)}>🗑 Odebrat z mapy</button>
           </div>`
        : `<div class="inline-create-row">
             <button type="button" class="inline-create-btn"${dataAction('WorldMap.startPlacingPin', l.id)}>📍 Umístit na mapu</button>
           </div>`;

    const localMapPreview = l.localMap
      ? `<div class="lf-localmap-preview"><img src="${esc(l.localMap)}" alt=""></div>`
      : '';

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← Zrušit</button>
          <h2 class="edit-form-title">${isNew ? "✦ Nové místo" : "✏ " + esc(l.name)}</h2>
          ${_twinHeaderRow(uid, l, 'locations')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveLocation', l.id)}>💾 Uložit</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteLocation', l.id)}>🗑 Smazat</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">Název *</label>
              <input class="edit-input" id="lf-name-${uid}" value="${esc(l.name)}" placeholder="Název místa">
            </div>
            <div class="edit-field">
              <label class="edit-label">Typ</label>
              <select class="edit-input" id="lf-type-${uid}">${typeOpts}</select>
            </div>
          </div>
          <div class="edit-field">
            <label class="edit-label">Postoje k partě <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">— víc postojů s nastavitelnou silou (např. 100% neutrální + 50% nebezpečný)</span></label>
            ${attitudeChipRowHtml}
          </div>
          <div class="edit-field">
            <label class="edit-label">Záhadné poznámky</label>
            ${_mdTextarea(`lf-notes-${uid}`, l.notes || '', 3, 'Poznámky pro GM')}
          </div>

          <div class="edit-section">
            <div class="edit-section-title">Hierarchie a mapa <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">${mapBadge}</span></div>
            <div class="edit-field">
              <label class="edit-label">Pin na mapě</label>
              ${mapControls}
            </div>
            <div class="edit-field">
              <label class="edit-label">Velikost značky <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">— prázdné = výchozí podle typu místa (${PIN_SIZE_MIN}–${PIN_SIZE_MAX} px)</span></label>
              <input class="edit-input" type="number" id="lf-size-${uid}"
                min="${PIN_SIZE_MIN}" max="${PIN_SIZE_MAX}" step="2"
                value="${typeof l.size === 'number' ? l.size : ''}"
                placeholder="(výchozí podle typu)">
            </div>
            <div class="edit-field">
              <label class="edit-label">Rodičovské místo (volitelné — pro dílčí mapy)</label>
              ${parentMount}
              <div class="edit-hint" style="margin-top:0.25rem">Např. dungeon uvnitř města. Toto místo se objeví na mapě rodiče.</div>
            </div>
            <div class="edit-field">
              <label class="edit-label">Vlastní mapa (volitelné — pro dílčí mapu tohoto místa)</label>
              <div class="lf-localmap-row">
                <input class="edit-input" id="lf-localmap-${uid}" value="${esc(l.localMap||'')}" placeholder="/maps/local/... nebo nahraj obrázek →">
                ${!isNew ? `<label class="edit-upload-btn" title="Nahrát obrázek">
                  📤 Nahrát
                  <input type="file" accept="image/*" style="display:none"
                    ${dataOn('change', 'EditMode.handleLocalMapChange', l.id, `lf-localmap-${uid}`, '$el')}>
                </label>` : `<span class="edit-hint" style="align-self:center">(uložte místo, pak nahrajte)</span>`}
              </div>
              ${localMapPreview}
              <div class="edit-hint" style="margin-top:0.25rem">Když je vyplněno, na stránce místa se objeví tlačítko 🗺 Místní mapa, kde se zobrazí podřízená místa.</div>
            </div>
          </div>

          <div class="edit-section">
            <div class="edit-section-title">Přítomné postavy</div>
            ${charsPicker}
          </div>
          ${_visibilitySection(uid, l, 'locations')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">Popis</label>
            ${_mdTextarea(`lf-desc-${uid}`, l.description, 20, 'Popis místa — podporuje Markdown')}
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
      data-ms-placeholder="Hledat postavu…"
      data-ms-on-create="character"></div>`;
    const locPicker  = `<div id="evf-locs-${uid}" class="ms-mount"
      data-ms-source="location"
      data-ms-value="${esc(locsValue)}"
      data-ms-placeholder="Hledat místo…"
      data-ms-on-create="location"></div>`;

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← Zrušit</button>
          <h2 class="edit-form-title">${isNew ? "✦ Nová událost" : "✏ " + esc(e.name)}</h2>
          ${_twinHeaderRow(uid, e, 'events')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveEvent', e.id)}>💾 Uložit</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteEvent', e.id)}>🗑 Smazat</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-field">
            <label class="edit-label">Název *</label>
            <input class="edit-input" id="evf-name-${uid}" value="${esc(e.name)}" placeholder="Název události">
            <div class="edit-hint" style="margin-top:0.25rem">Zařazení do sezení a pořadí se nastavuje přetažením kartičky na Časové ose.</div>
          </div>
          <input type="hidden" id="evf-sitting-${uid}" value="${e.sitting ?? ''}">
          <div class="edit-field">
            <label class="edit-label">Krátký popis</label>
            <input class="edit-input" id="evf-short-${uid}" value="${esc(e.short)}" placeholder="Jedna věta">
          </div>
          <div class="edit-section" style="margin-top:0">
            <div class="edit-section-title">Zúčastněné postavy
              <button type="button" class="inline-create-btn" style="margin-left:.5rem"
                ${dataAction('EditMode.addPartyToEvent', `evf-chars-${uid}`)}>🛡 + Naše parta</button>
            </div>
            ${charPicker}
          </div>
          <div class="edit-section">
            <div class="edit-section-title">Místa</div>
            ${locPicker}
          </div>
          <div class="edit-field">
            <label class="edit-label">Pin události na mapě</label>
            ${isNew
              ? `<div class="edit-hint">Pin lze umístit po prvním uložení události.</div>`
              : (typeof e.mapX === 'number' && typeof e.mapY === 'number')
                ? `<div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
                    <button type="button" class="inline-create-btn"${dataAction('WorldMap.showEventPin', e.id)}>🧭 Zobrazit pin</button>
                    <button type="button" class="inline-create-btn"${dataAction('WorldMap.startPlacingEventPin', e.id)}>📍 Přemístit</button>
                    <button type="button" class="edit-delete-btn"${dataAction('WorldMap.clearEventPin', e.id)}>🗑 Odebrat pin</button>
                  </div>`
                : `<button type="button" class="inline-create-btn"${dataAction('WorldMap.startPlacingEventPin', e.id)}>📍 Umístit pin na mapu</button>`}
          </div>
          ${_visibilitySection(uid, e, 'events')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">Podrobný popis</label>
            ${_mdTextarea(`evf-desc-${uid}`, e.description, 20, 'Co se přesně stalo — podporuje Markdown')}
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
        <input class="edit-input qa-q-text" placeholder="Otázka" value="${esc(text)}">
        <input class="edit-input qa-q-answer" placeholder="Odpověď (prázdné = otevřená)" value="${esc(answer)}">
        <button type="button" class="dyn-remove-btn"
          ${dataAction('removeAncestor', '$el', '.qa-row')} title="Odebrat otázku">×</button>
      </div>`;
  }
  function _qaListHtml(items) {
    return (items || []).map(_qaRowHtml).join('');
  }

  function renderMysteryEditor(m) {
    const isNew = !m || !m.id;
    if (isNew) m = { id:"", name:"", priority:"střední", description:"", characters:[], questions:[] };
    const uid = m.id || "new_mys";
    const priOpts = ["kritická","vysoká","střední"].map(p =>
      `<option value="${p}" ${m.priority===p?"selected":""}>${p}</option>`).join("");
    const charsValue = (m.characters || []).join(',');
    const charPicker = `<div id="mf-chars-${uid}" class="ms-mount"
      data-ms-source="character"
      data-ms-value="${esc(charsValue)}"
      data-ms-placeholder="Hledat postavu…"
      data-ms-on-create="character"></div>`;
    const questionRows = _qaListHtml(m.questions || []);

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← Zrušit</button>
          <h2 class="edit-form-title">${isNew ? "✦ Nová záhada" : "✏ " + esc(m.name)}</h2>
          ${_twinHeaderRow(uid, m, 'mysteries')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveMystery', m.id)}>💾 Uložit</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteMystery', m.id)}>🗑 Smazat</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">Název záhady *</label>
              <input class="edit-input" id="mf-name-${uid}" value="${esc(m.name)}" placeholder="Co je záhadou?">
            </div>
            <div class="edit-field">
              <label class="edit-label">Priorita</label>
              <select class="edit-select" id="mf-pri-${uid}">${priOpts}</select>
            </div>
          </div>
          <div class="edit-section">
            <div class="edit-section-title">
              Otázky &amp; Odpovědi
              <span class="settings-hint" style="font-weight:normal">vyplň odpověď → otázka je vyřešená; vyřešená záhada = všechny otázky mají odpověď</span>
            </div>
            <div class="qa-list" id="mf-questions-${uid}">${questionRows}</div>
            <button type="button" class="dyn-add-btn" style="margin-top:0.4rem"
              ${dataAction('EditMode.addQARow', `mf-questions-${uid}`)}>+ Přidat otázku</button>
          </div>
          <div class="edit-section">
            <div class="edit-section-title">Spojené postavy</div>
            ${charPicker}
          </div>
          ${_visibilitySection(uid, m, 'mysteries')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">Popis / Co víme</label>
            ${_mdTextarea(`mf-desc-${uid}`, m.description, 20, 'Co o záhadě víme a co tušíme — Markdown')}
          </div>
        </div>
      </div>
    `;
  }

  function _chainEditHtml(chain, uid, ci) {
    const ranksHtml = (chain.ranks || []).map(r => `
      <div class="dyn-item">
        <input class="edit-input" value="${esc(r)}" placeholder="Hodnost">
        <button class="dyn-remove-btn"${dataAction('removeAncestor', '$el')}>×</button>
      </div>`).join("");
    return `
      <div class="rank-chain-edit" data-chain-id="${esc(chain.id || '')}">
        <div class="rank-chain-edit-header">
          <input class="edit-input edit-input-sm" placeholder="Název řetězce" value="${esc(chain.name || '')}" style="flex:1">
          <button class="dyn-remove-btn" title="Odebrat řetězec"${dataAction('removeAncestor', '$el', '.rank-chain-edit')}>✕</button>
        </div>
        <div class="dyn-list rank-ranks-list" id="ranks-${uid}-${ci}">
          ${ranksHtml}
        </div>
        <button class="dyn-add-btn" style="margin-top:0.3rem"
          ${dataAction('EditMode.addRankRow', `ranks-${uid}-${ci}`)}>+ Přidat hodnost</button>
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
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← Zrušit</button>
          <h2 class="edit-form-title">${isNew ? "✦ Nová frakce" : "✏ " + esc(f.name)}</h2>
          ${_twinHeaderRow(uid, isNew ? null : { ...f, id: facId }, 'factions')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveFaction', isNew ? "" : facId)}>💾 Uložit</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteFaction', facId)}>🗑 Smazat</button>` : ""}
          </div>
        </div>

        <div class="edit-row-2">
          <div class="edit-field">
            <label class="edit-label">Název *</label>
            <input class="edit-input" id="ff-name-${uid}" value="${esc(f.name)}" placeholder="Název frakce">
          </div>
          <div class="edit-field">
            <label class="edit-label">Odznak</label>
            <input class="edit-input" id="ff-badge-${uid}" value="${esc(f.badge)}" placeholder="🐉" style="font-size:1.4rem">
          </div>
        </div>
        <div class="edit-row-2">
          <div class="edit-field">
            <label class="edit-label">Barva pozadí</label>
            <div style="display:flex;gap:0.5rem;align-items:center">
              <input type="color" id="ff-color-${uid}" value="${esc(f.color)}"
                style="width:44px;height:34px;padding:2px;cursor:pointer;background:none;border:1px solid rgba(212,184,122,0.2);border-radius:4px"
                ${dataOn('input', 'copyValue', `ff-color-${uid}`, `ff-color-text-${uid}`)}>
              <input class="edit-input" id="ff-color-text-${uid}" value="${esc(f.color)}" placeholder="#RRGGBB" style="flex:1"
                ${dataOn('input', 'copyValue', `ff-color-text-${uid}`, `ff-color-${uid}`)}>
            </div>
          </div>
          <div class="edit-field">
            <label class="edit-label">Barva textu</label>
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
          <label class="edit-label">Popis frakce (volitelný)</label>
          ${_mdTextarea(`ff-desc-${uid}`, f.description || '', 6, 'Historie, cíle, struktura — Markdown')}
        </div>
        <div class="edit-field">
          <label class="edit-label">Postoje k partě <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">— členové bez vlastních postojů zdědí tyhle</span></label>
          ${factionAttRowHtml}
        </div>

        <div class="edit-section">
          <div class="edit-section-title">Hodnostní Řetězce
            <span class="edit-hint" style="font-weight:normal;margin-left:0.5rem">od nejvyšší po nejnižší</span>
          </div>
          <div id="chains-${uid}">${chainsHtml}</div>
          <button class="dyn-add-btn" style="margin-top:0.5rem"
            ${dataAction('EditMode.addRankChain', `chains-${uid}`, uid)}>+ Přidat řetězec</button>
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

  // ── Species editor ─────────────────────────────────────────────
  function renderSpeciesEditor(s) {
    const isNew = !s || !s.id;
    if (isNew) s = { id:'', name:'', description:'' };
    const uid = s.id || 'new_sp';
    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← Zrušit</button>
          <h2 class="edit-form-title">${isNew ? "✦ Nový druh" : "✏ " + esc(s.name)}</h2>
          ${_twinHeaderRow(uid, s, 'species')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveSpecies', s.id)}>💾 Uložit</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteSpecies', s.id)}>🗑 Smazat</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-field">
            <label class="edit-label">Název *</label>
            <input class="edit-input" id="sf-name-${uid}" value="${esc(s.name)}" placeholder="Člověk, Elf, Dračizeň…">
          </div>
          ${_visibilitySection(uid, s, 'species')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">Popis</label>
            ${_mdTextarea(`sf-desc-${uid}`, s.description, 20, 'Charakteristika druhu, schopnosti, kultura…')}
          </div>
        </div>
      </div>`;
  }

  // ── Pantheon (deity) editor ────────────────────────────────────
  function renderBuhEditor(g) {
    const isNew = !g || !g.id;
    if (isNew) g = { id:'', name:'', domain:'', alignment:'', symbol:'', description:'', tags:[] };
    const uid = g.id || 'new_god';
    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← Zrušit</button>
          <h2 class="edit-form-title">${isNew ? "✦ Nový bůh / bohyně" : "✏ " + esc(g.name)}</h2>
          ${_twinHeaderRow(uid, g, 'pantheon')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveBuh', g.id)}>💾 Uložit</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteBuh', g.id)}>🗑 Smazat</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">Jméno *</label>
              <input class="edit-input" id="gf-name-${uid}" value="${esc(g.name)}" placeholder="Jméno božstva">
            </div>
            <div class="edit-field">
              <label class="edit-label">Symbol</label>
              <input class="edit-input" id="gf-symbol-${uid}" value="${esc(g.symbol)}" placeholder="☀ / 🌙 / ⚔">
            </div>
          </div>
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">Doména</label>
              <input class="edit-input" id="gf-domain-${uid}" value="${esc(g.domain)}" placeholder="Světlo, Smrt, Moře…">
            </div>
            <div class="edit-field">
              <label class="edit-label">Zaměření</label>
              <input class="edit-input" id="gf-alignment-${uid}" value="${esc(g.alignment)}" placeholder="např. LG / CN / …">
            </div>
          </div>
          ${_visibilitySection(uid, g, 'pantheon')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">Popis</label>
            ${_mdTextarea(`gf-desc-${uid}`, g.description, 20, 'Mýty, kult, rituály, kněží…')}
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
      data-cb-empty-label="— nikdo —"
      data-cb-placeholder="Vyber postavu…"
      data-cb-on-create="character"></div>`;

    const locMount = `<div class="cb-mount"
      data-cb-id="af-loc-${uid}"
      data-cb-source="location"
      data-cb-value="${esc(a.locationId || '')}"
      data-cb-allow-empty="1"
      data-cb-empty-label="— neurčeno —"
      data-cb-placeholder="Vyber místo…"
      data-cb-on-create="location"></div>`;

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← Zrušit</button>
          <h2 class="edit-form-title">${isNew ? "✦ Nový artefakt" : "✏ " + esc(a.name)}</h2>
          ${_twinHeaderRow(uid, a, 'artifacts')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveArtifact', a.id)}>💾 Uložit</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteArtifact', a.id)}>🗑 Smazat</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-field">
            <label class="edit-label">Název *</label>
            <input class="edit-input" id="af-name-${uid}" value="${esc(a.name)}" placeholder="Název artefaktu">
          </div>
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">Držitel (postava)</label>
              ${ownerMount}
            </div>
            <div class="edit-field">
              <label class="edit-label">Umístění (místo)</label>
              ${locMount}
            </div>
          </div>
          ${_visibilitySection(uid, a, 'artifacts')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field edit-field-full">
            <label class="edit-label">Popis</label>
            ${_mdTextarea(`af-desc-${uid}`, a.description, 20, 'Původ, schopnosti, prokletí, historie…')}
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
      data-ms-placeholder="Vyber postavy…"
      data-ms-on-create="character"></div>`;

    const locsMount = `<div class="ms-mount"
      id="he-locs-${uid}"
      data-ms-source="location"
      data-ms-value="${esc((h.locations || []).join(','))}"
      data-ms-placeholder="Vyber místa…"
      data-ms-on-create="location"></div>`;

    return `
      <div class="edit-form edit-form-split">
        <div class="edit-form-header edit-form-split-header">
          <button class="back-btn"${dataAction('Wiki.cancelEditingArticle')}>← Zrušit</button>
          <h2 class="edit-form-title">${isNew ? "✦ Nová historická událost" : "✏ " + esc(h.name)}</h2>
          ${_twinHeaderRow(uid, h, 'historicalEvents')}
          <div class="edit-hdr-actions">
            <button class="edit-save-btn"${dataAction('EditMode.saveHistoricalEvent', h.id)}>💾 Uložit</button>
            ${!isNew ? `<button class="edit-delete-btn"${dataAction('EditMode.deleteHistoricalEvent', h.id)}>🗑 Smazat</button>` : ""}
          </div>
        </div>
        <div class="edit-form-split-fields">
          <div class="edit-field">
            <label class="edit-label">Název *</label>
            <input class="edit-input" id="he-name-${uid}" value="${esc(h.name)}" placeholder="Např. Pád Netheril">
          </div>
          <div class="edit-row-2">
            <div class="edit-field">
              <label class="edit-label">Začátek</label>
              <input class="edit-input" id="he-start-${uid}" value="${esc(h.start)}" placeholder="−339 DR">
            </div>
            <div class="edit-field">
              <label class="edit-label">Konec</label>
              <input class="edit-input" id="he-end-${uid}" value="${esc(h.end)}" placeholder="−180 DR">
            </div>
          </div>
          <div class="edit-field">
            <label class="edit-label">Shrnutí</label>
            <textarea class="edit-textarea" id="he-summary-${uid}" rows="4" placeholder="Krátký výtah — jedna věta nebo odstavec.">${esc(h.summary)}</textarea>
          </div>
          <div class="edit-field">
            <label class="edit-label">Postavy</label>
            ${charsMount}
          </div>
          <div class="edit-field">
            <label class="edit-label">Místa</label>
            ${locsMount}
          </div>
          <div class="edit-field">
            <label class="edit-label">Štítky</label>
            <input class="edit-input" id="he-tags-${uid}" value="${esc((h.tags || []).join(', '))}" placeholder="válka, magie, říše">
          </div>
          ${_visibilitySection(uid, h, 'historicalEvents')}
        </div>
        <div class="edit-form-split-article">
          <div class="edit-field">
            <label class="edit-label">Text</label>
            ${_mdTextarea(`he-body-${uid}`, h.body, 20, 'Podrobný popis události, příčiny, dopady…')}
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
    renderSpeciesEditor,
    renderBuhEditor,
    renderArtifactEditor,
    renderHistoricalEventEditor,
    getDynRowHtml: _dynRow,
    qaRowHtml: _qaRowHtml,
    qaListHtml: _qaListHtml,
    getRelSectionHtml: _relSection,
    getDirOptsHtml: _dirOpts,
    getTargetMountHtml: _targetMount,
    getRelConfig: () => REL_CONFIG,
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
