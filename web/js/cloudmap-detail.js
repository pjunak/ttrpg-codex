export const CLOUDMAP_COMPACT_ZOOM = 0.6;
export const CLOUDMAP_OVERVIEW_ZOOM = 0.45;
export const CLOUDMAP_FULL_DETAIL_ZOOM = 1;
export const CLOUDMAP_TYPOGRAPHY_STEP = 0.25;

export function cloudMapDetailLevel(zoom) {
  const value = Number(zoom);
  const normalized = Number.isFinite(value) ? value : 1;
  if (normalized < CLOUDMAP_OVERVIEW_ZOOM) return 'overview';
  if (normalized < CLOUDMAP_COMPACT_ZOOM) return 'compact';
  if (normalized < CLOUDMAP_FULL_DETAIL_ZOOM) return 'condensed';
  return 'full';
}

export function cloudMapTypographyScale(zoom) {
  const value = Number(zoom);
  const normalized = Number.isFinite(value) ? Math.max(0, value) : 1;
  if (normalized <= 1) return 1;
  return Math.floor((normalized + Number.EPSILON) / CLOUDMAP_TYPOGRAPHY_STEP)
    * CLOUDMAP_TYPOGRAPHY_STEP;
}

export function cloudMapHiddenDetailKey(zoom) {
  const level = cloudMapDetailLevel(zoom);
  return level === 'full' ? '' : `cloudmap.hiddenDetails.${level}`;
}
