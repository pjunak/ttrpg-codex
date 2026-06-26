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
