'use strict';

const HOST_VERSION = '1.0.0';
const SUPPORTED_API_VERSIONS = new Set([1, 2]);
const KNOWN_CAPABILITIES = new Set(['collections.dm']);
const HOST_CAPABILITIES = new Set();
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value) {
  const match = typeof value === 'string' ? VERSION_RE.exec(value) : null;
  return match ? match.slice(1).map(Number) : null;
}

function compare(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function testRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed || typeof range !== 'string') return { valid: false, matches: false };
  const source = range.trim();
  if (source === '*') return { valid: true, matches: true };
  let match;
  if ((match = /^(>=|>|<=|<)\s*((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(source))) {
    const result = compare(parsed, parseVersion(match[2]));
    return { valid: true, matches: ({ '>=': result >= 0, '>': result > 0, '<=': result <= 0, '<': result < 0 })[match[1]] };
  }
  if ((match = /^([\^~])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(source))) {
    const floor = parseVersion(match[2]);
    if (compare(parsed, floor) < 0) return { valid: true, matches: false };
    const upper = match[1] === '~'
      ? [floor[0], floor[1] + 1, 0]
      : floor[0] ? [floor[0] + 1, 0, 0] : floor[1] ? [0, floor[1] + 1, 0] : [0, 0, floor[2] + 1];
    return { valid: true, matches: compare(parsed, upper) < 0 };
  }
  if ((match = /^((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.[xX*]$/.exec(source))) {
    return { valid: true, matches: parsed[0] === Number(match[1]) && parsed[1] === Number(match[2]) };
  }
  if ((match = /^((?:0|[1-9]\d*))\.[xX*]$/.exec(source))) {
    return { valid: true, matches: parsed[0] === Number(match[1]) };
  }
  const exact = parseVersion(source);
  return exact ? { valid: true, matches: compare(parsed, exact) === 0 } : { valid: false, matches: false };
}

function capabilityErrors(apiVersion, declaration) {
  const errors = [];
  if (declaration === undefined) return errors;
  if (apiVersion !== 2) return ['capabilities requires apiVersion 2'];
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    return ['capabilities must be { required?: string[], optional?: string[] }'];
  }
  const keys = Object.keys(declaration);
  for (const key of keys) if (!['required', 'optional'].includes(key)) errors.push(`unknown capabilities field "${key}"`);
  const seen = new Set();
  for (const key of ['required', 'optional']) {
    const values = declaration[key];
    if (values === undefined) continue;
    if (!Array.isArray(values)) { errors.push(`capabilities.${key} must be an array`); continue; }
    for (const value of values) {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9.-]{1,63}$/.test(value)) {
        errors.push(`capabilities.${key} contains a malformed capability`);
      } else if (!KNOWN_CAPABILITIES.has(value)) {
        errors.push(`unknown capability "${value}"`);
      } else if (seen.has(value)) {
        errors.push(`duplicate capability "${value}"`);
      } else {
        seen.add(value);
      }
    }
  }
  for (const value of declaration.required || []) {
    if (KNOWN_CAPABILITIES.has(value) && !HOST_CAPABILITIES.has(value)) errors.push(`required capability "${value}" is unavailable`);
  }
  return errors;
}

function dependencyErrors(field, dependencies) {
  const errors = [];
  if (dependencies === undefined) return errors;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return [`${field} must be an object`];
  for (const [id, spec] of Object.entries(dependencies)) {
    if (!ID_RE.test(id)) errors.push(`${field} contains invalid addon id "${id}"`);
    const range = typeof spec === 'string' ? spec : spec && !Array.isArray(spec) && typeof spec === 'object' ? spec.range : null;
    if (typeof range !== 'string' || !testRange('0.0.0', range).valid) errors.push(`${field}.${id} has an unsupported or malformed version range`);
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const key of Object.keys(spec)) if (!['range', 'repo'].includes(key)) errors.push(`${field}.${id} has unknown field "${key}"`);
    }
  }
  return errors;
}

function compatibilityErrors(manifest) {
  const errors = [];
  if (!parseVersion(manifest.version)) errors.push('version must be semver (x.y.z)');
  if (!SUPPORTED_API_VERSIONS.has(manifest.apiVersion)) errors.push(`apiVersion ${manifest.apiVersion} is unsupported; host supports 1 and 2`);
  const hostRange = manifest.apiVersion === 1 && (manifest.hostVersion === undefined || manifest.hostVersion === '') ? '*' : manifest.hostVersion;
  if (typeof hostRange !== 'string' || !testRange(HOST_VERSION, hostRange).valid) {
    errors.push('hostVersion must use the supported version-range grammar');
  } else if (!testRange(HOST_VERSION, hostRange).matches) {
    errors.push(`host ${HOST_VERSION} does not satisfy hostVersion ${hostRange}`);
  }
  errors.push(...capabilityErrors(manifest.apiVersion, manifest.capabilities));
  errors.push(...dependencyErrors('dependencies', manifest.dependencies));
  errors.push(...dependencyErrors('optionalDependencies', manifest.optionalDependencies));
  return errors;
}

module.exports = {
  HOST_VERSION, SUPPORTED_API_VERSIONS, KNOWN_CAPABILITIES, HOST_CAPABILITIES,
  ID_RE, parseVersion, testRange, capabilityErrors, dependencyErrors, compatibilityErrors,
};
