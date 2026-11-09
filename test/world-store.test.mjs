import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorldStore, WorldStoreError } from '../dist/src/world-store.js';

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-world-state-'));
  let store = new WorldStore(directory, options);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, restart() { store.close(); store = new WorldStore(directory, options); return store; } };
}
const alice = { id: 1, accountId: 1, name: 'Alice' };
const bob = { id: 2, accountId: 2, name: 'Bob' };

test('new world seeds connected authored regions without modifying account data', t => {
  const f = fixture(t, { clock: () => 1000, startRegionName: 'Test Lobby' });
  const state = f.store.snapshot();
  assert.equal(state.format, 1); assert.equal(state.startRegionId, 1);
  assert.equal(Object.keys(state.regions).length, 3);
  assert.equal(state.regions[1].name, 'Test Lobby');
  assert.equal(state.regions[state.regions[1].exits.north].name, 'Garden');
  assert.equal(state.objects[state.regions[1].objectId].classNumber, 20);
  assert.equal(f.store.listObjects({ classNumber: 50 }).length, 1);
  assert.equal(fs.existsSync(path.join(f.directory, 'accounts.json')), false);
  state.regions[1].name = 'not committed';
  assert.equal(f.store.getRegion(1).name, 'Test Lobby');
});

test('avatar position, preferences, possessions and balances survive a restart', t => {
  const f = fixture(t, { clock: () => 1000 });
  const profile = f.store.ensureAvatar(alice, { classNumber: 21 });
  assert.equal(profile.balance, 1000); assert.equal(profile.ghost, false);
  const bag = f.store.createObject({ classNumber: 36, regionId: 1, ownerId: 1, capacity: 2, fields: { name: 'Bag' } });
  const document = f.store.createObject({ classNumber: 37, regionId: 1, ownerId: 1, containerId: bag.id, fields: { name: 'Note' } });
  f.store.writeDocument(document.id, { title: 'Hello', text: 'Saved note' }, { actorId: 1 });
  f.store.moveObject(bag.id, { regionId: 2, position: [20, 30, 0] }, { actorId: 1 });
  f.store.updatePreferences(1, { sound: false, balloonColor: 7 });
  f.restart();
  assert.equal(f.store.getAvatar(1).objectId, profile.objectId);
  assert.deepEqual(f.store.getObject(bag.id).fields.position, [20, 30, 0]);
  assert.equal(f.store.getObject(document.id).regionId, 2);
  assert.equal(f.store.getObject(document.id).containerId, bag.id);
  assert.equal(f.store.getDocument(document.id).text, 'Saved note');
  assert.equal(f.store.getAvatar(1).preferences.balloonColor, 7);
  assert.ok(fs.existsSync(path.join(f.directory, 'world.json.bak')));
});

test('new avatars use native image colors and start Outside The Rose without moving existing avatars', t => {
  const f = fixture(t);
  const existing = f.store.ensureAvatar(alice);
  assert.equal(existing.regionId, 1, 'worlds without the imported region retain their configured start');
  const rose = f.store.createRegion({ name: 'Outside The Rose' });
  const created = f.store.ensureAvatar(bob);
  assert.equal(created.regionId, rose.id);
  assert.deepEqual(f.store.getObject(created.objectId).fields.colorMap, Array(16).fill(0));
  assert.equal(f.store.ensureAvatar(alice).regionId, existing.regionId);
  assert.equal(f.store.snapshot().startRegionId, 1, 'recovery and existing portals retain their configured start');
  const explicit = f.store.ensureAvatar({ id: 3, accountId: 3, name: 'Chosen room' }, { regionId: 2, classNumber: 21 });
  assert.equal(explicit.regionId, 2);
  assert.deepEqual(f.store.getObject(explicit.objectId).fields.colorMap, Array(16).fill(0));
  f.restart();
  assert.equal(f.store.ensureAvatar(bob).regionId, rose.id);
});

