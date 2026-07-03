// Tile pyramid generator.
//
// Given a source image, produce a Leaflet-compatible pyramid of 256×256
// JPEG tiles at multiple zoom levels under data/maps/tiles/<mapId>/<z>/<x>/<y>.jpg
// plus a tiles.json manifest the client reads to build L.tileLayer.
//
// Tile-DIRECTORY zoom convention: 0 = whole image fits in 256px, each
// +1 doubles the tile grid in each axis; the deepest level is native
// resolution (no upsampling past the source). The MANIFEST however
// speaks the client's Leaflet convention (CRS.Simple, zoom 0 = native
// image pixels): minZoom = -maxPyramidLevel, maxZoom = 2 (display
// over-zoom). The client maps between the two with zoomOffset.
//
// Re-runs are cheap: if the manifest's "srcHash" matches the source
// file's mtime+size, we skip. Delete the folder to force rebuild.

const fs    = require('fs');
const fsp   = fs.promises;
const path  = require('path');
const sharp = require('sharp');

// Mirror server.js's DATA_DIR resolution — a non-default CODEX_DATA_DIR
// deployment must write pyramids where the server serves them from
// (`/maps/tiles` is static-served out of DATA_DIR/maps/tiles). The old
// __dirname-anchored path silently built tiles the server never served.
const DATA_DIR  = process.env.CODEX_DATA_DIR || path.join(__dirname, 'data');
const MAPS_DIR  = path.join(DATA_DIR, 'maps');
const TILES_DIR = path.join(MAPS_DIR, 'tiles');
const TILE_SIZE = 256;

async function _srcFingerprint(srcPath) {
  const s = await fsp.stat(srcPath);
  return `${s.size}-${Math.floor(s.mtimeMs)}`;
}

function _maxZoomFor(w, h) {
  // Largest zoom where the source still has ≥ 1 pixel per tile pixel.
  // At zoom z the pyramid renders the image into (2^z * TILE_SIZE) px per side.
  const long = Math.max(w, h);
  let z = 0;
  while (TILE_SIZE * (1 << (z + 1)) <= long) z++;
  return z;
}

/**
 * Build (or rebuild) the Leaflet tile pyramid for a single map.
 *
 * Output layout:  `data/maps/tiles/<mapId>/{z}/{x}/{y}.jpg`
 *                 + `data/maps/tiles/<mapId>/tiles.json` manifest.
 *
 * Skips the build when `tiles.json` already exists and its `srcHash`
 * matches the current source-file fingerprint (size + mtime). Delete
 * the output folder to force a rebuild.
 *
 * @param {string} mapId - Logical map id (`world`, `local-<locId>`, …);
 *                         path-sanitised before use.
 * @param {string} srcPath - Absolute path to the source image.
 * @returns {Promise<object>} The written `tiles.json` manifest.
 */
async function buildFor(mapId, srcPath) {
  if (!srcPath) throw new Error('Source missing');
  try { await fsp.access(srcPath); }
  catch { throw new Error(`Source missing: ${srcPath}`); }
  const safeId = mapId.replace(/[^a-z0-9_\-\/]/gi, '_');
  const outDir = path.join(TILES_DIR, safeId);
  const manifestPath = path.join(outDir, 'tiles.json');

  const fp = await _srcFingerprint(srcPath);
  try {
    const existing = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (existing.srcHash === fp) return existing;   // already built
  } catch (_) { /* missing or corrupt manifest → rebuild */ }

  await fsp.mkdir(outDir, { recursive: true });

  const meta = await sharp(srcPath).metadata();
  const { width: w, height: h } = meta;
  if (!w || !h) throw new Error('Could not read image dimensions');

  const maxZ = _maxZoomFor(w, h);

  // The pyramid's logical canvas is a square of side `canvasLong`
  // (= TILE_SIZE × 2^maxZoom). Source images aren't square, so we
  // place the image top-left and pad the short side with the
  // background colour set in the `extend` call below. The padding
  // never reaches the client visually because Leaflet's `bounds` use
  // `imgW`/`imgH` from the manifest to clip the view to the original
  // pixels — pin coordinates (stored as fractions of the original
  // image) project onto the same rectangle, so the padded area is
  // outside the bounds entirely.
  const canvasLong = TILE_SIZE * (1 << maxZ);

  for (let z = 0; z <= maxZ; z++) {
    const tilesPerSide = 1 << z;                           // 2^z
    const scaledCanvas = TILE_SIZE * tilesPerSide;         // canvas side at this zoom
    const ratio        = scaledCanvas / canvasLong;         // < 1 for z < maxZ
    const scaledW      = Math.max(1, Math.round(w * ratio));
    const scaledH      = Math.max(1, Math.round(h * ratio));

    // Cols/rows actually covered by the image (rest of grid is empty padding)
    const cols = Math.ceil(scaledW / TILE_SIZE);
    const rows = Math.ceil(scaledH / TILE_SIZE);

    // One pipeline: read+decode source, resize, extend to tile-aligned
    // canvas, output as raw pixels. Previously this was three pipelines
    // per zoom level (decode→resize→encode→decode→extend→encode→decode
    // per tile→encode); the raw output skips two intermediate JPEG
    // encode/decode round-trips. Slicing into tiles below operates on
    // raw bytes so the only encode is the final per-tile JPEG.
    const { data: rawData, info: rawInfo } = await sharp(srcPath)
      .resize({ width: scaledW, height: scaledH, fit: 'fill' })
      .extend({
        top:    0,
        left:   0,
        // Pad the short side out to the tile-aligned canvas. Each axis pads
        // against its OWN tile count (rows→height, cols→width); the Math.max
        // floors at 0 so a perfectly tile-aligned image never requests a
        // negative extend (which sharp rejects).
        bottom: Math.max(0, rows * TILE_SIZE - scaledH),
        right:  Math.max(0, cols * TILE_SIZE - scaledW),
        background: { r: 20, g: 20, b: 20, alpha: 1 },
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let x = 0; x < cols; x++) {
      const zxDir = path.join(outDir, String(z), String(x));
      await fsp.mkdir(zxDir, { recursive: true });
      for (let y = 0; y < rows; y++) {
        const tile = await sharp(rawData, { raw: rawInfo })
          .extract({ left: x * TILE_SIZE, top: y * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE })
          .jpeg({ quality: 78, mozjpeg: true })
          .toBuffer();
        await fsp.writeFile(path.join(zxDir, `${y}.jpg`), tile);
      }
    }
  }

  const manifest = {
    mapId,
    srcHash:   fp,
    // Field names are the CLIENT contract (map.js _doInitTiled reads
    // width/height/tileSize/minZoom/maxZoom/ext) — the old imgW/imgH +
    // pyramid-indexed zoom range never matched what the client expected.
    width:     w,
    height:    h,
    tileSize:  TILE_SIZE,
    minZoom:   -maxZ,   // Leaflet zoom of pyramid level 0 (whole image in one tile)
    maxZoom:   2,       // display over-zoom past native resolution
    ext:       'jpg',
    canvasLong,
    builtAt:   Date.now(),
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = { buildFor };
