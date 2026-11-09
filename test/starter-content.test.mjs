import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ClassRegistry } from '../dist/src/classes.js';
import { ResourceStore } from './helpers/fixtures.mjs';
import { WorldStore } from '../dist/src/world-store.js';
import { applyObjectAction } from '../dist/src/object-actions.js';
import { ensureStarterContent, STARTER_CONTENT_MIGRATION } from '../dist/src/starter-content.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resources = new ResourceStore({ clientDir: path.join(root, 'wa') });
const registry = resources && new ClassRegistry(resources);
const original = { skip: !resources && 'Original WA cache is not present' };

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-starter-'));
  const store = new WorldStore(directory, { clock: () => 1000, ...options });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, install: () => ensureStarterContent(store, registry, resources) };
}

test('starter migration appends usable original-schema objects in one audited durable commit', original, t => {
  const f = fixture(t), before = f.store.snapshot(), previousFile = fs.readFileSync(f.store.filename);
  const marker = f.install(), state = f.store.snapshot();
  assert.equal(marker.id, STARTER_CONTENT_MIGRATION);
  assert.equal(state.revision, before.revision + 1);
  assert.equal(state.audit.length, before.audit.length + 1);
  assert.equal(state.audit.at(-1).action, 'starter-content-installed');
  assert.deepEqual(fs.readFileSync(f.store.backupFilename), previousFile);
  assert.deepEqual(state.regions, before.regions);
  assert.equal(Object.keys(state.regions).length, 3);
  assert.equal(marker.createdIds.length, 8);
  assert.equal(new Set(marker.createdIds).size, 8);
  assert.deepEqual(state.contentMigrations['starter-1'], marker);

  const preceding = new Set(Object.keys(before.objects).map(Number));
  for (const id of marker.createdIds) {
    const object = state.objects[id], definition = registry.get(object.classNumber);
    assert.ok(object);
    assert.equal(object.capacity, definition.capacity);
    if (Object.hasOwn(object.fields, 'reducedCapacity')) assert.equal(object.fields.reducedCapacity, definition.capacity);
    assert.equal(registry.validateObject(object, { strictFields: true }), true);
    const bytes = registry.encodeObject(object), decoded = registry.decodeInstance(object.classNumber, bytes);
    assert.equal(decoded.classNumber, object.classNumber); assert.equal(decoded.name, object.fields.name);
    const info = resources.getFileInfo(decoded.imageURL);
    assert.ok(info?.data.length, `Cached image for ${decoded.name}`);
    assert.equal(decoded.imageVersion, info.version);
    if (object.containerId !== null) {
      assert.ok(preceding.has(object.containerId), 'Native contents vector can emit each parent before its child');
      assert.equal(state.objects[object.containerId].regionId, object.regionId);
      assert.equal(object.fields.position[0], object.slot);
    }
    preceding.add(id);
  }
  assert.equal(state.objects[marker.objects.atm].classNumber, 33);
  assert.equal(state.objects[marker.objects.atm].public, true);
  const npc = state.objects[marker.objects.greeter];
  assert.equal(npc.classNumber, 200); assert.equal(npc.fields.npc_flags & 4, 4);
  for (const topic of ['materialize', 'bank', 'pickup']) assert.ok(npc.dialogue[topic]);
  assert.equal(state.objects[marker.objects.greeterHead].slot, 1);
  const machine = state.objects[marker.objects.vendroid];
  assert.equal(machine.classNumber, 57); assert.equal(machine.fields.currentSlot, 1);
  const stock = marker.createdIds.map(id => state.objects[id]).filter(object => object.containerId === machine.id);
  assert.equal(stock.length, 3); assert.deepEqual(stock.map(object => object.fields.salePrice), [0, 5, 10]);
  assert.deepEqual(stock.map(object => object.slot), [0, 2, 3]);
  for (const object of stock) { assert.equal(object.classNumber, 27); assert.equal(object.portable, true); }
  assert.equal(state.objects[marker.objects.pet].adoptable, true);
});

test('repeat launches and deleted starter items never duplicate or recreate installed content', original, t => {
  const f = fixture(t), marker = f.install(), committed = f.store.snapshot(), disk = fs.readFileSync(f.store.filename);
  marker.createdIds.push(999999);
  assert.deepEqual(f.install(), committed.contentMigrations['starter-1']);
  assert.deepEqual(f.store.snapshot(), committed); assert.deepEqual(fs.readFileSync(f.store.filename), disk);
  const teddy = committed.contentMigrations['starter-1'].objects.teddy;
  f.store.transaction(draft => { delete draft.objects[teddy]; });
  const afterDelete = f.store.snapshot();
  const restored = new WorldStore(f.directory, { clock: () => 2000 });
  try {
    ensureStarterContent(restored, registry, resources);
    assert.deepEqual(restored.snapshot(), afterDelete);
    assert.equal(restored.getObject(teddy), null);
  } finally { restored.close(); }
});