test('new avatar arrival follows stable imported Rose identity and skips pending regions', t => {
  const f = fixture(t);
  const rose = f.store.createRegion({ name: 'Renamed Rose', properties: {
    surveyImport: { sourceSceneId: 'scene-45e1e82adac0f4bb54e3ebe2' },
  } });
  assert.equal(f.store.ensureAvatar(alice).regionId, rose.id);
  f.store.transaction(draft => { draft.regions[rose.id].properties.pendingDeletion = true; });
  assert.equal(f.store.ensureAvatar(bob).regionId, 1);
});

test('login repairs only legacy avatar and worn head placeholder colors and preserves customization', t => {
  const f = fixture(t), profile = f.store.ensureAvatar(alice, { classNumber: 21 });
  const head = f.store.createObject({ classNumber: 24, regionId: 1, containerId: profile.objectId, ownerId: alice.id,
    fields: { position: [1, 0, 0], colorMap: [...Array(16).keys()] } });
  const object = f.store.createObject({ classNumber: 27, regionId: 1, fields: { colorMap: [...Array(16).keys()] } });
  f.store.transaction(draft => { draft.objects[profile.objectId].fields.colorMap = [...Array(16).keys()]; });
  f.store.ensureAvatar(alice);
  assert.deepEqual(f.store.getObject(profile.objectId).fields.colorMap, Array(16).fill(0));
  assert.deepEqual(f.store.getObject(head.id).fields.colorMap, Array(16).fill(0));
  assert.deepEqual(f.store.getObject(object.id).fields.colorMap, [...Array(16).keys()], 'ordinary object palettes are untouched');
  const revision = f.store.snapshot().revision;
  f.store.ensureAvatar(alice);
  assert.equal(f.store.snapshot().revision, revision, 'repaired login is idempotent');
  const custom = [0, 55, 57, 59, 61, 78, 75, 73, 71, 69, 43, 41, 38, 36, 34, 39];
  f.store.transaction(draft => {
    draft.objects[profile.objectId].fields.colorMap = custom;
    draft.objects[head.id].fields.colorMap = custom;
  });
  f.restart(); f.store.ensureAvatar(alice);
  assert.deepEqual(f.store.getObject(profile.objectId).fields.colorMap, custom);
  assert.deepEqual(f.store.getObject(head.id).fields.colorMap, custom);
});

test('transactions reject invalid graphs, async/nested work and unauthorized mutation without commit', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.store.filename);
  const revision = f.store.snapshot().revision;
  assert.throws(() => f.store.transaction(draft => { delete draft.objects[1]; }), /Region root/);
  assert.throws(() => f.store.transaction(() => { throw new Error('business rejection'); }), /business rejection/);
  assert.throws(() => f.store.transaction(async () => 1), /synchronous/);
  assert.throws(() => f.store.transaction(() => f.store.transaction(() => 1)), /Nested/);
  assert.throws(() => f.store.transaction(draft => { draft.regions[1].name = 'Denied'; }, { authorize: () => false }), /not authorized/);
  assert.equal(f.store.snapshot().revision, revision);
  assert.deepEqual(fs.readFileSync(f.store.filename), before);
  let retained;
  f.store.transaction(draft => { retained = draft; draft.regions[1].properties.weather = 'sun'; });
  retained.regions[1].properties.weather = 'external mutation';
  assert.equal(f.store.getRegion(1).properties.weather, 'sun');
});

test('failed durable replacement rolls back both state and IDs and preserves account files', t => {
  const f = fixture(t);
  const accountsPath = path.join(f.directory, 'accounts.json');
  fs.writeFileSync(accountsPath, 'account sentinel\n');
  const previous = fs.readFileSync(f.store.filename), state = f.store.snapshot();
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.store.filename) { const error = new Error('injected disk failure'); error.code = 'EIO'; throw error; }
    return originalRename(source, destination);
  });
  assert.throws(() => f.store.createObject({ classNumber: 37, regionId: 1, fields: { name: 'Unsaved' } }), /injected disk failure/);
  assert.deepEqual(f.store.snapshot(), state);
  assert.deepEqual(fs.readFileSync(f.store.filename), previous);
  assert.equal(fs.readFileSync(accountsPath, 'utf8'), 'account sentinel\n');
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
  t.mock.restoreAll();
  assert.equal(f.store.createObject({ classNumber: 37, regionId: 1 }).id, state.next.object);
});

