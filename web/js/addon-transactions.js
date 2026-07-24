const FORBIDDEN_IDS = new Set(['__proto__', 'prototype', 'constructor']);
export const TRANSACTION_LIMITS = Object.freeze({
  maxCollections: 16,
  maxOperations: 256,
  maxPayloadBytes: 2 * 1024 * 1024,
  maxRecordBytes: 256 * 1024,
  minTimeoutMs: 250,
  maxTimeoutMs: 10_000,
});

function clone(value) {
  return structuredClone(value);
}

function error(code, message) {
  const value = new Error(message);
  value.code = code;
  return value;
}

function recordId(item) {
  return item && typeof item.id === 'string' ? item.id : '';
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertSafeJson(value, label, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw error('TX_VALIDATION', `${label} contains a non-finite number`);
    return;
  }
  if (!value || typeof value !== 'object') throw error('TX_VALIDATION', `${label} contains a non-JSON value`);
  if (seen.has(value)) throw error('TX_VALIDATION', `${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeJson(entry, `${label}[${index}]`, seen));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw error('TX_VALIDATION', `${label} must use plain objects`);
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_IDS.has(key)) throw error('TX_VALIDATION', `${label} contains forbidden key "${key}"`);
      assertSafeJson(value[key], `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function makeContext(snapshot, revisions, descriptors, operations) {
  const writeKeys = new Set();
  const names = new Set(Object.keys(snapshot));

  function descriptor(name) {
    if (!names.has(name) || !descriptors.has(name)) {
      throw error('TX_NOT_FOUND', `Collection "${name}" is outside the transaction read set`);
    }
    return descriptors.get(name);
  }

  function write(name, op, id, value) {
    if (typeof id !== 'string' || !id || id.length > 200 || FORBIDDEN_IDS.has(id)) {
      throw error('TX_VALIDATION', 'Transaction record id is invalid');
    }
    const key = `${name}\0${id}`;
    if (writeKeys.has(key)) {
      throw error('TX_DUPLICATE_WRITE', `Record "${name}/${id}" is written more than once`);
    }
    writeKeys.add(key);
    operations.push(value === undefined
      ? { collection: name, op, id }
      : { collection: name, op, id, value: clone(value) });
  }

  function collection(name) {
    const meta = descriptor(name);
    const container = snapshot[name];
    return {
      list() {
        if (meta.keyed) {
          return Object.entries(container).map(([id, value]) => ({ id, ...clone(value) }));
        }
        return clone(container);
      },
      get(id) {
        if (meta.keyed) {
          return Object.prototype.hasOwnProperty.call(container, id)
            ? { id, ...clone(container[id]) }
            : null;
        }
        const value = container.find(item => item && item.id === id);
        return value ? clone(value) : null;
      },
      put(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw error('TX_VALIDATION', 'put(item) requires an object');
        }
        const id = recordId(item);
        if (!id) throw error('TX_VALIDATION', 'put(item) requires an explicit string id');
        assertSafeJson(item, 'transaction item');
        if (byteLength(item) > TRANSACTION_LIMITS.maxRecordBytes) {
          throw error('TX_LIMIT', `transaction item exceeds ${TRANSACTION_LIMITS.maxRecordBytes} bytes`);
        }
        if (meta.keyed) {
          const value = clone(item);
          delete value.id;
          write(name, 'put', id, value);
          container[id] = value;
        } else {
          const value = clone(item);
          write(name, 'put', id, value);
          const index = container.findIndex(entry => entry && entry.id === id);
          if (index >= 0) container[index] = value;
          else container.push(value);
        }
        return clone(item);
      },
      remove(id) {
        write(name, 'delete', id);
        if (meta.keyed) delete container[id];
        else {
          const index = container.findIndex(entry => entry && entry.id === id);
          if (index >= 0) container.splice(index, 1);
        }
      },
    };
  }

  return Object.freeze({
    collection,
    revision: name => {
      descriptor(name);
      return revisions[name];
    },
  });
}

export function createTransactionRunner({
  descriptors,
  transport,
  applyCollections = () => {},
}) {
  let active = false;

  return async function transaction(collections, callback, opts = {}) {
    if (active) throw error('TX_NESTED', 'Nested transactions are not supported');
    if (!Array.isArray(collections) || !collections.length) {
      throw error('TX_VALIDATION', 'transaction collections must be a non-empty array');
    }
    if (collections.length > TRANSACTION_LIMITS.maxCollections) {
      throw error('TX_LIMIT', `transactions support at most ${TRANSACTION_LIMITS.maxCollections} collections`);
    }
    if (opts.timeoutMs !== undefined
        && (!Number.isInteger(opts.timeoutMs)
          || opts.timeoutMs < TRANSACTION_LIMITS.minTimeoutMs
          || opts.timeoutMs > TRANSACTION_LIMITS.maxTimeoutMs)) {
      throw error(
        'TX_LIMIT',
        `timeoutMs must be an integer from ${TRANSACTION_LIMITS.minTimeoutMs} to ${TRANSACTION_LIMITS.maxTimeoutMs}`,
      );
    }
    if (typeof callback !== 'function') {
      throw error('TX_VALIDATION', 'transaction callback must be a function');
    }
    const unique = new Set();
    for (const name of collections) {
      if (typeof name !== 'string' || !descriptors.has(name)) {
        throw error('TX_NOT_FOUND', 'Transaction collection is unavailable');
      }
      if (unique.has(name)) throw error('TX_VALIDATION', `duplicate collection "${name}"`);
      unique.add(name);
    }

    active = true;
    let begun;
    try {
      begun = await transport.begin([...unique], opts);
      const snapshot = clone(begun.snapshot);
      const operations = [];
      const context = makeContext(snapshot, begun.revisions, descriptors, operations);
      let value;
      try {
        value = await callback(context);
      } catch (callbackError) {
        await transport.cancel(begun.transactionId).catch(() => {});
        throw callbackError;
      }
      if (!operations.length) {
        await transport.cancel(begun.transactionId).catch(() => {});
        return {
          ok: true,
          commitId: null,
          changed: [],
          collections: snapshot,
          revisions: begun.revisions,
          value,
        };
      }
      if (operations.length > TRANSACTION_LIMITS.maxOperations) {
        await transport.cancel(begun.transactionId).catch(() => {});
        throw error('TX_LIMIT', `transactions support at most ${TRANSACTION_LIMITS.maxOperations} operations`);
      }
      if (byteLength(operations) > TRANSACTION_LIMITS.maxPayloadBytes) {
        await transport.cancel(begun.transactionId).catch(() => {});
        throw error('TX_LIMIT', `transaction payload exceeds ${TRANSACTION_LIMITS.maxPayloadBytes} bytes`);
      }
      const result = await transport.commit(begun.transactionId, operations, begun.deadline);
      applyCollections(result.collections);
      return { ...result, value };
    } finally {
      active = false;
    }
  };
}
