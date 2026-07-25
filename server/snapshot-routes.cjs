'use strict';

function registerSnapshotRoutes(app, {
  snapshots,
  requireAnyRole,
  requireDM,
  runWriteRequest,
  minManualIntervalMs = 3000,
  now = Date.now,
  logger = console,
}) {
  let lastManualSnapshotAt = 0;

  app.get('/api/snapshots', requireAnyRole, async (req, res) => {
    try {
      const files = await snapshots.files();
      let entries = (await Promise.all(files.map(snapshots.metadata))).filter(Boolean);
      if (req.role !== 'dm') {
        entries = entries
          .filter(entry => entry.access !== 'dm')
          .map(({ id, createdAt, reason }) => ({ id, createdAt, reason }));
      }
      entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      res.json({ snapshots: entries });
    } catch (error) {
      logger.error('GET /api/snapshots:', error);
      res.status(500).json({ error: 'List failed' });
    }
  });

  app.post('/api/snapshots', requireAnyRole, (_req, res) => {
    const timestamp = now();
    if (timestamp - lastManualSnapshotAt < minManualIntervalMs) {
      return res.status(429).json({
        error: 'Too many snapshots — try again in a few seconds',
      });
    }
    lastManualSnapshotAt = timestamp;
    runWriteRequest(res, async () => {
      try {
        const id = await snapshots.create('manual');
        res.json({ ok: true, id });
      } catch (error) {
        logger.error('POST /api/snapshots:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Snapshot failed' });
      }
    });
  });

  app.post('/api/snapshots/:id/restore', requireDM, (req, res) => {
    runWriteRequest(res, async () => {
      try {
        const result = await snapshots.restore(req.params.id);
        if (!result.ok) return res.status(404).json(result);
        res.json({ ok: true });
      } catch (error) {
        logger.error('POST /api/snapshots/:id/restore:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Restore failed' });
      }
    });
  });

  app.post('/api/snapshots/revert-last/:n', requireDM, (req, res) => {
    runWriteRequest(res, async () => {
      const count = Math.max(1, Math.min(50, Number(req.params.n) || 1));
      try {
        const files = await snapshots.files();
        if (files.length <= count) {
          return res.status(400).json({
            error: 'Nedostatek bodů zálohy pro zpětný krok',
          });
        }
        const id = files[files.length - 1 - count];
        const result = await snapshots.restore(id);
        if (!result.ok) return res.status(404).json(result);
        res.json({ ok: true, id });
      } catch (error) {
        logger.error('POST /api/snapshots/revert-last:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Revert failed' });
      }
    });
  });

  app.delete('/api/snapshots/:id', requireDM, async (req, res) => {
    try {
      const result = await snapshots.remove(req.params.id);
      if (result.invalid) return res.status(400).json({ error: 'Invalid id' });
      if (result.missing) {
        return res.status(404).json({ error: 'Snapshot nenalezen' });
      }
      res.json({ ok: true });
    } catch (error) {
      logger.error('DELETE /api/snapshots:', error);
      res.status(500).json({ error: 'Delete failed' });
    }
  });
}

module.exports = { registerSnapshotRoutes };