test('inventory ownership, locked containers, capacity and cycles are enforced', t => {
  const f = fixture(t); f.store.ensureAvatar(alice); f.store.ensureAvatar(bob);
  const bag = f.store.createObject({ classNumber: 36, regionId: 1, ownerId: 1, capacity: 1 });
  const child = f.store.createObject({ classNumber: 36, regionId: 1, ownerId: 1, containerId: bag.id, capacity: 1 });
  const extra = f.store.createObject({ classNumber: 37, regionId: 1, ownerId: 1 });
  assert.throws(() => f.store.moveObject(bag.id, { position: [1, 2, 0] }, { actorId: 2 }), /does not own/);
  assert.throws(() => f.store.moveObject(extra.id, { containerId: bag.id }, { actorId: 1 }), /capacity/);
  assert.throws(() => f.store.moveObject(bag.id, { containerId: child.id }, { actorId: 1 }), /cycle/);
  f.store.updateObject(bag.id, { locked: true }, { actorId: 1 });
  assert.throws(() => f.store.moveObject(extra.id, { containerId: bag.id }, { actorId: 1 }), /locked/);
  f.store.moveObject(bag.id, { regionId: 3 }, { actorId: 1 });
  assert.equal(f.store.getObject(child.id).regionId, 3);
  assert.throws(() => f.store.deleteObject(bag.id, { actorId: 1 }), /not empty/);
  const deleted = f.store.deleteObject(bag.id, { actorId: 1, recursive: true });
  assert.deepEqual(new Set(deleted), new Set([bag.id, child.id]));
  assert.equal(f.store.getObject(child.id), null);
});

test('balance transfers are integral, conserve supply and persist', t => {
  const f = fixture(t); f.store.ensureAvatar(alice); f.store.ensureAvatar(bob);
  const initial = f.store.getAvatar(1).balance + f.store.getAvatar(2).balance;
  const result = f.store.transferFunds(1, 2, 125);
  assert.equal(result.fromBalance, 875); assert.equal(result.toBalance, 1125);
  for (const amount of [0, -1, 0.5, Infinity, 999999]) assert.throws(() => f.store.transferFunds(1, 2, amount), WorldStoreError);
  f.restart();
  assert.equal(f.store.getAvatar(1).balance + f.store.getAvatar(2).balance, initial);
  assert.equal(f.store.snapshot().ledger.at(-1).amount, 125);
});

test('mail, ignore lists and documents enforce ownership and survive restart', t => {
  let now = 1000; const f = fixture(t, { clock: () => now });
  f.store.ensureAvatar(alice); f.store.ensureAvatar(bob);
  const letter = f.store.sendMail(1, 2, { subject: 'Hi', body: 'Private message' });
  assert.equal(f.store.listMail(2)[0].body, 'Private message');
  assert.throws(() => f.store.readMail(1, letter.id), /private/);
  now = 2000; assert.equal(f.store.readMail(2, letter.id).readAt, 2000);
  f.store.setRelationship(2, 1, 'ignored');
  assert.throws(() => f.store.sendMail(1, 2, { body: 'Not delivered' }), /ignoring/);
  f.store.setRelationship(1, 2, 'friends');
  const document = f.store.createObject({ classNumber: 37, regionId: 1, ownerId: 1 });
  assert.throws(() => f.store.writeDocument(document.id, { text: 'No' }, { actorId: 2 }), /does not own/);
  f.store.writeDocument(document.id, { title: 'Private', text: 'Mine' }, { actorId: 1 });
  f.restart();
  assert.equal(f.store.listMail(2)[0].readAt, 2000);
  assert.deepEqual(f.store.getAvatar(1).friends, [2]);
  assert.deepEqual(f.store.getAvatar(2).ignored, [1]);
  assert.equal(f.store.getDocument(document.id).text, 'Mine');
  f.store.deleteMail(2, letter.id); assert.deepEqual(f.store.listMail(2), []);
});

