// Client half of the server-backed dice addon (Phase 7). The page calls the
// addon's OWN server endpoint /api/addon/dice/* — server-authoritative rolls
// (the client can't fudge them) plus a server-side isolated log. Addons may use
// raw fetch for their own same-origin endpoints; the host facade gates Store
// access, not network calls.
export default function register(host) {
  const { esc, dataAction } = host.h;

  host.registerSidebarPage({ route: '/kostky', label: 'Kostky', icon: '🎲' });

  host.registerAction('roll', async (sides) => {
    try {
      const r = await fetch(`/api/addon/${host.id}/roll?d=${encodeURIComponent(sides)}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      host.ui.toast(`🎲 k${j.sides}: ${j.total} (${j.rolls.join(', ')})`);
    } catch (e) { host.ui.toast('Hod selhal: ' + e.message); }
  });

  host.registerRoute('kostky', () => {
    const btn = s => `<button class="inline-create-btn"${dataAction(host.action('roll'), s)}>k${s}</button>`;
    return `
      <div class="page-header"><h1>🎲 Kostky</h1></div>
      <p style="color:var(--text-muted);max-width:40rem">
        Hody se počítají na <strong>serveru</strong>
        (<code>/api/addon/${esc(host.id)}/roll</code>) — klient je nemůže ovlivnit —
        a logují se do izolovaných dat doplňku.</p>
      <div style="display:flex;gap:var(--space-2);margin-top:var(--space-3);flex-wrap:wrap">
        ${[4, 6, 8, 10, 12, 20, 100].map(btn).join('')}
      </div>`;
  });
}
