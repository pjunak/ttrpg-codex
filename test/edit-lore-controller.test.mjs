import { test } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.window = {
  addEventListener() {},
  dispatchEvent() {},
  location: { hash: '' },
};
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
globalThis.document = { createElement: () => ({}) };
globalThis.CustomEvent = globalThis.CustomEvent || class {
  constructor(type) { this.type = type; }
};

const { EditLoreController } = await import(
  '../web/js/edit-lore-controller.js?edit-lore-controller-tests'
);

function createFixture(values = {}) {
  const saved = {};
  const deleted = [];
  const undeleted = [];
  const toasts = [];
  const refreshes = [];
  const navigations = [];
  const prefills = {};
  let cleanCount = 0;
  const store = {
    generateId: name => `generated-${name.toLowerCase()}`,
    getBuh: () => ({ id: 'god-1', retained: 'deity' }),
    getArtifact: () => ({
      id: 'artifact-1',
      retained: 'artifact',
      state: 'legacy',
    }),
    getHistoricalEvent: () => ({ id: 'history-1', retained: 'history' }),
    saveBuh: value => { saved.deity = value; },
    saveArtifact: value => { saved.artifact = value; },
    saveHistoricalEvent: value => { saved.history = value; },
    deleteBuh: id => deleted.push(['pantheon', id]),
    deleteArtifact: id => deleted.push(['artifacts', id]),
    deleteHistoricalEvent: id => deleted.push(['historicalEvents', id]),
    undelete: (...args) => undeleted.push(args),
  };
  const documentRef = {
    getElementById(id) {
      if (!Object.prototype.hasOwnProperty.call(values, id)) return null;
      return { value: values[id] };
    },
  };
  const templates = {
    renderBuhEditor: value => ({ kind: 'deity', value }),
    renderArtifactEditor: value => ({ kind: 'artifact', value }),
    renderHistoricalEventEditor: value => ({ kind: 'history', value }),
  };
  const controller = EditLoreController.create({
    store,
    templates,
    i18n: { t: key => key },
    documentRef,
    consumePrefill: kind => {
      const value = prefills[kind] || null;
      prefills[kind] = null;
      return value;
    },
    setPrefill: (kind, value) => { prefills[kind] = value; },
    collectVisibility: uid => ({ visibility: `visibility-${uid}` }),
    checkValues: id => [`checked-${id}`],
    toast: (...args) => toasts.push(args),
    markClean: () => { cleanCount += 1; },
    refreshTo: hash => refreshes.push(hash),
    navigate: hash => navigations.push(hash),
  });
  return {
    controller,
    store,
    saved,
    deleted,
    undeleted,
    toasts,
    refreshes,
    navigations,
    prefills,
    get cleanCount() { return cleanCount; },
  };
}

test('lore controller owns one-shot prefills and creation navigation', () => {
  const fixture = createFixture();
  fixture.controller.startNewBuh({ domain: 'Knowledge' });
  assert.deepEqual(fixture.prefills.buh, { domain: 'Knowledge' });
  assert.equal(fixture.refreshes[0], '#/buh/new');
  assert.deepEqual(fixture.controller.renderBuhEditor(null), {
    kind: 'deity',
    value: { domain: 'Knowledge' },
  });
  assert.deepEqual(fixture.controller.renderBuhEditor(null), {
    kind: 'deity',
    value: null,
  });

  fixture.controller.startNewArtifact({ locationId: 'keep' });
  fixture.controller.startNewHistoricalEvent({ start: '1492' });
  assert.deepEqual(fixture.refreshes.slice(1), [
    '#/artefakt/new',
    '#/historicka-udalost/new',
  ]);
});

test('lore controller saves deity and artifact fields without reviving legacy state', () => {
  const fixture = createFixture({
    'gf-name-god-1': '  Oghma  ',
    'gf-symbol-god-1': ' Scroll ',
    'gf-domain-god-1': ' Knowledge ',
    'gf-alignment-god-1': ' N ',
    'gf-desc-god-1': ' Lore ',
    'af-name-artifact-1': '  Crown  ',
    'af-owner-artifact-1': ' hero ',
    'af-loc-artifact-1': ' vault ',
    'af-desc-artifact-1': ' Ancient ',
  });

  fixture.controller.saveBuh('god-1');
  fixture.controller.saveArtifact('artifact-1');

  assert.deepEqual(fixture.saved.deity, {
    id: 'god-1',
    retained: 'deity',
    name: 'Oghma',
    symbol: 'Scroll',
    domain: 'Knowledge',
    alignment: 'N',
    description: 'Lore',
    visibility: 'visibility-god-1',
  });
  assert.deepEqual(fixture.saved.artifact, {
    id: 'artifact-1',
    retained: 'artifact',
    name: 'Crown',
    ownerCharacterId: 'hero',
    locationId: 'vault',
    description: 'Ancient',
    visibility: 'visibility-artifact-1',
  });
  assert.equal(fixture.cleanCount, 2);
  assert.deepEqual(fixture.refreshes, [
    '#/buh/god-1',
    '#/artefakt/artifact-1',
  ]);
});

test('lore controller saves historical references and normalized tags', () => {
  const fixture = createFixture({
    'he-name-new_hist': 'Founding',
    'he-start-new_hist': '100',
    'he-end-new_hist': ' 110 ',
    'he-summary-new_hist': ' Summary ',
    'he-body-new_hist': ' Body ',
    'he-tags-new_hist': ' empire,  war ,,',
  });

  fixture.controller.saveHistoricalEvent();
  assert.deepEqual(fixture.saved.history, {
    visibility: 'visibility-new_hist',
    id: 'generated-founding',
    name: 'Founding',
    start: '100',
    end: '110',
    summary: 'Summary',
    body: 'Body',
    characters: ['checked-he-chars-new_hist'],
    locations: ['checked-he-locs-new_hist'],
    tags: ['empire', 'war'],
  });
  assert.equal(fixture.refreshes[0], '#/historicka-udalost/generated-founding');
});

test('lore controller rejects missing names and preserves undo behavior', () => {
  const fixture = createFixture({
    'gf-name-new_god': '   ',
    'af-name-new_art': '',
    'he-name-new_hist': ' ',
  });

  fixture.controller.saveBuh();
  fixture.controller.saveArtifact();
  fixture.controller.saveHistoricalEvent();
  assert.deepEqual(fixture.saved, {});
  assert.equal(fixture.toasts.every(args => args[1] === false), true);

  fixture.controller.deleteBuh('god-1');
  fixture.controller.deleteArtifact('artifact-1');
  fixture.controller.deleteHistoricalEvent('history-1');
  assert.deepEqual(fixture.deleted, [
    ['pantheon', 'god-1'],
    ['artifacts', 'artifact-1'],
    ['historicalEvents', 'history-1'],
  ]);
  assert.deepEqual(fixture.navigations, [
    '#/panteon',
    '#/artefakty',
    '#/historie',
  ]);

  for (const toast of fixture.toasts.slice(-3)) {
    toast[2].action.onClick();
  }
  assert.deepEqual(fixture.undeleted, [
    ['pantheon', 'god-1'],
    ['artifacts', 'artifact-1'],
    ['historicalEvents', 'history-1'],
  ]);
});
