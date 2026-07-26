export function indexAddonUpdates(updates) {
  const indexed = {};
  for (const update of Array.isArray(updates) ? updates : []) {
    if (update && typeof update.id === 'string' && update.id) {
      indexed[update.id] = update;
    }
  }
  return indexed;
}

export function withoutAddonUpdate(updates, id) {
  const remaining = { ...updates };
  delete remaining[id];
  return remaining;
}
