'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { durableCopy, durableWrite } = require('./durable-files.cjs');

const fsp = fs.promises;
const IMAGE_EXTENSIONS = new Set([
  '.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp',
]);
const MIME_EXTENSIONS = new Map([
  ['image/avif', '.avif'],
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/svg+xml', '.svg'],
  ['image/webp', '.webp'],
]);

function imageExtension(file, fallback) {
  const original = path.extname(String(file?.originalname || '')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(original)) return original === '.jpeg' ? '.jpg' : original;
  return MIME_EXTENSIONS.get(String(file?.mimetype || '').toLowerCase()) || fallback;
}

function acceptsImage(file) {
  return MIME_EXTENSIONS.has(String(file?.mimetype || '').toLowerCase());
}

function createUploadStorage(multer, stagingRoot) {
  return multer.diskStorage({
    destination: (_req, _file, callback) => {
      try {
        fs.mkdirSync(stagingRoot, { recursive: true });
        callback(null, stagingRoot);
      } catch (error) {
        callback(error);
      }
    },
    filename: (_req, file, callback) => {
      callback(
        null,
        `.upload-${crypto.randomBytes(12).toString('hex')}${imageExtension(file, '.img')}`,
      );
    },
  });
}

function relativePath(...segments) {
  return segments.join('/');
}

class MediaPublicationService {
  constructor({ dataDir, stagingRoot, manager }) {
    this.dataDir = dataDir;
    this.stagingRoot = stagingRoot;
    this.manager = manager;
  }

  async #candidate() {
    await fsp.mkdir(this.stagingRoot, { recursive: true });
    return fsp.mkdtemp(path.join(this.stagingRoot, 'publish-'));
  }

  async publishReplacement({ stagedPath, relativeDir, baseName, extension }) {
    const candidateDir = await this.#candidate();
    try {
      const targetDir = path.join(this.dataDir, ...relativeDir.split('/'));
      const names = await fsp.readdir(targetDir).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const targetName = `${baseName}${extension}`;
      const targetPath = relativePath(relativeDir, targetName);
      const removePaths = names
        .filter(name => name !== targetName && name.startsWith(`${baseName}.`))
        .map(name => relativePath(relativeDir, name));

      await durableCopy(
        stagedPath,
        path.join(candidateDir, ...targetPath.split('/')),
      );
      await this.manager.commit({
        candidateDir,
        paths: [targetPath],
        removePaths,
      });
      return targetPath;
    } finally {
      await Promise.all([
        fsp.unlink(stagedPath).catch(() => {}),
        fsp.rm(candidateDir, { recursive: true, force: true }).catch(() => {}),
      ]);
    }
  }

  async publishBuffers({ relativeDir, files }) {
    const candidateDir = await this.#candidate();
    try {
      const paths = [];
      for (const file of files) {
        const targetPath = relativePath(relativeDir, file.name);
        await durableWrite(
          path.join(candidateDir, ...targetPath.split('/')),
          file.content,
        );
        paths.push(targetPath);
      }
      await this.manager.commit({ candidateDir, paths });
      return paths;
    } finally {
      await fsp.rm(candidateDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async removeFiles(paths) {
    if (!paths.length) return;
    await this.manager.commit({
      candidateDir: this.stagingRoot,
      paths: [],
      removePaths: paths,
    });
  }
}

module.exports = {
  MediaPublicationService,
  acceptsImage,
  createUploadStorage,
  imageExtension,
};
