// Example addon entry module. The host dynamically imports this from
// /addons/hello/<hash>/entry.js and calls the default export with a
// scoped `host` facade. The addon gets NOTHING except `host` — that's
// the boundary. Build HTML only with host.h helpers (esc/dataAction),
// never inline onclick, so the app stays CSP-clean.

export default function register(host) {
  // A left-sidebar link. Phase 1 groups addon links under "Doplňky".
  host.registerSidebarPage({ route: '/pozdrav', label: 'Pozdrav', icon: '👋' });

  // A top-level hash route. The render fn returns an HTML string that
  // the host injects into #main-content (or it can manage the DOM
  // itself and return undefined).
  host.registerRoute('pozdrav', () => {
    const { esc, dataAction } = host.h;
    const chars = host.store.getCharacters();           // read access (data:read:characters)
    const items = chars.slice(0, 20)
      .map(c => `<li>${esc(c.name || c.id)}</li>`)
      .join('') || '<li style="color:var(--text-muted)">(zatím žádné postavy)</li>';

    return `
      <div class="page-header"><h1>👋 Ahoj z doplňku!</h1></div>
      <p style="color:var(--text-muted);max-width:580px;margin:1rem 0 1.4rem">
        Celou tuhle stránku vykresluje doplněk <strong>${esc(host.id)}</strong> —
        jádro aplikace o jeho existenci neví. Doplněk čte data přes
        <code>host.store</code> (níže je prvních pár postav) a tlačítko používá
        <code>data-action</code>, takže nic neporušuje CSP.
      </p>
      <ul style="line-height:1.8">${items}</ul>
      <p style="margin-top:1.4rem">
        <button class="inline-create-btn"${dataAction('back')}>← Zpět</button>
      </p>`;
  });

  // Later phases add registerAction (namespaced "addonid:method"
  // data-actions), registerArticleSection, registerSettingsTab,
  // registerCollection, fragment overrides and per-addon permissions.
}
