export const PinTypes = (() => {
  const sizeMin = 14;
  const sizeMax = 64;
  const sizeDefault = 28;

  const defaults = Object.freeze([
    { id:'major_city',  icon:'🏙',  label:'Major city',  color:'#D4A017', size:38 },
    { id:'city',        icon:'🏛',  label:'City',        color:'#C0A060', size:32 },
    { id:'town',        icon:'🏘',  label:'Town',        color:'#A0B080', size:28 },
    { id:'village',     icon:'🏠',  label:'Village',     color:'#80A070', size:26 },
    { id:'fortress',    icon:'🏰',  label:'Fortress',    color:'#9090A0', size:36 },
    { id:'castle',      icon:'🏯',  label:'Castle',      color:'#9A9AA8', size:36 },
    { id:'tower',       icon:'🗼',  label:'Tower',       color:'#A8A098', size:26 },
    { id:'temple',      icon:'🛕',  label:'Temple',      color:'#C0A088', size:28 },
    { id:'shrine',      icon:'⛩',  label:'Shrine',      color:'#80A0B0', size:26 },
    { id:'tavern',      icon:'🍺',  label:'Tavern',      color:'#C89050', size:24 },
    { id:'market',      icon:'🏪',  label:'Market',      color:'#C8A050', size:24 },
    { id:'academy',     icon:'🎓',  label:'Academy',     color:'#A890C0', size:30 },
    { id:'port',        icon:'⚓',  label:'Port',        color:'#6090A0', size:30 },
    { id:'bridge',      icon:'🌉',  label:'Bridge',      color:'#909090', size:24 },
    { id:'camp',        icon:'⛺',  label:'Camp',        color:'#B88040', size:24 },
    { id:'dungeon',     icon:'⚠',   label:'Dungeon',     color:'#A06040', size:28 },
    { id:'cave',        icon:'🕳',  label:'Cave',        color:'#706050', size:24 },
    { id:'ruin',        icon:'🏚',  label:'Ruin',        color:'#888070', size:26 },
    { id:'graveyard',   icon:'🪦',  label:'Graveyard',   color:'#808080', size:24 },
    { id:'battlefield', icon:'⚔',   label:'Battlefield', color:'#A04040', size:28 },
    { id:'landmark',    icon:'🗿',  label:'Landmark',    color:'#80A0B0', size:26 },
    { id:'forest',      icon:'🌲',  label:'Forest',      color:'#4A7A4A', size:26 },
    { id:'mountain',    icon:'⛰',   label:'Mountain',    color:'#8A7A6A', size:30 },
    { id:'lake',        icon:'🏞',  label:'Lake',        color:'#5A90B0', size:28 },
    { id:'curiosity',   icon:'✨',  label:'Curiosity',   color:'#C8A040', size:24 },
    { id:'region',      icon:'🗺',  label:'Region',      color:'#708090', size:32 },
    { id:'enemy',       icon:'💀',  label:'Hostile',     color:'#B04040', size:28 },
    { id:'custom',      icon:'📌',  label:'Custom',      color:'#8A5CC8', size:26 },
  ].map(Object.freeze));

  const byId = Object.freeze(Object.fromEntries(
    defaults.map(definition => [
      definition.id,
      Object.freeze({
        icon: definition.icon,
        label: definition.label,
        color: definition.color,
        size: definition.size,
      }),
    ]),
  ));
  const bundledIconIds = Object.freeze(defaults.map(definition => definition.id));

  function seed() {
    return defaults.map(definition => ({ ...definition }));
  }

  function configured(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter(item => {
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  function resolve(items, id) {
    const live = configured(items).find(item => item.id === id);
    if (live) return live;
    const builtIn = defaults.find(item => item.id === id);
    if (builtIn) return builtIn;
    if (id) return { ...defaults.at(-1), id, label: id };
    return defaults.at(-1);
  }

  function choices(items, currentId) {
    const live = configured(items);
    const result = live.length ? [...live] : [defaults.at(-1)];
    if (currentId && !result.some(item => item.id === currentId)) {
      result.push(resolve([], currentId));
    }
    return result;
  }

  return Object.freeze({
    defaults,
    byId,
    bundledIconIds,
    sizeMin,
    sizeMax,
    sizeDefault,
    seed,
    resolve,
    choices,
  });
})();
