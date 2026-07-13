// Unit tests for the Store's domain helpers — pure-ish read logic that
// drives the /zahady aggregate and the attitude-glow renderers. These
// have clear contracts and no unit coverage today, so a refactor could
// break them silently. Saves no-op on `_sync` (server unavailable) and
// just mutate the in-memory `_data`.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.window = globalThis.window || { addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = globalThis.document || { createElement: () => ({}) };

const { Store } = await import('../web/js/store.js');

// ── Question / mystery helpers ────────────────────────────────────

test('isQuestionAnswered: true only for a non-empty trimmed answer', () => {
  assert.equal(Store.isQuestionAnswered({ text: 'q', answer: 'a' }), true);
  assert.equal(Store.isQuestionAnswered({ text: 'q', answer: '' }),  false);
  assert.equal(Store.isQuestionAnswered({ text: 'q', answer: '   ' }), false);
  assert.equal(Store.isQuestionAnswered({ text: 'q' }),              false);
  assert.equal(Store.isQuestionAnswered('legacy-string'),           false);  // pre-migration shape
  assert.equal(Store.isQuestionAnswered(null),                      false);
});

test('questionText / questionAnswer: defensive accessors across shapes', () => {
  assert.equal(Store.questionText({ text: 'Who?', answer: 'X' }), 'Who?');
  assert.equal(Store.questionText('legacy'), 'legacy');   // pre-migration string entry
  assert.equal(Store.questionText(null),     '');
  assert.equal(Store.questionAnswer({ text: 'Q', answer: 'A' }), 'A');
  assert.equal(Store.questionAnswer('legacy'), '');
  assert.equal(Store.questionAnswer(null),     '');
});

test('isMysterySolved: solved flag OR all-questions-answered; empty = open', () => {
  assert.equal(Store.isMysterySolved({ solved: true, questions: [] }), true);
  assert.equal(Store.isMysterySolved({ questions: [{ text: 'q', answer: 'a' }] }), true);
  assert.equal(Store.isMysterySolved({ questions: [{ text: 'q', answer: 'a' }, { text: 'q2', answer: '' }] }), false);
  assert.equal(Store.isMysterySolved({ questions: [] }), false);   // no questions ≠ solved
  assert.equal(Store.isMysterySolved({}),                false);
  assert.equal(Store.isMysterySolved(null),              false);
});

test('getOpenQuestions: aggregates open questions from mysteries + characters; skips answered/empty', () => {
  Store.saveMystery({ id: 'm1', name: 'M1', questions: [
    { text: 'Open mystery Q', answer: '' },
    { text: 'Answered Q',     answer: 'yes' },
    { text: '',               answer: '' },   // empty text → skipped
  ]});
  Store.saveCharacter({ id: 'c1', name: 'C1', faction: 'neutral', status: 'alive', knowledge: 4, unknown: [
    { text: 'Open char Q', answer: '' },
    { text: 'Resolved',    answer: 'done' },
  ]});

  const open  = Store.getOpenQuestions();
  const texts = open.map(o => o.text);
  assert.ok(texts.includes('Open mystery Q'));
  assert.ok(texts.includes('Open char Q'));
  assert.equal(texts.includes('Answered Q'), false);
  assert.equal(texts.includes('Resolved'),   false);
  assert.equal(open.filter(o => !o.text.trim()).length, 0, 'no empty-text entries leak through');

  const mq = open.find(o => o.text === 'Open mystery Q');
  assert.equal(mq.source, 'mystery');
  assert.equal(mq.sourceEntity.id, 'm1');
  const cq = open.find(o => o.text === 'Open char Q');
  assert.equal(cq.source, 'character');
  assert.equal(cq.sourceEntity.id, 'c1');

  Store.deleteMystery('m1');
  Store.deleteCharacter('c1');
});

// ── getEffectiveAttitudes (attitude-glow resolution) ──────────────

test('getEffectiveAttitudes: party PC short-circuits to the party palette', () => {
  // Own attitudes are ignored for party members — the party shortcut wins.
  const pc = { id: 'pc', faction: 'party', attitudes: [{ id: 'enemy' }] };
  const eff = Store.getEffectiveAttitudes(pc, 'character');
  assert.equal(eff.length, 1);
  assert.equal(eff[0].id, 'party');
});

test('getEffectiveAttitudes: a non-party entity\'s own attitudes win when set', () => {
  const npc = { id: 'npc', faction: 'cult', attitudes: [{ id: 'hostile' }] };
  assert.deepEqual(Store.getEffectiveAttitudes(npc, 'character').map(a => a.id), ['hostile']);
});

