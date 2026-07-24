export function resolveDependency(meta, depId, lookup) {
  const owns = (obj) => obj && Object.prototype.hasOwnProperty.call(obj, depId);
  if (!owns(meta.dependencies) && !owns(meta.optionalDependencies)) {
    throw new Error(`Add-on "${meta.id}" did not declare dependency "${depId}" (host.use).`);
  }
  const api = lookup(depId);
  if (api == null) throw new Error(`Dependency "${depId}" is not loaded (host.use).`);
  return api;
}

export function requireCollectionDeclaration(meta, name) {
  if (typeof name !== 'string' || !name) throw new Error('registerCollection: name required');
  const declaration = (Array.isArray(meta.collections) ? meta.collections : [])
    .find((entry) => entry && entry.name === name);
  if (!declaration) {
    throw new Error(`registerCollection: "${name}" is not declared in addon.json collections[]`);
  }
  return declaration;
}
