export const HOST_VERSION = '1.0.0';
export const SUPPORTED_API_VERSIONS = new Set([1, 2]);
export const KNOWN_CAPABILITIES = new Set(['collections.dm', 'lifecycle.dispose', 'content.revision']);
export const HOST_CAPABILITIES = new Set(['lifecycle.dispose', 'content.revision']);

export function parseVersion(value) {
  const match = typeof value === 'string' ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value) : null;
  return match ? match.slice(1).map(Number) : null;
}
function compare(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
export function testRange(version, range) {
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
    const upper = match[1] === '~' ? [floor[0], floor[1] + 1, 0]
      : floor[0] ? [floor[0] + 1, 0, 0] : floor[1] ? [0, floor[1] + 1, 0] : [0, 0, floor[2] + 1];
    return { valid: true, matches: compare(parsed, upper) < 0 };
  }
  if ((match = /^((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.[xX*]$/.exec(source))) return { valid: true, matches: parsed[0] === +match[1] && parsed[1] === +match[2] };
  if ((match = /^((?:0|[1-9]\d*))\.[xX*]$/.exec(source))) return { valid: true, matches: parsed[0] === +match[1] };
  const exact = parseVersion(source);
  return exact ? { valid: true, matches: compare(parsed, exact) === 0 } : { valid: false, matches: false };
}

export function compatibilityErrors(manifest) {
  const errors = [];
  if (!parseVersion(manifest.version)) errors.push('version must be semver (x.y.z)');
  if (!SUPPORTED_API_VERSIONS.has(manifest.apiVersion)) errors.push(`apiVersion ${manifest.apiVersion} is unsupported; host supports 1 and 2`);
  const hostRange = manifest.apiVersion === 1 && (manifest.hostVersion === undefined || manifest.hostVersion === '') ? '*' : manifest.hostVersion;
  const hostCheck = testRange(HOST_VERSION, hostRange);
  if (!hostCheck.valid) errors.push('hostVersion must use the supported version-range grammar');
  else if (!hostCheck.matches) errors.push(`host ${HOST_VERSION} does not satisfy hostVersion ${hostRange}`);
  const caps = manifest.capabilities;
  if (caps !== undefined) {
    if (manifest.apiVersion !== 2) errors.push('capabilities requires apiVersion 2');
    else if (!caps || typeof caps !== 'object' || Array.isArray(caps)) errors.push('capabilities must be { required?: string[], optional?: string[] }');
    else {
      const seen = new Set();
      for (const key of Object.keys(caps)) if (!['required', 'optional'].includes(key)) errors.push(`unknown capabilities field "${key}"`);
      for (const key of ['required', 'optional']) {
        if (caps[key] === undefined) continue;
        if (!Array.isArray(caps[key])) { errors.push(`capabilities.${key} must be an array`); continue; }
        for (const value of caps[key]) {
          if (typeof value !== 'string' || !/^[a-z][a-z0-9.-]{1,63}$/.test(value)) errors.push(`capabilities.${key} contains a malformed capability`);
          else if (!KNOWN_CAPABILITIES.has(value)) errors.push(`unknown capability "${value}"`);
          else if (seen.has(value)) errors.push(`duplicate capability "${value}"`);
          else seen.add(value);
        }
      }
      for (const value of caps.required || []) if (KNOWN_CAPABILITIES.has(value) && !HOST_CAPABILITIES.has(value)) errors.push(`required capability "${value}" is unavailable`);
    }
  }
  for (const field of ['dependencies', 'optionalDependencies']) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      errors.push(`${field} must be an object`);
      continue;
    }
    for (const [id, spec] of Object.entries(dependencies)) {
      if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(id)) errors.push(`${field} contains invalid addon id "${id}"`);
      const range = typeof spec === 'string' ? spec : spec && !Array.isArray(spec) && typeof spec === 'object' ? spec.range : null;
      if (typeof range !== 'string' || !testRange('0.0.0', range).valid) errors.push(`${field}.${id} has an unsupported or malformed version range`);
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
        for (const key of Object.keys(spec)) if (!['range', 'repo'].includes(key)) errors.push(`${field}.${id} has unknown field "${key}"`);
      }
    }
  }
  return errors;
}
