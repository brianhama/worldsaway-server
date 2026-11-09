import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorldsAwayServer } from '../dist/src/server.js';
import { ensureDistricts, DISTRICT_MIGRATION } from '../dist/src/districts.js';
import { applyObjectAction } from '../dist/src/object-actions.js';
import { applySpecialAction } from '../dist/src/special-actions.js';
import { BuilderActions } from '../dist/src/builder-actions.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-districts-'));
  const server = createWorldsAwayServer({ dataDir: directory, httpPort: 0, worldPort: 0, rpcPort: 0 });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { server, store: server.worldStore, registry: server.runtime.registry, marker: server.worldStore.snapshot().contentMigrations[DISTRICT_MIGRATION] };
}

function placeAvatar(draft, profile, regionId) {
  profile.regionId = regionId; profile.position = [256, 220, 0];
  const actor = draft.objects[profile.objectId]; actor.regionId = regionId; actor.fields.position = [...profile.position];
  return actor;
}

test('default WorldsAway.app startup seeds every concrete class with valid native instances and usable routes', async t => {
  const f = fixture(t), state = f.store.snapshot(), lifecycle = new Set([0, 1, 2, 3, 4, 10, 11, 20, 21, 22]);
  for (const definition of f.registry.classes.values()) if (!lifecycle.has(definition.classNumber)) {
    assert.ok(f.marker.examples[definition.classNumber], `Missing example: ${definition.classNumber} ${definition.name}`);
  }
  for (const object of Object.values(state.objects)) {
    f.registry.validateObject(object, { includeServer: true, strictFields: true });
    if (object.fields.imageURL) assert.ok(f.server.resources.getFileInfo(object.fields.imageURL), object.fields.imageURL);
  }
  const reached = new Set([state.startRegionId]);
  for (let changed = true; changed;) { changed = false; for (const id of [...reached]) for (const next of Object.values(state.regions[id].exits)) if (!reached.has(next)) { reached.add(next); changed = true; } }
  for (const id of Object.values(f.marker.regionIds)) assert.ok(reached.has(id));
  const route = state.busRoutes[1]; assert.equal(route.vehicleObjectId, f.marker.busObjectId); assert.equal(route.stopObjectIds.length, 3);
  for (const id of route.stopObjectIds) assert.equal(state.objects[id].fields.routeNumbers, '1');
  await f.server.start();
  const results = f.server.addresses;
  assert.ok(results.httpPort > 0); assert.ok(results.worldPort > 0); assert.ok(results.rpcPort > 0);
  const response = await fetch(`${f.server.baseUrl}/health`); assert.equal(response.status, 200);
});

test('district migration preserves player changes, purchased stock, and deleted objects on repeated startup', t => {
  const f = fixture(t), removed = f.marker.examples[213];
  f.store.transaction(draft => { draft.regions[f.marker.regionIds.Market].name = 'My market'; delete draft.objects[removed];
    for (const object of Object.values(draft.objects)) if (object.containerId === removed) delete draft.objects[object.id]; });
  const before = f.store.snapshot();
  assert.deepEqual(ensureDistricts(f.store, f.registry, f.server.resources), f.marker);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.store.getObject(removed), null);
});

test('seeded slot reels, spinner prizes, travel destinations and magic effects work through real action evaluators', t => {
  const f = fixture(t), profile = f.store.ensureAvatar({ id: 100, accountId: 100, name: 'Tester' }, { classNumber: 21, role: 'admin' });
  const run = (id, classNumber, fields = {}, refs = {}, evaluator = applyObjectAction) => f.store.transaction(draft => {
    const target = draft.objects[f.marker.examples[classNumber]], actor = placeAvatar(draft, draft.avatars[profile.id], target.regionId);
    return evaluator(draft, { id, objectId: target.id, actorId: actor.id, avatarId: profile.id, avatarName: profile.name, fields, refs, admin: true, now: 1000, canEnterRegion: () => true }, { random: () => 0 });
  });
  assert.equal(run(2351, 38).teleportRegionId, 1);
  assert.equal(run(4102, 39, { floor: 0 }).teleportRegionId, 1);
  assert.equal(run(20907, 209, {}, {}, applySpecialAction).teleportRegionId, 1);
  assert.equal(run(2134, 45, {}, { target: profile.objectId }).reply.success, 0);
  assert.deepEqual(f.store.getObject(profile.objectId).fields.colorMap, [...Array(16).keys()].reverse());
  const spinner = run(21304, 213, {}, {}, applySpecialAction);
  assert.equal(spinner.reply.result, 1); assert.equal(spinner.cvObjectIds.length, 1);
  assert.equal(f.store.getObject(spinner.cvObjectIds[0]).containerId, profile.objectId);
  const machine = f.store.getObject(f.marker.examples[210]);
  const children = Object.values(f.store.snapshot().objects).filter(object => object.containerId === machine.id);
  assert.deepEqual(children.map(object => object.slot).sort(), [0, 1, 2]);
  assert.equal(machine.fields.salePrice, 1); assert.ok(machine.cashReserve >= 5);
});

test('seeded rental plan creates an owned home using a real manager request', t => {
  const f = fixture(t), profile = f.store.ensureAvatar({ id: 101, accountId: 101, name: 'Tenant' }, { classNumber: 21 });
  const managerId = f.marker.examples[46], manager = f.store.getObject(managerId);
  const session = { avatar: { id: profile.id } };
  const builder = new BuilderActions({ worldStore: f.store, registry: f.registry, reply() {}, now: () => 1000,
    resolveObject: (_session, id) => f.store.getObject(id) });
  f.store.transaction(draft => {
    const actor = placeAvatar(draft, draft.avatars[profile.id], manager.regionId);
    const id = draft.next.object++; draft.objects[id] = { id, classNumber: 26, regionId: actor.regionId, containerId: actor.id, slot: 0, ownerId: profile.id,
      capacity: 0, portable: true, locked: false, fields: { name: 'Tokens', denom: 10, position: [0, 0, 0] } };
    builder.apply(draft, session, { id: 4005, noid: managerId, fields: { plan: 0, address: 'Tenant home', primary: 1 } });
  });
  const saved = f.store.getAvatar(profile.id), home = f.store.getRegion(saved.homeRegionId);
  assert.equal(home.name, 'Tenant home'); assert.equal(home.properties.housing.ownerId, profile.id);
  assert.equal(f.store.getObject(managerId).fields.num_available[0], 9);
});