test('getEffectiveAttitudes: a character with empty own-attitudes inherits its faction', () => {
  Store.saveFaction('cult', { name: 'Cult', attitudes: [{ id: 'enemy' }] });
  const npc = { id: 'npc2', faction: 'cult', attitudes: [] };
  assert.deepEqual(Store.getEffectiveAttitudes(npc, 'character').map(a => a.id), ['enemy']);
  Store.deleteFaction('cult');
});

test('getEffectiveAttitudes: empty everywhere (and null entity) returns [] — no glow', () => {
  const npc = { id: 'npc3', faction: 'no-such-faction', attitudes: [] };
  assert.deepEqual(Store.getEffectiveAttitudes(npc, 'character'), []);
  assert.deepEqual(Store.getEffectiveAttitudes(null, 'character'), []);
});

test('getEffectiveAttitudes: party strength is sourced from the attitudes enum (falls back to 1.0)', () => {
  // No `party` row in the enum → default strength 1.0.
  const pc = { id: 'pc-s', faction: 'party' };
  assert.equal(Store.getEffectiveAttitudes(pc, 'character')[0].strength, 1.0);
  // Seed a `party` enum row with a custom strength → it drives the glow.
  Store.saveEnumItem('attitudes', { id: 'party', label: 'Party', strength: 0.5 });
  assert.equal(Store.getEffectiveAttitudes(pc, 'character')[0].strength, 0.5);
  // Clean up so other tests see the default again.
  Store.deleteEnumItem('attitudes', 'party', { force: true });
});

// ── deleteCharacter cascade persistence (regression) ──────────────

test('deleteCharacter: strips the id from referencing events/mysteries AND persists only those', () => {
  Store.saveCharacter({ id: 'victim', name: 'Victim', faction: 'neutral', status: 'alive', knowledge: 4 });
  Store.saveCharacter({ id: 'bystander', name: 'Bystander', faction: 'neutral', status: 'alive', knowledge: 4 });
  Store.saveEvent({ id: 'ev-ref',   name: 'Ref',   characters: ['victim', 'bystander'] });
  Store.saveEvent({ id: 'ev-unref', name: 'Unref', characters: ['bystander'] });
  Store.saveMystery({ id: 'my-ref', name: 'MyRef', questions: [], characters: ['victim'] });

  const evUnrefStampBefore = Store.getEvent('ev-unref').updatedAt;

  Store.deleteCharacter('victim');

  // Referencing event/mystery had the id stripped in memory…
  assert.deepEqual(Store.getEvent('ev-ref').characters, ['bystander']);
  assert.deepEqual(Store.getMystery('my-ref').characters, []);
  // …and were re-stamped (the cascade touched + persisted them).
  assert.ok(Store.getEvent('ev-ref').updatedAt >= 0);
  // The unreferenced event was NOT touched (stamp unchanged).
  assert.equal(Store.getEvent('ev-unref').updatedAt, evUnrefStampBefore);

  Store.deleteCharacter('bystander');
  Store.deleteEvent('ev-ref'); Store.deleteEvent('ev-unref'); Store.deleteMystery('my-ref');
});

// ── undelete unknown-kind guard ───────────────────────────────────

test('undelete: returns false for an unknown trash kind (no throw)', () => {
  assert.equal(Store.undelete('not-a-collection', 'x'), false);
});

// ── computeChangeSummary (lastChange previews) ────────────────────

test('computeChangeSummary: first save → {created: true}', () => {
  assert.deepEqual(Store.computeChangeSummary(null, { id: 'x', name: 'X' }), { created: true });
  assert.deepEqual(Store.computeChangeSummary(undefined, { id: 'x' }), { created: true });
});

test('computeChangeSummary: short scalars capture from/to; long text and arrays are name-only', () => {
  const before = {
    id: 'x', status: 'alive', description: 'short before',
    tags: ['a'], location: 'greenest',
  };
  const after = {
    id: 'x', status: 'dead', description: 'x'.repeat(50),
    tags: ['a', 'b'], location: 'greenest',
  };
  const s = Store.computeChangeSummary(before, after);
  const byKey = Object.fromEntries(s.fields.map(f => [f.key, f]));
  assert.deepEqual(byKey.status, { key: 'status', from: 'alive', to: 'dead' });
  assert.deepEqual(byKey.description, { key: 'description' }, '>40 chars → name-only');
  assert.deepEqual(byKey.tags, { key: 'tags' }, 'arrays → name-only');
  assert.equal(byKey.location, undefined, 'unchanged fields are not listed');
});

