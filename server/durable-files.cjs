'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

async function fsyncDirectory(dir) {
  let handle;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32'
        || !['EISDIR', 'EINVAL', 'EPERM', 'EACCES'].includes(error.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function renameWithRetry(source, target) {
  const delays = [10, 50, 200];
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt === delays.length) break;
      await new Promise(resolve => { setTimeout(resolve, delays[attempt]); });
    }
  }
  throw lastError;
}

async function durableWrite(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsp.open(tmp, 'wx');
    await handle.writeFile(content, typeof content === 'string' ? 'utf8' : undefined);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(tmp, filePath);
    await fsyncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
  }
}

async function durableCopy(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.publish`;
  let handle;
  try {
    await fsp.copyFile(source, tmp, fs.constants.COPYFILE_EXCL);
    handle = await fsp.open(tmp, 'r+');
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(tmp, target);
    await fsyncDirectory(path.dirname(target));
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
  }
}

async function durableUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = {
  durableCopy,
  durableUnlink,
  durableWrite,
  fsyncDirectory,
  renameWithRetry,
};
