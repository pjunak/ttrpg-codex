export const visualCampaign = {
  contractVersion: 'campaign-data.v1',
  collections: ['characters','relationships','locations','events','mysteries','factions','deletedDefaults','pantheon','artifacts','settings','historicalEvents','campaign','pets'].map(name => ({
    name, shape: ['factions','deletedDefaults','settings','campaign'].includes(name) ? 'keyed' : 'list', materialized: true, revision: 1,
    records: ({
      settings: [{ key: 'addonSidebarVisibility', revision: 1, value: { 'visual-fixture:/addons/visual-fixture/tools': 'dm' } }],
      campaign: [{ key: 'main', revision: 1, value: { name: 'Asurai', tagline: 'Beyond the northern mountains' } }],
      characters: ['Ryn','Mira','Kael','Talia'].map((name, index) => ({ key: name.toLowerCase(), revision: 1, value: {
        id: name.toLowerCase(), name, title: ['Scout','Wizard','Guardian','Ranger'][index], faction: 'party', status: 'alive', knowledge: 4,
        description: '## At the northern gate\nThe party followed the old road into the mountains.\n\n### A promise\nReturn before the first snow.',
        updatedAt: '2026-08-20T10:00:00Z', visibility: 'public',
      } })),
      pets: [{ key: 'owl', revision: 1, value: { id: 'owl', name: 'Pip', species: 'Owl', icon: '🦉', ownerType: 'party' } }],
      locations: [{ key: 'gate', revision: 1, value: { id: 'gate', name: 'Northern Gate', description: 'The road into the mountains.', visibility: 'public' } }],
      events: [{ key: 'arrival', revision: 1, value: { id: 'arrival', name: 'Arrival at the gate', short: 'The expedition reaches the old watchtower.', sitting: 12, order: 0, visibility: 'public' } }],
    })[name] ?? [],
  })),
};

// An isolated synthetic HTTP fixture. No Go host or campaign data directory is used.
export function visualFixturePlugin({ getCampaign = () => visualCampaign, onStream = () => {} } = {}) {
  const streams = new Set();
  const configure = (server) => {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/')) return next();
        if (request.url === '/api/events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
          response.write('id: 0\nevent: hello\ndata: {"cursor":0,"audience":"public"}\n\n');
          streams.add(response);
          onStream(response);
          request.on('close', () => streams.delete(response));
          return;
        }
        const role = request.headers['x-fixture-role'];
        const addon = request.headers['x-fixture-addon'] === 'true';
        if (request.url === fixtureAddon.entryUrl && addon) {
          response.writeHead(200, { 'Content-Type': 'text/javascript' });
          response.end(`export function activate(context) {
            if (!customElements.get('visual-fixture-addon')) customElements.define('visual-fixture-addon', class extends HTMLElement {
              connectedCallback() { this.textContent = 'Synthetic add-on page'; }
            });
            context.ui.bind('fixture.route', { kind: 'element', tag: 'visual-fixture-addon' });
          }`);
          return;
        }
        const payload = {
          '/api/health': { status: 'ok', version: 'visual-fixture' },
          '/api/auth': role === 'dm' || role === 'player' ? { ok: true, role, realRole: role, csrfToken: 'x'.repeat(32), expiresAt: '2099-01-01T00:00:00Z' } : { role: null, realRole: null },
          '/api/campaign': getCampaign(),
          '/api/addons/browser-graph': { contractVersion: 2, graphRevision: 'a'.repeat(64), addons: addon && role === 'dm' ? [fixtureAddon] : [] },
        }[request.url];
        response.writeHead(payload === undefined ? 404 : 200, { 'Content-Type': 'application/json',
          ...(request.url === '/api/addons/browser-graph' ? { ETag: `"${'a'.repeat(64)}"` } : {}) });
        response.end(JSON.stringify(payload ?? { error: 'Unknown fixture endpoint' }));
      });
  };
  return { name: 'visual-campaign-fixture', configureServer: configure, configurePreviewServer: configure,
    closeBundle() { for (const response of streams) response.end(); } };
}

const fixtureAddon = {
  addonId: 'visual-fixture', addonVersion: '1.0.0', generationId: 'c'.repeat(64), mode: 'integrated',
  entryUrl: `/api/addons/visual-fixture/generations/${'c'.repeat(64)}/assets/web/index.js`,
  styleUrls: [], sandbox: [], dependencies: [], capabilities: ['ui.contributions'], permissions: [],
  contributions: [
    { id: 'fixture.route', surface: 'route', label: 'Fixture tools', roles: ['dm'], order: 100, requires: ['ui.contributions'], config: { path: 'tools' } },
    { id: 'fixture.sidebar', surface: 'sidebar', label: 'Fixture tools', roles: ['dm'], order: 100, requires: ['ui.contributions'], config: { route: 'fixture.route' } },
  ],
};