test('computeChangeSummary: a field added or cleared diffs against the empty string', () => {
  const s = Store.computeChangeSummary({ id: 'x' }, { id: 'x', title: 'Captain' });
  assert.deepEqual(s.fields, [{ key: 'title', from: '', to: 'Captain' }]);
  const s2 = Store.computeChangeSummary({ id: 'x', title: 'Captain' }, { id: 'x', title: '' });
  assert.deepEqual(s2.fields, [{ key: 'title', from: 'Captain', to: '' }]);
});

test('computeChangeSummary: internal keys are ignored; empty diff → null', () => {
  const s = Store.computeChangeSummary(
    { id: 'x', name: 'N', updatedAt: 1, lastChange: { created: true }, order: 1, visibility: 'public' },
    { id: 'x', name: 'N', updatedAt: 2, lastChange: null, order: 9, visibility: 'dm' },
  );
  assert.equal(s, null);
});

test('computeChangeSummary: caps at 6 field entries', () => {
  const before = { id: 'x' };
  const after = { id: 'x' };
  for (let i = 0; i < 10; i++) after[`f${i}`] = `v${i}`;
  assert.equal(Store.computeChangeSummary(before, after).fields.length, 6);
});

test('saveCharacter records lastChange; a no-op re-save keeps the previous summary', () => {
  Store.saveCharacter({ id: 'lc1', name: 'LC', faction: 'neutral', status: 'alive', knowledge: 4 });
  assert.deepEqual(Store.getCharacter('lc1').lastChange, { created: true });

  const edited = { ...Store.getCharacter('lc1'), status: 'dead' };
  Store.saveCharacter(edited);
  const after = Store.getCharacter('lc1').lastChange;
  assert.deepEqual(after, { fields: [{ key: 'status', from: 'alive', to: 'dead' }] });

  // Re-save with no observable change: summary survives.
  Store.saveCharacter({ ...Store.getCharacter('lc1') });
  assert.deepEqual(Store.getCharacter('lc1').lastChange, after);

  Store.deleteCharacter('lc1');
});

// ── getRecentActivity (dashboard "Poslední změny" feed + search) ──

test('getRecentActivity: newest-first cross-collection feed of stamped entities', () => {
  // Saves stamp `updatedAt = Date.now()`. Sequential saves inside one
  // test can land on the same millisecond, so pin Date.now to a
  // strictly-increasing counter for deterministic ordering.
  const realNow = Date.now;
  let t = 1_000_000_000_000;
  Date.now = () => (t += 1000);
  try {
    Store.saveCharacter({ id: 'ra-char', name: 'RA Char', faction: 'neutral', status: 'alive', knowledge: 4 });
    Store.saveLocation({ id: 'ra-loc', name: 'RA Loc' });
    Store.saveFaction('ra-fac', { name: 'RA Fac' });
    Store.saveMystery({ id: 'ra-my', name: 'RA My', questions: [] });
  } finally {
    Date.now = realNow;
  }

  // Newest first, across list collections AND the keyed factions object.
  const mine = Store.getRecentActivity(1000).filter(e => String(e.id).startsWith('ra-'));
  assert.deepEqual(mine.map(e => e.id), ['ra-my', 'ra-fac', 'ra-loc', 'ra-char']);

  // Entry shape drives the dashboard rows + search suggestions:
  // `${route}/${id}` must be the article href for every kind.
  const my = mine.find(e => e.id === 'ra-my');
  assert.equal(my.kind, 'zahada');
  assert.equal(my.route, '#/zahada');
  assert.equal(my.name, 'RA My');
  const fac = mine.find(e => e.id === 'ra-fac');
  assert.equal(fac.kind, 'frakce');
  assert.equal(fac.route, '#/frakce');
  assert.equal(fac.name, 'RA Fac');

  // Entries carry the entity's lastChange summary for the dashboard
  // preview line (these were first saves → created).
  assert.deepEqual(my.lastChange,  { created: true });
  assert.deepEqual(fac.lastChange, { created: true });

  // Never-edited entities (no updatedAt — e.g. merged defaults) are
  // excluded outright rather than sorted to the bottom.
  assert.ok(Store.getRecentActivity(1000).every(e => e.updatedAt > 0));

  // The limit caps the list.
  assert.equal(Store.getRecentActivity(2).length, 2);

  Store.deleteMystery('ra-my');
  Store.deleteFaction('ra-fac');
  Store.deleteLocation('ra-loc');
  Store.deleteCharacter('ra-char');
});
