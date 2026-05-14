const { test } = require('node:test');
const assert    = require('node:assert/strict');

const {
  filterForRole,
  stripSecretsFromEntity,
  stripMarkdownMarkers,
  MARKDOWN_FIELDS,
  VISIBILITY_BEARING,
} = require('../server/visibility.cjs');

// ── stripMarkdownMarkers ──────────────────────────────────────────

test('stripMarkdownMarkers: pass-through for DM role', () => {
  const src = 'Public prose. [secret]Spoiler.[/secret] More public.';
  assert.equal(stripMarkdownMarkers(src, 'dm'), src);
});

test('stripMarkdownMarkers: strips [secret]…[/secret] for player', () => {
  const src = 'Public prose. [secret]Spoiler.[/secret] More public.';
  const out = stripMarkdownMarkers(src, 'player');
  assert.equal(out.includes('Spoiler'),   false);
  assert.equal(out.includes('[secret]'),  false);
  assert.equal(out.includes('[/secret]'), false);
  assert.equal(out, 'Public prose.  More public.');
});

test('stripMarkdownMarkers: idempotent — running twice equals once', () => {
  const src = 'A [secret]hidden[/secret] B [secret]two[/secret] C';
  const once  = stripMarkdownMarkers(src, 'player');
  const twice = stripMarkdownMarkers(once, 'player');
  assert.equal(once, twice);
});

test('stripMarkdownMarkers: unmatched markers stay literal', () => {
  const src = 'Lone [secret] open marker without close.';
  const out = stripMarkdownMarkers(src, 'player');
  assert.equal(out, src, 'unmatched open should pass through literally');
});

test('stripMarkdownMarkers: nested [public] inside [secret] punches a hole', () => {
  const src = 'A [secret]hidden [public]visible[/public] hidden[/secret] B';
  const out = stripMarkdownMarkers(src, 'player');
  // The outer secret hides "hidden" tokens; the inner public island stays.
  assert.equal(out.includes('visible'), true);
  assert.equal(out.includes('hidden'),  false);
});

test('stripMarkdownMarkers: handles non-string input safely', () => {
  assert.equal(stripMarkdownMarkers(null,      'player'), null);
  assert.equal(stripMarkdownMarkers(undefined, 'player'), undefined);
  assert.equal(stripMarkdownMarkers(42,        'player'), 42);
});

test('stripMarkdownMarkers: empty marker pair drops to empty', () => {
  assert.equal(stripMarkdownMarkers('[secret][/secret]', 'player'), '');
});

// ── stripSecretsFromEntity ────────────────────────────────────────

test('stripSecretsFromEntity: DM gets the entity unchanged', () => {
  const e = { id: 'x', description: 'A [secret]hidden[/secret] B', secrets: { notes: true }, notes: 'GM-only' };
  const out = stripSecretsFromEntity(e, 'characters', 'dm');
  assert.equal(out, e); // identity reference
});

test('stripSecretsFromEntity: drops fields listed `true` in secrets for non-DM', () => {
  const e = { id: 'x', name: 'Visible', notes: 'GM-only', secrets: { notes: true } };
  const out = stripSecretsFromEntity(e, 'locations', 'player');
  assert.equal(out.name, 'Visible');
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'notes'), false);
});

test('stripSecretsFromEntity: secrets does not affect id/visibility/secrets itself', () => {
  // Even if the user tries to flag id/visibility as a secret (mis-input
  // or an attack), we never drop those — id is the join key, visibility
  // is the entity-level filter signal.
  const e = { id: 'x', visibility: 'public', secrets: { id: true, visibility: true } };
  const out = stripSecretsFromEntity(e, 'characters', 'player');
  assert.equal(out.id, 'x');
  assert.equal(out.visibility, 'public');
});

test('stripSecretsFromEntity: applies marker strip to known markdown fields', () => {
  const e = {
    id: 'x',
    description: 'Foo [secret]hidden[/secret] bar',
    secrets: {},
  };
  const out = stripSecretsFromEntity(e, 'characters', 'player');
  assert.equal(out.description.includes('hidden'),    false);
  assert.equal(out.description.includes('[secret]'),  false);
});

