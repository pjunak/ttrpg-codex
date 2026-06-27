// Pravidla (Rulebook) — Phase 4b-2 reference addon.
//
// Demonstrates the addon DATA + linking surface that landed this phase:
//   • registerCollection  — an addon-OWNED collection ("rules"), declared in
//                           addon.json and stored isolated at
//                           data/addon-data/rules/rules.json (server side).
//   • host.store.collection(name) — scoped CRUD (list/get/save/remove) gated
//                           by the data:own permission. Saves round-trip
//                           through /api/data and broadcast over SSE like core
//                           data — multiple clients stay in sync.
//   • registerWikiKind     — `[[Název|pravidlo]]` resolves into this addon's
//                           page (by name → the rule's real id).
//   • registerRoute + registerSidebarPage — a first-class page at /pravidla.
//
// Style + safety rules every addon follows: build HTML only with host.h
// (esc / dataAction / dataOn) — never inline onclick — and use design-system
// tokens (var(--…)) / documented classes so the theme switcher reskins it for
// free.

export default function register(host) {
  const { esc, dataAction, dataOn, renderMarkdown } = host.h;

  // Declare the collection first so the scoped CRUD handle resolves and local
  // reads never throw (the server already knows it from addon.json).
  host.registerCollection('rules');
  const rules = () => host.store.collection('rules');
  const canEdit = () => !host.role.isAnonymous();

  host.registerSidebarPage({ route: '/pravidla', label: 'Pravidla', icon: '📖' });

  // [[Grappling|pravidlo]] → look the rule up BY NAME and return its real
  // (suffixed) id, so links survive even though ids aren't the slug.
  host.registerWikiKind('pravidlo', (label) => {
    const n = String(label || '').trim().toLowerCase();
    const hit = rules().list().find(r => (r.name || '').toLowerCase() === n);
    return hit ? { kind: 'pravidla', id: hit.id } : null;
  });

  // ── Actions (data-action="rules:<name>") ──────────────────────
  function doCreate() {
    const input = document.getElementById('rules-new-name');
    const name = (input && input.value || '').trim();
    if (!name) return;
    rules().save({ name, body: '' });   // id generated, updatedAt stamped, synced
    host.ui.toast('Přidáno pravidlo: ' + name);
    host.ui.rerender();
  }
  host.registerAction('create', doCreate);
  host.registerAction('createOnEnter', (ev) => {
    if (ev && ev.key === 'Enter') { ev.preventDefault(); doCreate(); }
  });
  host.registerAction('save', (id) => {
    const ta  = document.getElementById('rules-body-' + id);
    const rec = rules().get(id);
    if (!ta || !rec) return;
    rules().save({ ...rec, body: ta.value });
    host.ui.toast('Uloženo.');
    host.ui.rerender();
  });
  host.registerAction('remove', (id) => { rules().remove(id); host.ui.rerender(); });

  // ── Route: /pravidla (index) + /pravidla/<id> (one rule) ──────
  host.registerRoute('pravidla', (sub) => sub ? renderOne(sub) : renderIndex());

  function renderIndex() {
    const list = rules().list()
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
    const items = list.length
      ? list.map(r => `<li><a href="#/pravidla/${esc(r.id)}">${esc(r.name || '(bez názvu)')}</a></li>`).join('')
      : `<li style="color:var(--text-muted)">Zatím žádná pravidla.</li>`;
    const addBox = canEdit() ? `
      <div style="display:flex;gap:var(--space-2);margin-top:var(--space-4);max-width:32rem">
        <input id="rules-new-name" class="sc-input" style="flex:1" placeholder="Název nového pravidla"
               ${dataOn('keydown', host.action('createOnEnter'), '$ev')}>
        <button class="inline-create-btn"${dataAction(host.action('create'))}>＋ Přidat</button>
      </div>` : '';
    return `
      <div class="page-header"><h1>📖 Pravidla</h1></div>
      <p style="color:var(--text-muted);max-width:40rem">
        Domácí pravidla — vlastní data doplňku <strong>${esc(host.id)}</strong>. Odkazujte na
        ně odkudkoli zápisem <code>[[Název pravidla|pravidlo]]</code>.</p>
      <ul style="margin-top:var(--space-3);line-height:1.9">${items}</ul>
      ${addBox}`;
  }

  function renderOne(id) {
    const rec = rules().get(id);
    if (!rec) {
      return `<div class="page-header"><h1>Pravidlo nenalezeno</h1></div>
        <p><a href="#/pravidla">← Zpět na pravidla</a></p>`;
    }
    const editor = canEdit() ? `
      <details style="margin-top:var(--space-4)">
        <summary style="cursor:pointer;color:var(--accent-gold)">✏ Upravit</summary>
        <textarea id="rules-body-${esc(id)}" class="sc-input" rows="10"
                  style="width:100%;margin-top:var(--space-2);font-family:var(--font-body)">${esc(rec.body || '')}</textarea>
        <div style="display:flex;gap:var(--space-2);margin-top:var(--space-2)">
          <button class="inline-create-btn"${dataAction(host.action('save'), id)}>💾 Uložit</button>
          <button class="inline-create-btn" style="color:var(--color-danger)"${dataAction(host.action('remove'), id)}>🗑 Smazat</button>
        </div>
      </details>` : '';
    return `
      <div class="page-header">
        <a href="#/pravidla" style="color:var(--text-muted)">← Pravidla</a>
        <h1>${esc(rec.name || '(bez názvu)')}</h1>
      </div>
      <div class="md-view">${renderMarkdown(rec.body || '_Bez obsahu._')}</div>
      ${editor}`;
  }
}