test('unsupported or corrupt world files are never silently reset', t => {
  const f = fixture(t); f.store.close();
  fs.writeFileSync(f.store.filename, '{"format":999}');
  assert.throws(() => new WorldStore(f.directory), /Unsupported world format/);
  assert.equal(fs.readFileSync(f.store.filename, 'utf8'), '{"format":999}');
  fs.writeFileSync(f.store.filename, 'broken');
  assert.throws(() => new WorldStore(f.directory), /unreadable/);
});

test('durable timer queues preserve ordering, consume once and clean deleted-object timers', t => {
  let now = 1000; const f = fixture(t, { clock: () => now });
  f.store.ensureAvatar(alice);
  const object = f.store.createObject({ classNumber: 213, regionId: 1, ownerId: 1, fields: { serverState: { reelSequence: [1, 2, 3] } } });
  const later = f.store.scheduleTimer(object.id, 'spin-complete', 3000, { sequence: [3, 2, 1] });
  const earlier = f.store.scheduleTimer(object.id, 'animate', 2000, { chore: 1 });
  f.restart(); now = 2500;
  assert.deepEqual(f.store.dueTimers().map(timer => timer.id), [earlier.id]);
  assert.deepEqual(f.store.consumeDueTimers().map(timer => timer.id), [earlier.id]);
  assert.deepEqual(f.store.consumeDueTimers(), []);
  assert.equal(f.store.getObject(object.id).fields.serverState.reelSequence[2], 3);
  f.store.deleteObject(object.id, { actorId: 1 });
  assert.equal(f.store.snapshot().timers[later.id], undefined);
});

test('dynamic CUTESI byte arrays persist as canonical numeric arrays', t => {
  const f = fixture(t);
  const object = f.store.createObject({ classNumber: 213, regionId: 1,
    fields: { data: Buffer.from([0, 127, 255]), words: new Uint16Array([1, 65535]), serverOnly: { areaCode: 4 } } });
  assert.deepEqual(f.store.getObject(object.id).fields.data, [0, 127, 255]);
  f.restart();
  assert.deepEqual(f.store.getObject(object.id).fields.words, [1, 65535]);
  assert.equal(f.store.getObject(object.id).fields.serverOnly.areaCode, 4);
  assert.throws(() => f.store.transaction(draft => { draft.objects[object.id].fields.executable = () => 1; }), /plain JSON/);
});

