import { testRange } from './addon-compat.js';

const satisfies = (version, range) => {
  const result = testRange(version, range);
  return result.valid && result.matches;
};

export const SERVICE_CONTRACT_RE = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

export function serviceBindingKey(consumerId, contract) {
  return `${consumerId}::${contract}`;
}

export function normalizeServiceDeclarations(raw) {
  const services = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const provides = [];
  const consumes = [];
  const provided = new Set();
  const consumed = new Set();

  for (const declaration of Array.isArray(services.provides) ? services.provides : []) {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) continue;
    const contract = typeof declaration.contract === 'string' ? declaration.contract : '';
    const version = typeof declaration.version === 'string' ? declaration.version : '';
    if (!SERVICE_CONTRACT_RE.test(contract) || provided.has(contract)) continue;
    if (!testRange(version, version).valid) continue;
    provided.add(contract);
    provides.push({ contract, version });
  }

  for (const declaration of Array.isArray(services.consumes) ? services.consumes : []) {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) continue;
    const contract = typeof declaration.contract === 'string' ? declaration.contract : '';
    const range = typeof declaration.range === 'string' ? declaration.range : '';
    const cardinality = declaration.cardinality === 'many' ? 'many' : 'one';
    if (!SERVICE_CONTRACT_RE.test(contract) || consumed.has(contract)) continue;
    if (!testRange('0.0.0', range).valid) continue;
    consumed.add(contract);
    consumes.push({ contract, range, cardinality, required: declaration.required === true });
  }

  return { provides, consumes };
}

export function normalizeServiceBindings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, providerId] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9-]{1,38}::[a-z][a-z0-9.-]{2,79}$/.test(key)) continue;
    if (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,38}$/.test(providerId)) continue;
    out[key] = providerId;
  }
  return out;
}

export function compatibleServiceProviders(list, contract, range, blockedIds = new Set()) {
  const candidates = [];
  for (const addon of list) {
    if (blockedIds.has(addon.id)) continue;
    for (const declaration of normalizeServiceDeclarations(addon.services).provides) {
      if (declaration.contract === contract && satisfies(declaration.version, range)) {
        candidates.push({ addon, declaration });
      }
    }
  }
  return candidates.sort((left, right) => left.addon.id.localeCompare(right.addon.id));
}

/** Resolve manifest-declared service consumers without source-order winners.
 * `blockedIds` excludes providers that cannot load for unrelated reasons.
 * The returned provider ids are sorted so cardinality-many is deterministic.
 */
export function resolveServiceBindings(list, configuredBindings = {}, blockedIds = new Set()) {
  const bindings = normalizeServiceBindings(configuredBindings);
  const resolved = new Map();
  const issues = [];
  const requiredBlocks = new Map();
  const hardEdges = [];
  const optionalEdges = [];

  for (const consumer of list) {
    if (blockedIds.has(consumer.id)) continue;
    for (const declaration of normalizeServiceDeclarations(consumer.services).consumes) {
      const key = serviceBindingKey(consumer.id, declaration.contract);
      const candidates = compatibleServiceProviders(
        list,
        declaration.contract,
        declaration.range,
        blockedIds,
      );
      let selected = [];
      let reason = '';

      if (declaration.cardinality === 'many') {
        selected = candidates;
        if (!selected.length) reason = 'no compatible provider is enabled';
      } else if (Object.prototype.hasOwnProperty.call(bindings, key)) {
        const wanted = bindings[key];
        const match = candidates.find(candidate => candidate.addon.id === wanted);
        if (match) selected = [match];
        else reason = `configured provider "${wanted}" is unavailable or incompatible`;
      } else if (candidates.length === 1) {
        selected = candidates;
      } else if (!candidates.length) {
        reason = 'no compatible provider is enabled';
      } else {
        reason = `multiple compatible providers are enabled (${candidates.map(candidate => candidate.addon.id).join(', ')}); choose one`;
      }

      resolved.set(key, selected.map(provider => provider.addon.id));
      const edges = declaration.required ? hardEdges : optionalEdges;
      for (const provider of selected) {
        if (provider.addon.id !== consumer.id) edges.push([provider.addon.id, consumer.id]);
      }
      if (reason) {
        const issue = {
          consumerId: consumer.id,
          contract: declaration.contract,
          cardinality: declaration.cardinality,
          required: declaration.required,
          candidates: candidates.map(candidate => ({
            addonId: candidate.addon.id,
            addonVersion: candidate.addon.version,
            contractVersion: candidate.declaration.version,
          })),
          reason,
        };
        issues.push(issue);
        if (declaration.required) requiredBlocks.set(consumer.id, `required service "${declaration.contract}": ${reason}`);
      }
    }
  }

  return { resolved, issues, requiredBlocks, hardEdges, optionalEdges };
}
