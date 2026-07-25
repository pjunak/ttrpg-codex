'use strict';

function createLiveSyncService({
  dataHash,
  maxClients = 256,
  maxClientsPerIp = 64,
  now = Date.now,
}) {
  const clients = new Map();
  const clientsByIp = new Map();

  function broadcast(eventName, payload, role = null) {
    const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [response, clientRole] of clients) {
      if (role && clientRole !== role) continue;
      try {
        response.write(data);
      } catch {}
    }
  }

  function hasRole(role) {
    for (const clientRole of clients.values()) {
      if (clientRole === role) return true;
    }
    return false;
  }

  async function broadcastDataChanged(access = 'public') {
    const at = now();
    const roles = access === 'dm' ? ['dm'] : ['dm', 'player'];
    for (const role of roles) {
      if (!hasRole(role)) continue;
      broadcast('data-changed', { hash: await dataHash(role), at }, role);
    }
  }

  function removeClient(response, ip, ping) {
    clearInterval(ping);
    if (!clients.delete(response)) return;
    const remaining = (clientsByIp.get(ip) || 0) - 1;
    if (remaining > 0) clientsByIp.set(ip, remaining);
    else clientsByIp.delete(ip);
  }

  function registerRoute(app) {
    app.get('/api/events', async (req, res) => {
      const ip = req.ip;
      if (clients.size >= maxClients
          || (clientsByIp.get(ip) || 0) >= maxClientsPerIp) {
        return res.status(503).json({
          error: 'Too many event-stream connections',
        });
      }

      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      const role = req.role === 'dm' ? 'dm' : 'player';
      const hash = await dataHash(role);
      try {
        res.write(`event: hello\ndata: ${JSON.stringify({ hash, at: now() })}\n\n`);
      } catch {
        return;
      }

      clients.set(res, role);
      clientsByIp.set(ip, (clientsByIp.get(ip) || 0) + 1);
      const ping = setInterval(() => {
        try {
          res.write(`: ping ${now()}\n\n`);
        } catch {}
      }, 25_000);
      req.once('close', () => removeClient(res, ip, ping));
    });
  }

  return Object.freeze({
    broadcast,
    broadcastDataChanged,
    registerRoute,
  });
}

module.exports = {
  createLiveSyncService,
};
