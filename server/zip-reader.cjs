'use strict';

const { Transform } = require('stream');
const yauzl = require('yauzl');

function openZip(source, options = {}) {
  const zipOptions = {
    lazyEntries: true,
    validateEntrySizes: options.validateEntrySizes === true,
  };
  return new Promise((resolve, reject) => {
    const callback = (error, zipfile) => {
      if (error) reject(error);
      else resolve(zipfile);
    };
    if (Buffer.isBuffer(source)) yauzl.fromBuffer(source, zipOptions, callback);
    else yauzl.open(source, zipOptions, callback);
  });
}

async function walkZipEntries(source, handlers = {}, options = {}) {
  const zipfile = await openZip(source, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch (_) {}
      reject(error);
    };

    zipfile.on('error', fail);
    zipfile.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipfile.on('entry', entry => {
      Promise.resolve()
        .then(() => handlers.onEntry?.(entry, zipfile))
        .then(() => {
          if (!settled) zipfile.readEntry();
        })
        .catch(fail);
    });

    Promise.resolve()
      .then(() => handlers.onOpen?.(zipfile))
      .then(() => {
        if (!settled) zipfile.readEntry();
      })
      .catch(fail);
  });
}

function openEntryStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function createByteLimiter({ maxBytes = Infinity, onChunk, errorFactory } = {}) {
  if (!(maxBytes > 0)) throw new TypeError('maxBytes must be positive');
  let bytesRead = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      bytesRead += chunk.length;
      try {
        if (bytesRead > maxBytes) {
          throw errorFactory?.(bytesRead) || new Error('stream exceeded the byte limit');
        }
        onChunk?.({ bytesRead, chunkBytes: chunk.length });
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    },
  });
  return {
    stream,
    get bytesRead() {
      return bytesRead;
    },
  };
}

module.exports = {
  createByteLimiter,
  openEntryStream,
  openZip,
  walkZipEntries,
};
