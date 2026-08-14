export const CLOUDMAP_COMPACT_ZOOM = 0.75;
export const CLOUDMAP_OVERVIEW_ZOOM = 0.45;

export function cloudMapDetailLevel(zoom) {
  const value = Number(zoom);
  const normalized = Number.isFinite(value) ? value : 1;
  if (normalized < CLOUDMAP_OVERVIEW_ZOOM) return 'overview';
  if (normalized < CLOUDMAP_COMPACT_ZOOM) return 'compact';
  return 'full';
}
