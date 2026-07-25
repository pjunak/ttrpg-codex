// Tile pyramid generator.
//
// A build writes an immutable, content-addressed generation first and
// atomically switches tiles.json only after every tile is durable. Readers
// therefore see either the previous complete pyramid or the next complete
// pyramid, never a mixture of both.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const sharp = require('sharp');
const { durableWrite } = require('./server/durable-files.cjs');

const DATA_DIR = process.env.CODEX_DATA_DIR || path.join(__dirname, 'data');
const MAPS_DIR = path.join(DATA_DIR, 'maps');
const TILES_DIR = path.join(MAPS_DIR, 'tiles');
const TILE_SIZE = 256;
const GENERATIONS_TO_KEEP = 3;
const _buildEpochs = new Map();

function _safeMapId(mapId) {
  const safe = String(mapId || '')
    .replace(/[^a-z0-9_-]/gi, '_')
    .slice(0, 80);
  if (!safe) throw new Error('Invalid map id');
  return safe;
}

async function _hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function _maxZoomFor(width, height) {
  const longest = Math.max(width, height);
  let zoom = 0;
  while (TILE_SIZE * (2 ** (zoom + 1)) <= longest) zoom += 1;
  return zoom;
}

async function _readManifest(manifestPath) {
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

async function _buildGeneration(sourcePath, outDir, width, height, maxZoom) {
  const canvasLong = TILE_SIZE * (2 ** maxZoom);

  for (let zoom = 0; zoom <= maxZoom; zoom += 1) {
    const tilesPerSide = 2 ** zoom;
    const scaledCanvas = TILE_SIZE * tilesPerSide;
    const ratio = scaledCanvas / canvasLong;
    const scaledWidth = Math.max(1, Math.round(width * ratio));
    const scaledHeight = Math.max(1, Math.round(height * ratio));
    const columns = Math.ceil(scaledWidth / TILE_SIZE);
    const rows = Math.ceil(scaledHeight / TILE_SIZE);

    const { data: rawData, info: rawInfo } = await sharp(sourcePath)
      .resize({ width: scaledWidth, height: scaledHeight, fit: 'fill' })
      .extend({
        top: 0,
        left: 0,
        bottom: Math.max(0, rows * TILE_SIZE - scaledHeight),
        right: Math.max(0, columns * TILE_SIZE - scaledWidth),
        background: { r: 20, g: 20, b: 20, alpha: 1 },
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let column = 0; column < columns; column += 1) {
      const columnDir = path.join(outDir, String(zoom), String(column));
      await fsp.mkdir(columnDir, { recursive: true });
      for (let row = 0; row < rows; row += 1) {
        const tile = await sharp(rawData, { raw: rawInfo })
          .extract({
            left: column * TILE_SIZE,
            top: row * TILE_SIZE,
            width: TILE_SIZE,
            height: TILE_SIZE,
          })
          .jpeg({ quality: 78, mozjpeg: true })
          .toBuffer();
        await fsp.writeFile(path.join(columnDir, `${row}.jpg`), tile);
      }
    }
  }

  return canvasLong;
}

async function _pruneGenerations(mapDir, currentGeneration) {
  const entries = await fsp.readdir(mapDir, { withFileTypes: true }).catch(() => []);
  const generations = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^g-[0-9a-f]{16}$/.test(entry.name)) continue;
    const generationPath = path.join(mapDir, entry.name);
    const stat = await fsp.stat(generationPath).catch(() => null);
    if (stat) generations.push({ name: entry.name, path: generationPath, mtimeMs: stat.mtimeMs });
  }
  generations.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set([currentGeneration]);
  for (const generation of generations) {
    if (keep.size >= GENERATIONS_TO_KEEP) break;
    keep.add(generation.name);
  }
  await Promise.all(generations
    .filter(generation => !keep.has(generation.name))
    .map(generation => fsp.rm(generation.path, { recursive: true, force: true })));
}

async function cleanupStaging() {
  const entries = await fsp.readdir(TILES_DIR, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('.incoming-'))
    .map(entry => fsp.rm(path.join(TILES_DIR, entry.name), {
      recursive: true,
      force: true,
    })));
}

async function buildFor(mapId, srcPath) {
  if (!srcPath) throw new Error('Source missing');
  await fsp.access(srcPath).catch(() => {
    throw new Error(`Source missing: ${srcPath}`);
  });

  const safeId = _safeMapId(mapId);
  const epoch = (_buildEpochs.get(safeId) || 0) + 1;
  _buildEpochs.set(safeId, epoch);

  await fsp.mkdir(TILES_DIR, { recursive: true });
  const stageDir = await fsp.mkdtemp(path.join(TILES_DIR, `.incoming-${safeId}-`));
  const sourceSnapshot = path.join(stageDir, 'source');
  const stagedGeneration = path.join(stageDir, 'generation');
  const mapDir = path.join(TILES_DIR, safeId);
  const manifestPath = path.join(mapDir, 'tiles.json');

  try {
    await fsp.copyFile(srcPath, sourceSnapshot);
    const sourceHash = await _hashFile(sourceSnapshot);
    const generation = `g-${sourceHash.slice(0, 16)}`;
    const generationDir = path.join(mapDir, generation);
    const existing = await _readManifest(manifestPath);
    if (existing?.srcHash === sourceHash && existing.generation === generation) {
      const stat = await fsp.stat(generationDir).catch(() => null);
      if (stat?.isDirectory()) return existing;
    }

    const metadata = await sharp(sourceSnapshot).metadata();
    const { width, height } = metadata;
    if (!width || !height) throw new Error('Could not read image dimensions');
    const maxZoom = _maxZoomFor(width, height);

    let canvasLong;
    const generationExists = await fsp.stat(generationDir)
      .then(stat => stat.isDirectory(), () => false);
    if (generationExists) {
      canvasLong = TILE_SIZE * (2 ** maxZoom);
    } else {
      await fsp.mkdir(stagedGeneration, { recursive: true });
      canvasLong = await _buildGeneration(
        sourceSnapshot,
        stagedGeneration,
        width,
        height,
        maxZoom,
      );
    }

    const manifest = {
      mapId,
      srcHash: sourceHash,
      generation,
      width,
      height,
      tileSize: TILE_SIZE,
      minZoom: maxZoom === 0 ? 0 : -maxZoom,
      maxZoom: 2,
      ext: 'jpg',
      canvasLong,
      builtAt: Date.now(),
    };
    if (_buildEpochs.get(safeId) !== epoch) {
      return { ...manifest, superseded: true };
    }

    await fsp.mkdir(mapDir, { recursive: true });
    if (!generationExists) {
      try {
        await fsp.rename(stagedGeneration, generationDir);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    await durableWrite(manifestPath, JSON.stringify(manifest, null, 2));
    await _pruneGenerations(mapDir, generation).catch(error => {
      console.warn(`[tiles] generation prune failed for ${safeId}:`, error.message);
    });
    return manifest;
  } finally {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { buildFor, cleanupStaging };