test('pending region deletion waits for occupancy then relocates offline possessions and cleans references', t => {
  const f = fixture(t); const profile = f.store.ensureAvatar(alice, { regionId: 2, classNumber: 21 }); f.store.ensureAvatar(bob);
  const bag = f.store.createObject({ classNumber: 36, regionId: 2, ownerId: 1, containerId: profile.objectId, capacity: 2 });
  const note = f.store.createObject({ classNumber: 37, regionId: 2, ownerId: null, containerId: bag.id });
  f.store.writeDocument(note.id, { title: 'Keep', text: 'Inventory survives region retirement' }, { admin: true });
  const grounded = f.store.createObject({ classNumber: 36, regionId: 2, ownerId: 1, capacity: 1 });
  const publicObject = f.store.createObject({ classNumber: 37, regionId: 2, fields: { name: 'Demolished furnishing' } });
  f.store.writeDocument(publicObject.id, { text: 'Removed with furnishing' }, { admin: true });
  f.store.scheduleTimer(publicObject.id, 'decoration', 9999);
  f.store.scheduleTimer(note.id, 'retained-note', 9999);
  const message = f.store.sendMail(2, 1, { body: 'Mail survives' });
  f.store.transaction(draft => { draft.regions[2].properties.pendingDeletion = true; });
  const revision = f.store.snapshot().revision;
  assert.deepEqual(f.store.finalizePendingRegions(new Set([2])), { deletedRegionIds: [], relocatedAvatarIds: [] });
  assert.equal(f.store.snapshot().revision, revision);
  assert.deepEqual(f.store.finalizePendingRegions([]), { deletedRegionIds: [2], relocatedAvatarIds: [1] });
  assert.equal(f.store.getRegion(2), null);
  assert.equal(f.store.getAvatar(1).regionId, 1);
  assert.equal(f.store.getObject(profile.objectId).regionId, 1);
  assert.equal(f.store.getObject(bag.id).containerId, profile.objectId);
  assert.equal(f.store.getObject(note.id).regionId, 1);
  assert.equal(f.store.getDocument(note.id).title, 'Keep');
  assert.equal(f.store.getObject(grounded.id).regionId, 1);
  assert.equal(f.store.getObject(publicObject.id), null);
  assert.equal(f.store.getDocument(publicObject.id), null);
  assert.equal(Object.values(f.store.snapshot().timers).length, 1);
  assert.equal(f.store.listMail(1)[0].id, message.id);
  assert.equal(f.store.getAvatar(1).balance, 1000);
  assert.equal(f.store.getRegion(1).exits.north, undefined);
  assert.equal(f.store.getRegion(3).exits.north, undefined);
  f.restart(); assert.equal(f.store.getRegion(2), null);
  assert.equal(f.store.snapshot().audit.at(-1).action, 'pending-regions-finalized');
});

test('pending group cleanup preserves occupied members, repairs membership and never deletes the start region', t => {
  const f = fixture(t);
  f.store.transaction(draft => {
    draft.regionGroups[1] = { id: 1, name: 'Retired', regionIds: [2, 3], entryRegionId: 2, pendingDeletion: true };
    draft.next.regionGroup = 2;
    draft.regions[1].properties.pendingDeletion = true;
  });
  assert.deepEqual(f.store.finalizePendingRegions([3]), { deletedRegionIds: [2], relocatedAvatarIds: [] });
  assert.deepEqual(f.store.snapshot().regionGroups[1].regionIds, [3]);
  assert.equal(f.store.snapshot().regionGroups[1].entryRegionId, 3);
  assert.ok(f.store.getRegion(1)); assert.ok(f.store.getRegion(3));
  assert.deepEqual(f.store.finalizePendingRegions([]), { deletedRegionIds: [3], relocatedAvatarIds: [] });
  assert.equal(f.store.snapshot().regionGroups[1], undefined);
  assert.ok(f.store.getRegion(1));
  const revision = f.store.snapshot().revision;
  assert.deepEqual(f.store.finalizePendingRegions([]), { deletedRegionIds: [], relocatedAvatarIds: [] });
  assert.equal(f.store.snapshot().revision, revision);
});

test('region retirement preserves logical document members whose binder already moved elsewhere', t => {
  const f = fixture(t); f.store.ensureAvatar(alice);
  const binder = f.store.createObject({ classNumber: 37, regionId: 1, ownerId: 1 });
  const member = f.store.createObject({ classNumber: 37, regionId: 2 });
  f.store.transaction(draft => {
    draft.documents[binder.id] = { objectId: binder.id, title: 'Binder', text: '', updatedAt: 0, entries: [member.id] };
    draft.documents[member.id] = { objectId: member.id, title: 'Member', text: 'Keep this page', updatedAt: 0 };
    draft.objects[member.id].archivedIn = binder.id;
    draft.objects[member.id].archivedFlags = 0;
    draft.regions[2].properties.pendingDeletion = true;
  });
  f.store.finalizePendingRegions([]);
  assert.equal(f.store.getObject(member.id).regionId, 1);
  assert.equal(f.store.getObject(member.id).archivedIn, binder.id);
  assert.deepEqual(f.store.getDocument(binder.id).entries, [member.id]);
  assert.equal(f.store.getDocument(member.id).text, 'Keep this page');
});
