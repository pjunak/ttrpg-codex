// Unit tests for the client-side pets (Mazlíčci) collection: CRUD,
// owner resolution, ownerId normalization, undo, and the orphan-on-
// owner-delete cascade. `_sync` no-ops while `_serverAvailable` is
// false, so saves mutate the in-memory `_data` and read straight back.
// Each test creates + removes its own pets to stay isolated within the
// shared (per-file) Store singleton.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

globalThis.window = globalThis.window || { addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = globalThis.document || { createElement: () => ({}) };

const { Store } = await import('../web/js/store.js');

test('savePet + getPet + getPets: upsert and updatedAt stamp', () => {
  Store.savePet({ id: 'rex', name: 'Rex', icon: '🐺', ownerType: 'none', ownerId: '' });
  const p = Store.getPet('rex');
  assert.equal(p.name, 'Rex');
  assert.ok(p.updatedAt > 0, 'savePet stamps updatedAt');
  assert.ok(Store.getPets().some(x => x.id === 'rex'));
  Store.savePet({ ...p, name: 'Rex II' });
  assert.equal(Store.getPet('rex').name, 'Rex II', 'upsert by id');
  Store.deletePet('rex');
  assert.equal(Store.getPet('rex'), null);
});

test('savePet: normalizes ownerId to "" for none and party owners', () => {
  Store.savePet({ id: 'p1', name: 'P1', ownerType: 'none', ownerId: 'leftover' });
  Store.savePet({ id: 'p2', name: 'P2', ownerType: 'party', ownerId: 'leftover' });
  assert.equal(Store.getPet('p1').ownerId, '');
  assert.equal(Store.getPet('p2').ownerId, '');
  Store.deletePet('p1'); Store.deletePet('p2');
});

test('getPetsForOwner: filters by owner kind + id', () => {
  Store.savePet({ id: 'none1',  name: 'N', ownerType: 'none',      ownerId: '' });
  Store.savePet({ id: 'party1', name: 'Q', ownerType: 'party',     ownerId: '' });
  Store.savePet({ id: 'char1',  name: 'C', ownerType: 'character', ownerId: 'aragorn' });
  Store.savePet({ id: 'fac1',   name: 'F', ownerType: 'faction',   ownerId: 'cult' });

  assert.deepEqual(Store.getPetsForOwner('none').map(p => p.id),               ['none1']);
  assert.deepEqual(Store.getPetsForOwner('party').map(p => p.id),              ['party1']);
  assert.deepEqual(Store.getPetsForOwner('character', 'aragorn').map(p => p.id), ['char1']);
  assert.deepEqual(Store.getPetsForOwner('character', 'nobody'),               []);
  assert.deepEqual(Store.getPetsForOwner('faction', 'cult').map(p => p.id),    ['fac1']);

  for (const id of ['none1', 'party1', 'char1', 'fac1']) Store.deletePet(id);
});

test('getPetOwner: resolves none / party / character / faction descriptors', () => {
  assert.equal(Store.getPetOwner({ ownerType: 'none' }).href, null);

  const party = Store.getPetOwner({ ownerType: 'party' });
  assert.equal(party.href, '#/parta');
  assert.ok(party.label.length > 0, 'party owner has a label');

  Store.saveCharacter({ id: 'aragorn', name: 'Aragorn', faction: 'party', status: 'alive', knowledge: 4 });
  const co = Store.getPetOwner({ ownerType: 'character', ownerId: 'aragorn' });
  assert.equal(co.label, 'Aragorn');
  assert.equal(co.href, '#/postava/aragorn');

  Store.saveFaction('cult', { name: 'Cult', badge: '🐍' });
  const fo = Store.getPetOwner({ ownerType: 'faction', ownerId: 'cult' });
  assert.equal(fo.label, 'Cult');
  assert.equal(fo.href, '#/frakce/cult');

  // A deleted / unknown owner degrades to "no owner" (no dangling link).
  assert.equal(Store.getPetOwner({ ownerType: 'character', ownerId: 'ghost' }).href, null);

  Store.deleteCharacter('aragorn');
  Store.deleteFaction('cult');
});

test('deletePet + undelete("pets", id) restores the record', () => {
  Store.savePet({ id: 'tmp', name: 'Tmp', ownerType: 'none', ownerId: '' });
  Store.deletePet('tmp');
  assert.equal(Store.getPet('tmp'), null);
  assert.equal(Store.undelete('pets', 'tmp'), true);
  assert.equal(Store.getPet('tmp').name, 'Tmp');
  Store.deletePet('tmp');
});

test('owner deletion orphans the pet to ownerType "none" (character owner)', () => {
  Store.saveCharacter({ id: 'owner', name: 'Owner', faction: 'party', status: 'alive', knowledge: 4 });
  Store.savePet({ id: 'pet-of-owner', name: 'Buddy', ownerType: 'character', ownerId: 'owner' });
  Store.deleteCharacter('owner');
  const pet = Store.getPet('pet-of-owner');
  assert.ok(pet, 'pet survives its owner being deleted');
  assert.equal(pet.ownerType, 'none', 'reassigned to unassigned');
  assert.equal(pet.ownerId, '');
  Store.deletePet('pet-of-owner');
});

test('owner deletion orphans the pet to ownerType "none" (faction owner)', () => {
  Store.saveFaction('fac', { name: 'Fac', badge: '⚔' });
  Store.savePet({ id: 'fpet', name: 'Mascot', ownerType: 'faction', ownerId: 'fac' });
  Store.deleteFaction('fac');
  const pet = Store.getPet('fpet');
  assert.equal(pet.ownerType, 'none');
  assert.equal(pet.ownerId, '');
  Store.deletePet('fpet');
});
