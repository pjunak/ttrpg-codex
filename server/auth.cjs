'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  hashPassword,
  safeEqStrings,
  verifyPassword,
} = require('../server-utils.cjs');

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;
const LOGIN_ATTEMPTS_MAX = 5000;
const PLAYER_PREVIEW_MAX = 128;
const PLAYER_PREVIEW_TTL_MS = 8 * 60 * 60 * 1000;
const PLAYER_PREVIEW_HEADER = 'x-codex-player-preview';

function createAuthService({
  dataDir,
  atomicWrite,
  withWriteLock,
  env = process.env,
  logger = console,
  now = Date.now,
}) {
  const authFile = path.join(dataDir, 'auth.json');
  const loginAttempts = new Map();
  const playerPreviews = new Map();
  let authCache = null;

  function loadStoredCredentials() {
    if (authCache) return authCache;
    try {
      const parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      authCache = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('[auth] failed to read auth.json:', error.message);
      }
      authCache = {};
    }
    return authCache;
  }

  function storedCredentialFor(role) {
    const credential = loadStoredCredentials()[role];
    if (!credential
        || typeof credential.salt !== 'string'
        || typeof credential.hash !== 'string') {
      return null;
    }
    return credential;
  }

  async function writeStoredCredentials(credentials) {
    await atomicWrite(authFile, JSON.stringify(credentials, null, 2));
    try {
      await fs.promises.chmod(authFile, 0o600);
    } catch {}
    authCache = null;
  }

  function dmEnvironmentPassword() {
    return env.DM_PASSWORD || env.EDIT_PASSWORD || '123';
  }

  function playerEnvironmentPassword() {
    return env.PLAYER_PASSWORD || '';
  }

  function secretFor(role) {
    const stored = storedCredentialFor(role);
    if (stored) return stored.hash;
    return role === 'dm' ? dmEnvironmentPassword() : playerEnvironmentPassword();
  }

  function tokenFor(realRole, role) {
    const secret = secretFor(realRole);
    if (!secret) return '';
    return crypto.createHash('sha256')
      .update(`${realRole}:${role}:${secret}`)
      .digest('hex');
  }

  function verifyConfiguredPassword(role, raw) {
    const stored = storedCredentialFor(role);
    if (stored) return verifyPassword(stored, raw);
    const environmentPassword = role === 'dm'
      ? dmEnvironmentPassword()
      : playerEnvironmentPassword();
    return environmentPassword
      ? safeEqStrings(raw, environmentPassword)
      : false;
  }

  function parseSessionCookie(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    const [realRole, role, token] = parts;
    if (!['dm', 'player'].includes(realRole)) return null;
    if (!['dm', 'player'].includes(role)) return null;
    if (realRole === 'player' && role === 'dm') return null;
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    return { realRole, role, token };
  }

  function setSessionCookie(res, realRole, role) {
    res.cookie('edit_session', `${realRole}.${role}.${tokenFor(realRole, role)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });
  }

  function resolveRole(req) {
    const parsed = parseSessionCookie(req.cookies?.edit_session);
    if (!parsed) return { role: null, realRole: null };
    const expected = tokenFor(parsed.realRole, parsed.role);
    if (!expected || !safeEqStrings(parsed.token, expected)) {
      return { role: null, realRole: null };
    }
    return { role: parsed.role, realRole: parsed.realRole };
  }

  function prunePlayerPreviews() {
    const currentTime = now();
    for (const [previewToken, expiresAt] of playerPreviews) {
      if (expiresAt <= currentTime) playerPreviews.delete(previewToken);
    }
    while (playerPreviews.size >= PLAYER_PREVIEW_MAX) {
      playerPreviews.delete(playerPreviews.keys().next().value);
    }
  }

  function issuePlayerPreview() {
    prunePlayerPreviews();
    const previewToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + PLAYER_PREVIEW_TTL_MS;
    playerPreviews.set(previewToken, expiresAt);
    return { token: previewToken, expiresAt };
  }

  function requestedPlayerPreview(req) {
    const hasHeader = Object.prototype.hasOwnProperty.call(req.headers || {}, PLAYER_PREVIEW_HEADER);
    const hasQuery = Object.prototype.hasOwnProperty.call(req.query || {}, 'playerPreviewToken');
    if (!hasHeader && !hasQuery) return null;
    const value = hasHeader ? req.get?.(PLAYER_PREVIEW_HEADER) : req.query.playerPreviewToken;
    return { value: typeof value === 'string' ? value : '' };
  }

  function resolvePlayerPreview(req) {
    const requested = requestedPlayerPreview(req);
    if (!requested) return null;
    const expiresAt = playerPreviews.get(requested.value);
    if (!expiresAt || expiresAt <= now()) {
      playerPreviews.delete(requested.value);
      return { role: null, realRole: null, requested: true };
    }
    return { role: 'player', realRole: 'player', requested: true };
  }

  function attachRole(req, _res, next) {
    const preview = resolvePlayerPreview(req);
    const { role, realRole } = preview || resolveRole(req);
    req.role = role;
    req.realRole = realRole;
    req.playerPreview = !!(preview && role === 'player');
    next();
  }

  function requireRole(role) {
    return (req, res, next) => {
      if (req.role === role) return next();
      return res.status(401).json({ error: 'Neznámé nebo chybějící heslo.' });
    };
  }

  function requireAnyRole(req, res, next) {
    if (req.role === 'dm' || req.role === 'player') return next();
    return res.status(401).json({ error: 'Neznámé nebo chybějící heslo.' });
  }

  function requireRealDM(message = 'Pouze pro DM') {
    return (req, res, next) => {
      if (req.realRole !== 'dm') {
        return res.status(403).json({ error: message });
      }
      return next();
    };
  }

  function loginKey(req) {
    return (req.ip || req.socket?.remoteAddress || 'unknown').toString();
  }

  function isBlocked(ip) {
    const attempt = loginAttempts.get(ip);
    if (!attempt) return false;
    if (now() - attempt.firstMs > LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
      return false;
    }
    return attempt.count >= LOGIN_MAX;
  }

  function noteFailure(ip) {
    const currentTime = now();
    if (loginAttempts.size > LOGIN_ATTEMPTS_MAX) {
      for (const [key, attempt] of loginAttempts) {
        if (currentTime - attempt.firstMs > LOGIN_WINDOW_MS) {
          loginAttempts.delete(key);
        }
      }
    }
    const attempt = loginAttempts.get(ip);
    if (!attempt || currentTime - attempt.firstMs > LOGIN_WINDOW_MS) {
      loginAttempts.set(ip, { count: 1, firstMs: currentTime });
    } else {
      attempt.count++;
    }
  }

  function credentialStatus() {
    const dm = storedCredentialFor('dm');
    const player = storedCredentialFor('player');
    return {
      dm: {
        stored: !!dm,
        updatedAt: dm ? (dm.updatedAt || null) : null,
        envFallback: !dm && !!(env.DM_PASSWORD || env.EDIT_PASSWORD),
        isDefault: !dm && !(env.DM_PASSWORD || env.EDIT_PASSWORD),
      },
      player: {
        stored: !!player,
        updatedAt: player ? (player.updatedAt || null) : null,
        envFallback: !player && !!env.PLAYER_PASSWORD,
        disabled: !player && !env.PLAYER_PASSWORD,
      },
    };
  }

  function reportConfiguration() {
    const storedDm = !!storedCredentialFor('dm');
    const storedPlayer = !!storedCredentialFor('player');
    const dmPassword = env.DM_PASSWORD || env.EDIT_PASSWORD;
    const legacyAlias = !!env.EDIT_PASSWORD && !env.DM_PASSWORD;
    if (!storedDm && (!dmPassword || dmPassword === '123')) {
      logger.warn('');
      logger.warn(`  ⚠  DM password is ${dmPassword ? 'the default ("123")' : 'UNSET'}.`);
      logger.warn('     Anyone with the source can compute the cookie value and gain DM access.');
      logger.warn('     Set DM_PASSWORD in the environment, OR sign in once and change it from Settings → Účet.');
      logger.warn('');
    } else if (!storedDm && legacyAlias) {
      logger.warn('');
      logger.warn('  ℹ  Using EDIT_PASSWORD as DM_PASSWORD (back-compat alias).');
      logger.warn('     Set DM_PASSWORD explicitly to silence this notice.');
      logger.warn('');
    } else if (storedDm) {
      logger.log('  ✓  DM password loaded from data/auth.json (overrides env var).');
    }
    if (!storedPlayer && !env.PLAYER_PASSWORD) {
      logger.warn('  ℹ  Player password is unset — player login is disabled.');
      logger.warn('     Unauthenticated visitors see only public content (same view as a player).');
      logger.warn('     Set PLAYER_PASSWORD, or sign in as DM and configure it from Settings → Účet.');
      logger.warn('');
    }
  }

  function registerRoutes(app) {
    app.post('/api/login', (req, res) => {
      const ip = loginKey(req);
      if (isBlocked(ip)) {
        return res.status(429).json({
          error: 'Příliš mnoho neúspěšných pokusů. Zkus to za 15 minut.',
        });
      }
      const { password } = req.body || {};
      if (typeof password !== 'string') {
        noteFailure(ip);
        return res.status(401).json({ error: 'Špatné heslo' });
      }

      let role = null;
      if (verifyConfiguredPassword('dm', password)) role = 'dm';
      else if (verifyConfiguredPassword('player', password)) role = 'player';
      if (!role) {
        noteFailure(ip);
        return res.status(401).json({ error: 'Špatné heslo' });
      }

      loginAttempts.delete(ip);
      setSessionCookie(res, role, role);
      return res.json({ ok: true, role });
    });

    app.post('/api/logout', (req, res) => {
      if (req.playerPreview) return res.json({ ok: true, playerPreview: true });
      res.clearCookie('edit_session', { path: '/' });
      return res.json({ ok: true });
    });

    app.get('/api/auth', (req, res) => {
      res.json({
        role: req.role,
        realRole: req.realRole,
        ...(req.playerPreview ? { playerPreview: true } : {}),
      });
    });

    app.post('/api/player-preview', requireRole('dm'), (_req, res) => {
      res.json(issuePlayerPreview());
    });

    app.post('/api/view-as', requireRealDM(), (_req, res) => {
      setSessionCookie(res, 'dm', 'player');
      res.json({ ok: true, role: 'player', realRole: 'dm' });
    });

    app.post('/api/view-as-dm', requireRealDM(), (_req, res) => {
      setSessionCookie(res, 'dm', 'dm');
      res.json({ ok: true, role: 'dm', realRole: 'dm' });
    });

    app.get('/api/passwords', requireRealDM(), (_req, res) => {
      res.json(credentialStatus());
    });

    app.post('/api/passwords', requireRealDM(), async (req, res) => {
      const { role, newPassword, currentPassword } = req.body || {};
      if (role !== 'dm' && role !== 'player') {
        return res.status(400).json({ error: 'Neznámá role' });
      }
      if (typeof newPassword !== 'string') {
        return res.status(400).json({ error: 'Heslo musí být řetězec' });
      }
      if (!verifyConfiguredPassword('dm', currentPassword || '')) {
        return res.status(401).json({ error: 'Aktuální DM heslo nesouhlasí' });
      }
      if (role === 'dm' && newPassword.length < 4) {
        return res.status(400).json({
          error: 'DM heslo musí mít alespoň 4 znaky',
        });
      }
      if (role === 'player' && newPassword.length > 0 && newPassword.length < 4) {
        return res.status(400).json({
          error: 'Hráčské heslo musí mít alespoň 4 znaky (nebo prázdné pro vymazání)',
        });
      }
      if (newPassword.length > 200) {
        return res.status(400).json({ error: 'Heslo je příliš dlouhé' });
      }

      await withWriteLock(async () => {
        const credentials = { ...loadStoredCredentials() };
        if (role === 'player' && newPassword === '') {
          delete credentials.player;
        } else {
          credentials[role] = hashPassword(newPassword);
        }
        await writeStoredCredentials(credentials);
      });

      if (role === 'dm') {
        setSessionCookie(res, 'dm', req.role === 'player' ? 'player' : 'dm');
      }
      return res.json({ ok: true, role });
    });
  }

  return Object.freeze({
    attachRole,
    registerRoutes,
    reportConfiguration,
    requireAnyRole,
    requireDM: requireRole('dm'),
    requireRealDM,
  });
}

module.exports = {
  createAuthService,
};
