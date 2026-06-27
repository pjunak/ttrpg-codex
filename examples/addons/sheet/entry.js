// Active character sheet — Phase 5 reference addon.
//
// Demonstrates per-entity addonData (data bound to a CORE entity, not an
// addon-owned collection):
//   • registerArticleSection — an interactive HP block on every character page
//   • registerEditorFields    — Max HP + a note, injected into the character
//                               editor, collected back into addonData on save
//   • host.store.patchAddonData — read-modify-write THIS addon's namespace
//                               (`character.addonData['demo-sheet']`); the host
//                               injects the addon id so it can only touch its own
//   • registerAction          — the HP +/- buttons (namespaced data-action)
//   • registerSettingsTab      — an info panel
//
// Each capability is gated by a permission in addon.json; the host facade only
// exposes what was granted. Build HTML only with host.h (esc/dataAction) — never
// inline onclick — and style with design-system tokens.

export default function register(host) {
  const { esc, dataAction } = host.h;
  const NS = host.id;                                   // 'demo-sheet'
  const sheetOf = (c) => (c && c.addonData && c.addonData[NS]) || {};
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

  // ── Interactive sheet on every character article ──────────────
  host.registerArticleSection('characters', (c) => {
    if (!c) return null;
    const s     = sheetOf(c);
    const maxHp = num(s.maxHp, 10);
    const hp    = num(s.hp, maxHp);
    const editable = !host.role.isAnonymous();
    const controls = editable
      ? `<button class="inline-create-btn"${dataAction(host.action('hp'), c.id, -1)}>−</button>
         <button class="inline-create-btn"${dataAction(host.action('hp'), c.id, 1)}>＋</button>`
      : '';
    return {
      title: '🎲 Aktivní deník',
      html: `
        <div style="display:flex;align-items:center;gap:var(--space-3)">
          <div style="font-size:var(--text-xl)"><strong>${esc(String(hp))}</strong>
            <span style="color:var(--text-muted)"> / ${esc(String(maxHp))} HP</span></div>
          ${controls}
        </div>
        ${s.note ? `<p style="margin-top:var(--space-2);color:var(--text-muted)">${esc(s.note)}</p>` : ''}`,
    };
  });

  // HP +/- → patch ONLY this addon's namespace, clamped to [0, maxHp].
  host.registerAction('hp', (id, delta) => {
    host.store.patchAddonData('characters', id, (s) => {
      const maxHp = num(s.maxHp, 10);
      const cur   = num(s.hp, maxHp);
      return { ...s, hp: Math.max(0, Math.min(maxHp, cur + Number(delta))) };
    });
    host.ui.rerender();
  });

  // ── Editor fields — configure the sheet on the character edit form ──
  host.registerEditorFields('characters', {
    fields: (c) => {
      const s = sheetOf(c);
      return `
        <div class="edit-section">
          <div class="edit-section-title">🎲 Aktivní deník (${esc(NS)})</div>
          <label class="edit-label">Max HP</label>
          <input id="ds-maxhp" class="edit-input" type="number" min="0" value="${esc(String(num(s.maxHp, 10)))}">
          <label class="edit-label">Poznámka na listu</label>
          <input id="ds-note" class="edit-input" value="${esc(s.note || '')}">
        </div>`;
    },
    // scope = this addon's .addon-editor-section; entity = the in-progress save
    // (so its addonData already carries the existing namespace to merge over).
    collect: (scope, c) => {
      const prev  = sheetOf(c);
      const maxHp = parseInt(scope.querySelector('#ds-maxhp')?.value, 10);
      const note  = scope.querySelector('#ds-note')?.value || '';
      const next  = { ...prev, note };
      if (Number.isFinite(maxHp)) {
        next.maxHp = Math.max(0, maxHp);
        if (Number.isFinite(next.hp)) next.hp = Math.min(next.hp, next.maxHp);
      }
      return next;
    },
  });

  // ── Info tab (Nastavení → 🎲 Demo list) ───────────────────────
  host.registerSettingsTab({
    id: 'info', label: 'Demo list', icon: '🎲', role: 'dm',
    render: () => `
      <div class="settings-editor-head"><h2>🎲 Aktivní deník postavy</h2></div>
      <div class="settings-panel">
        <p class="settings-hint">
          Ukázkový doplněk Phase 5 — přidává interaktivní HP na stránky postav
          (data v <code>character.addonData['${esc(NS)}']</code>) a pole do editoru
          postavy. Postav v databázi: <strong>${host.store.getCharacters().length}</strong>.
        </p>
      </div>`,
  });
}