test('stripSecretsFromEntity: does NOT touch non-markdown fields', () => {
  // `name` isn't a markdown field. A literal `[secret]` in a name (e.g.
  // someone typed it as a label) should survive — the generic scan
  // would mangle it but our allow-list shouldn't.
  const e = { id: 'x', name: 'Project [secret]', description: '', secrets: {} };
  const out = stripSecretsFromEntity(e, 'characters', 'player');
  assert.equal(out.name, 'Project [secret]');
});

// ── filterForRole ─────────────────────────────────────────────────

test('filterForRole: DM filter is identity', () => {
  const arr = [{ id: 'a', visibility: 'dm' }, { id: 'b', visibility: 'public' }];
  assert.equal(filterForRole('characters', arr, 'dm'), arr);
});

test('filterForRole: drops DM-only entities from list-shape', () => {
  const arr = [
    { id: 'a', visibility: 'dm',     description: 'a' },
    { id: 'b', visibility: 'public', description: 'b' },
    { id: 'c',                       description: 'c' }, // missing visibility = public
  ];
  const out = filterForRole('characters', arr, 'player');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(x => x.id).sort(), ['b', 'c']);
});

test('filterForRole: drops DM-only entities from keyed-object shape (factions)', () => {
  const obj = {
    cult:    { name: 'Kult',    visibility: 'dm' },
    council: { name: 'Council', visibility: 'public' },
  };
  const out = filterForRole('factions', obj, 'player');
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out.council.name, 'Council');
  assert.equal(out.cult, undefined);
});

test('filterForRole: strips secret fields from each surviving entity', () => {
  const arr = [
    { id: 'a', visibility: 'public', description: 'public', notes: 'GM',  secrets: { notes: true } },
  ];
  const out = filterForRole('locations', arr, 'player');
  assert.equal(out[0].description, 'public');
  assert.equal(Object.prototype.hasOwnProperty.call(out[0], 'notes'), false);
});

test('filterForRole: strips markers from every known markdown field', () => {
  // Hits every collection × markdown field listed in MARKDOWN_FIELDS.
  // If a new field gets added there but the strip path forgets it, this
  // test catches the leak.
  for (const [collection, fields] of Object.entries(MARKDOWN_FIELDS)) {
    for (const field of fields) {
      const entity = { id: 'x', visibility: 'public', secrets: {} };
      entity[field] = 'visible [secret]hidden[/secret] visible';
      const container = collection === 'factions' ? { x: entity } : [entity];
      const out = filterForRole(collection, container, 'player');
      const result = Array.isArray(out) ? out[0] : out.x;
      assert.equal(result[field].includes('hidden'),   false, `${collection}.${field} should strip`);
      assert.equal(result[field].includes('[secret]'), false, `${collection}.${field} should strip marker`);
    }
  }
});

test('filterForRole: non-visibility-bearing collections pass through unchanged', () => {
  // `settings` and `campaign` are explicitly excluded — they're
  // inherently shared data and shouldn't get filtered.
  assert.equal(VISIBILITY_BEARING.has('settings'),        false);
  assert.equal(VISIBILITY_BEARING.has('deletedDefaults'), false);
  assert.equal(VISIBILITY_BEARING.has('campaign'),        false);
  const settings = { foo: [1, 2, 3] };
  assert.equal(filterForRole('settings', settings, 'player'), settings);
});

test('filterForRole: list with no entities returns empty list', () => {
  const out = filterForRole('characters', [], 'player');
  assert.deepEqual(out, []);
});

test('filterForRole: does not mutate the input container', () => {
  // The filter clones each touched entity; the source must be unchanged.
  const original = [
    { id: 'a', visibility: 'public', description: 'hello [secret]secret[/secret]', secrets: {} },
  ];
  const snapshot = JSON.parse(JSON.stringify(original));
  filterForRole('characters', original, 'player');
  assert.deepEqual(original, snapshot, 'source container should be unchanged');
});

// ── Schema completeness ───────────────────────────────────────────

test('MARKDOWN_FIELDS: every visibility-bearing collection except relationships has an entry', () => {
  // Relationships participate in entity-level visibility (a DM-only
  // relationship is hidden) but have no markdown body fields, so they
  // legitimately don't appear in MARKDOWN_FIELDS. Every other
  // visibility-bearing collection MUST be listed — a new collection
  // without an entry would silently miss marker stripping.
  for (const collection of VISIBILITY_BEARING) {
    if (collection === 'relationships') continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(MARKDOWN_FIELDS, collection),
      `${collection} must have a MARKDOWN_FIELDS entry`
    );
  }
});
