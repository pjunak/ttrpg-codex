'use strict';
// Server-side half of the dice addon — Phase 7 reference.
//
// The host loads this module at boot (when the addon is enabled AND granted
// `server:code`) and calls init(serverHost). Routes mount under the namespaced
// prefix `/api/addon/dice/*` — they can never collide with core or another
// addon. The facade is scoped: data read/write is confined to this addon's own
// dir (data/addon-data/dice/), core reads need a granted permission, and
// `lib()` only yields vetted host npm deps. A throw here never crashes the
// server — the addon just loads to an `error` state.
module.exports.init = (host) => {
  // GET /api/addon/dice/roll?d=20&n=1 — SERVER-authoritative roll (the client
  // can't fudge the result) + append to the addon's isolated log.
  host.get('/roll', async (req, res) => {
    const sides = Math.min(1000, Math.max(2, parseInt(req.query.d, 10) || 20));
    const count = Math.min(100, Math.max(1, parseInt(req.query.n, 10) || 1));
    const rolls = [];
    for (let i = 0; i < count; i++) rolls.push(1 + Math.floor(Math.random() * sides));
    const total = rolls.reduce((a, b) => a + b, 0);
    try {
      const log = (await host.data.read('log')) || [];
      log.push({ at: Date.now(), sides, count, rolls, total, by: req.role || 'anon' });
      await host.data.write('log', log.slice(-50));   // keep the last 50
    } catch (e) { host.log('log write failed:', e.message); }
    res.json({ sides, count, rolls, total });
  });

  // GET /api/addon/dice/log — recent rolls (the addon's own isolated data).
  host.get('/log', async (_req, res) => {
    res.json({ log: (await host.data.read('log')) || [] });
  });
};
