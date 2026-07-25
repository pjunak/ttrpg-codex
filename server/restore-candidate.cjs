'use strict';

const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;

class RestoreCandidateError extends Error {
  constructor(code, relativePath, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RestoreCandidateError';
    this.code = code;
    this.relativePath = relativePath;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueMatchesShape(value, shape, canonical) {
  if (shape === 'array') return Array.isArray(value);
  if (shape === 'object') return isObject(value);
  if (shape === 'object-or-legacy-array') {
    return canonical ? isObject(value) : isObject(value) || Array.isArray(value);
  }
  return Array.isArray(value) || isObject(value);
}

async function readRegistry(candidateDir, paths) {
  if (!paths.includes('addons.json')) return null;
  try {
    return JSON.parse(await fsp.readFile(path.join(candidateDir, 'addons.json'), 'utf8'));
  } catch {
    return null;
  }
}

function declaredAddonShape(registry, relativePath) {
  const match = /^addon-data\/([a-z0-9][a-z0-9-]{1,38})\/([a-z0-9][a-z0-9_]{0,39})\.json$/.exec(relativePath);
  if (!match || !isObject(registry) || !Array.isArray(registry.addons)) return null;
  const addon = registry.addons.find(entry => isObject(entry) && entry.id === match[1]);
  const declaration = Array.isArray(addon?.collections)
    ? addon.collections.find(entry => isObject(entry) && entry.name === match[2])
    : null;
  return declaration ? (declaration.keyed ? 'object' : 'array') : null;
}

function shapeForPath(relativePath, coreShapes, registry) {
  if (relativePath === 'addons.json') return 'object';
  const rootMatch = /^([a-z0-9][a-z0-9_-]{0,79})\.json$/i.exec(relativePath);
  if (rootMatch && coreShapes[rootMatch[1]]) return coreShapes[rootMatch[1]];
  return declaredAddonShape(registry, relativePath);
}

async function validateRestoreCandidate({
  candidateDir,
  paths,
  isAuthoritativePath,
  coreShapes,
  canonical = false,
}) {
  const authoritative = [...new Set(paths)].filter(isAuthoritativePath).sort();
  const registry = await readRegistry(candidateDir, authoritative);

  for (const relativePath of authoritative) {
    let value;
    try {
      value = JSON.parse(
        await fsp.readFile(path.join(candidateDir, ...relativePath.split('/')), 'utf8'),
      );
    } catch (error) {
      throw new RestoreCandidateError(
        'RESTORE_JSON_INVALID',
        relativePath,
        `Invalid campaign JSON: ${relativePath}`,
        error,
      );
    }
    const shape = shapeForPath(relativePath, coreShapes, registry);
    if (!valueMatchesShape(value, shape, canonical)) {
      throw new RestoreCandidateError(
        'RESTORE_SHAPE_INVALID',
        relativePath,
        `Invalid campaign data shape: ${relativePath}`,
      );
    }
  }
}

async function prepareRestoreCandidate({
  candidateDir,
  paths,
  liveFiles,
  isAuthoritativePath,
  coreShapes,
  migrations,
}) {
  const publicationPaths = new Set(paths);

  for (const { key, abs } of liveFiles) {
    if (!isAuthoritativePath(key) || publicationPaths.has(key)) continue;
    const target = path.join(candidateDir, ...key.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(abs, target);
    publicationPaths.add(key);
  }

  await validateRestoreCandidate({
    candidateDir,
    paths: [...publicationPaths],
    isAuthoritativePath,
    coreShapes,
  });

  const migrationResults = [];
  const atomicWrite = async (file, content) => {
    const relativePath = path.relative(candidateDir, path.resolve(file)).replace(/\\/g, '/');
    if (!isAuthoritativePath(relativePath)) {
      throw new RestoreCandidateError(
        'RESTORE_MIGRATION_PATH_INVALID',
        relativePath,
        `Migration wrote outside campaign data: ${relativePath}`,
      );
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    publicationPaths.add(relativePath);
  };

  for (const migration of migrations) {
    const result = await migration.run(candidateDir, {
      atomicWrite,
      warn: () => {},
    });
    migrationResults.push({ id: migration.id, ...result });
  }

  const preparedPaths = [...publicationPaths].sort();
  await validateRestoreCandidate({
    candidateDir,
    paths: preparedPaths,
    isAuthoritativePath,
    coreShapes,
    canonical: true,
  });

  return {
    paths: preparedPaths,
    migrationResults,
  };
}

module.exports = {
  RestoreCandidateError,
  prepareRestoreCandidate,
  validateRestoreCandidate,
};
