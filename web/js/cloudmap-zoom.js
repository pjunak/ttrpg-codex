export const NATIVE_CLOUDMAP_ZOOM = 1;
export const DEFAULT_CLOUDMAP_FIT_MAX_ZOOM = 0.8;
export const DEFAULT_CLOUDMAP_FIT_MIN_ZOOM = 0.45;

// Mind maps use the planner's fixed ladder plus one wider overview step. The
// extra 25% level is intentional: Mind Palace projects a whole campaign graph,
// while Story Planner opens one focused scope at a time.
export const CLOUDMAP_ZOOM_LEVELS = Object.freeze([
  0.25,
  0.35,
  0.45,
  0.55,
  0.6,
  0.7,
  0.8,
  0.9,
  NATIVE_CLOUDMAP_ZOOM,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
]);

export const MIN_CLOUDMAP_ZOOM = CLOUDMAP_ZOOM_LEVELS[0];
export const MAX_CLOUDMAP_ZOOM = CLOUDMAP_ZOOM_LEVELS.at(-1);

export function clampCloudMapZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NATIVE_CLOUDMAP_ZOOM;
  return Math.min(MAX_CLOUDMAP_ZOOM, Math.max(MIN_CLOUDMAP_ZOOM, numeric));
}

export function normalizeCloudMapZoom(value) {
  const zoom = clampCloudMapZoom(value);
  return CLOUDMAP_ZOOM_LEVELS.reduce((nearest, level) => (
    Math.abs(level - zoom) < Math.abs(nearest - zoom) ? level : nearest
  ));
}

export function stepCloudMapZoom(value, direction, stepCount = 1) {
  const current = normalizeCloudMapZoom(value);
  const currentIndex = CLOUDMAP_ZOOM_LEVELS.indexOf(current);
  const nativeIndex = CLOUDMAP_ZOOM_LEVELS.indexOf(NATIVE_CLOUDMAP_ZOOM);
  const count = Math.max(0, Math.floor(Math.abs(Number(stepCount) || 0)));
  const offset = Math.sign(Number(direction) || 0) * count;
  let nextIndex = Math.min(
    CLOUDMAP_ZOOM_LEVELS.length - 1,
    Math.max(0, currentIndex + offset),
  );
  if (
    (currentIndex < nativeIndex && nextIndex > nativeIndex)
    || (currentIndex > nativeIndex && nextIndex < nativeIndex)
  ) nextIndex = nativeIndex;
  return CLOUDMAP_ZOOM_LEVELS[nextIndex];
}

/**
 * Snap a continuous Cytoscape fit result down to the nearest ladder step so
 * the complete graph remains inside the viewport. Initial render can cap the
 * result below 100%; an explicit Fit action may pass a higher cap.
 */
export function fittedCloudMapZoom(
  value,
  maxZoom = NATIVE_CLOUDMAP_ZOOM,
  minZoom = MIN_CLOUDMAP_ZOOM,
) {
  const limit = Math.min(clampCloudMapZoom(maxZoom), clampCloudMapZoom(value));
  const fitted = [...CLOUDMAP_ZOOM_LEVELS].reverse().find(level => level <= limit)
    ?? MIN_CLOUDMAP_ZOOM;
  return Math.max(clampCloudMapZoom(minZoom), fitted);
}