test('existing objects, account files, profile preferences, balances and custom room names are preserved', original, t => {
  const f = fixture(t, { startRegionName: 'My existing lobby' });
  f.store.ensureAvatar({ id: 1, accountId: 10, name: 'Alice' }, { balance: 417, role: 'builder' });
  f.store.updatePreferences(1, { sound: false, flags: 512, custom: 'keep me' });
  f.store.transaction(draft => {
    draft.regions[2].name = 'My greenhouse'; draft.regions[3].name = 'My study';
    draft.objects[4].fields.name = 'My untouched chest';
  });
  const accounts = path.join(f.directory, 'accounts.json'); fs.writeFileSync(accounts, 'account sentinel\n');
  const before = f.store.snapshot(), marker = f.install(), after = f.store.snapshot();
  for (const [id, object] of Object.entries(before.objects)) assert.deepEqual(after.objects[id], object);
  for (const key of ['avatars', 'regions', 'documents', 'mail', 'ledger']) assert.deepEqual(after[key], before[key]);
  assert.equal(fs.readFileSync(accounts, 'utf8'), 'account sentinel\n');
  assert.deepEqual(marker.regionIds, { start: 1, garden: 2, library: 3 });
  assert.equal(f.store.getAvatar(1).balance, 417);
});

test('custom single-room worlds receive content without new regions or room renames', original, t => {
  const f = fixture(t, { seed: false });
  const room = f.store.createRegion({ name: 'One room' });
  const before = f.store.snapshot(), marker = f.install(), after = f.store.snapshot();
  assert.deepEqual(after.regions, before.regions);
  assert.deepEqual(marker.regionIds, { start: room.id, garden: room.id, library: room.id });
  assert.ok(marker.createdIds.every(id => after.objects[id].regionId === room.id));
});

test('the seeded public ATM can withdraw the existing opening balance without granting new money', original, t => {
  const f = fixture(t), profile = f.store.ensureAvatar({ id: 1, accountId: 1, name: 'Alice' }, { classNumber: 21 });
  const marker = f.install(), before = f.store.getAvatar(1).balance;
  const outcome = f.store.transaction(draft => applyObjectAction(draft, {
    id: 2810, objectId: marker.objects.atm, actorId: profile.objectId, avatarId: 1,
    avatarName: 'Alice', fields: { amount: 5 }, refs: {}, now: 1000,
  }));
  assert.equal(outcome.reply.balance, before - 5);
  const cash = f.store.listObjects().find(object => object.containerId === profile.objectId && object.classNumber === 26);
  assert.equal(cash.fields.denom, 5); assert.equal(cash.ownerId, 1);
  assert.equal(f.store.getAvatar(1).balance + cash.fields.denom, before);
});

test('native browse then slot-zero purchase buys the selected seeded item with real withdrawn tokens', original, t => {
  const f = fixture(t), profile = f.store.ensureAvatar({ id: 1, accountId: 1, name: 'Alice' }, { classNumber: 21 });
  const marker = f.install();
  const act = (id, objectId, fields) => f.store.transaction(draft => applyObjectAction(draft, {
    id, objectId, actorId: profile.objectId, avatarId: 1, avatarName: 'Alice', fields, refs: {}, now: 1000,
  }));
  act(2810, marker.objects.atm, { amount: 5 });
  f.store.transaction(draft => {
    draft.avatars[1].regionId = marker.regionIds.library;
    for (const object of Object.values(draft.objects)) {
      if (object.id === profile.objectId || object.containerId === profile.objectId) object.regionId = marker.regionIds.library;
    }
  });
  const browse = act(2671, marker.objects.vendroid, { forward: 1 });
  assert.equal(browse.reply.next_slot, 2);
  assert.equal(f.store.getObject(marker.objects.cocoa).slot, 0);
  assert.equal(f.store.getObject(marker.objects.teddy).slot, 1);
  const bought = act(2675, marker.objects.vendroid, { slot: 0 });
  assert.deepEqual(bought.cvObjectIds, [marker.objects.cocoa]);
  const cocoa = f.store.getObject(marker.objects.cocoa);
  assert.equal(cocoa.containerId, profile.objectId); assert.equal(cocoa.ownerId, 1);
  assert.equal(cocoa.fields.common_flags & 2, 0);
  assert.equal(f.store.getAvatar(1).balance, 995);
  assert.equal(f.store.listObjects({ classNumber: 26 }).length, 0);
  const beforeRepeat = f.store.snapshot(); f.install();
  assert.deepEqual(f.store.snapshot(), beforeRepeat);
});

test('failed durable replacement rolls back all new IDs, migration marker and state', original, t => {
  const f = fixture(t), before = f.store.snapshot(), disk = fs.readFileSync(f.store.filename);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.store.filename) throw Object.assign(new Error('injected starter persistence failure'), { code: 'EIO' });
    return rename(source, destination);
  });
  assert.throws(f.install, /injected starter persistence failure/);
  assert.deepEqual(f.store.snapshot(), before); assert.deepEqual(fs.readFileSync(f.store.filename), disk);
  assert.equal(f.store.snapshot().contentMigrations, undefined);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
  t.mock.restoreAll();
  assert.equal(f.install().createdIds[0], before.next.object);
});

test('missing required cache images fail before allocating IDs or saving a marker', original, t => {
  const f = fixture(t), before = f.store.snapshot();
  const unavailable = { listFileNames: () => resources.listFileNames(), getFileInfo: name => name === 'o.atm01.img' ? null : resources.getFileInfo(name) };
  assert.throws(() => ensureStarterContent(f.store, registry, unavailable), /cached image o.atm01.img/);
  assert.deepEqual(f.store.snapshot(), before);
});
