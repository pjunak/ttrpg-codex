export const ADDON_SIDEBAR_MODES = Object.freeze(['everyone', 'dm', 'hidden']);

export function addonSidebarPageKey(page) {
  const addonId = typeof page?.addonId === 'string' ? page.addonId : '';
  const route = typeof page?.route === 'string' ? page.route : '';
  return addonId && route ? `${addonId}:${route}` : '';
}

export function normalizeAddonSidebarVisibility(value) {
  const clean = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return clean;
  for (const [key, mode] of Object.entries(value)) {
    if (!key || key.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    if (ADDON_SIDEBAR_MODES.includes(mode)) clean[key] = mode;
  }
  return clean;
}

export function addonSidebarPageMode(page, visibility) {
  const configured = visibility?.[addonSidebarPageKey(page)];
  const mode = ADDON_SIDEBAR_MODES.includes(configured) ? configured : 'hidden';
  return page?.role === 'dm' && mode === 'everyone' ? 'dm' : mode;
}

export function addonSidebarPageVisible(page, visibility, isDM) {
  const mode = addonSidebarPageMode(page, visibility);
  return mode === 'everyone' || (mode === 'dm' && isDM);
}
