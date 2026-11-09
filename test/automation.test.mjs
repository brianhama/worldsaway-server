import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorldStore } from '../dist/src/world-store.js';
import { applyFollowingTravel, applyPetFollowing, configureBusRoute, busesDue, tickBusRoutes } from '../dist/src/automation.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-automation-'));
  const store = new WorldStore(directory, { clock: () => 1000 });
  for (let id = 1; id <= 3; id++) store.ensureAvatar({ id, accountId: id, name: ['Alice', 'Bob', 'Carol'][id - 1] }, { classNumber: 21 });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const add = (classNumber, regionId = 1, fields = {}, extra = {}) => store.createObject({ classNumber, regionId, capacity: classNumber === 53 ? 10 : 0,
    fields: { position: [240, 220, 0], ...fields }, ...extra }).id;
  return { store, directory, add };
}

function moveLeader(draft, id, regionId) {
  const profile = draft.avatars[id], actor = draft.objects[profile.objectId]; profile.regionId = regionId; actor.regionId = regionId;
  actor.fields.position = [320, 200, 0]; profile.position = [...actor.fields.position];
}

test('online following chains and loose adopted pets cross regions with their inventories', t => {
  const f = fixture(t), bob = f.store.getAvatar(2), carol = f.store.getAvatar(3);
  const bag = f.add(36, 1, { position: [2, 0, 0] }, { containerId: bob.objectId, ownerId: 2, capacity: 10 });
  const gift = f.add(27, 1, { position: [0, 0, 0] }, { containerId: bag, ownerId: 2 });
  const pet = f.add(201, 1, {}, { ownerId: 2 });
  const moved = f.store.transaction(draft => {
    draft.avatars[2].preferences.following = 1; draft.objects[bob.objectId].fields.following = draft.avatars[1].objectId;
    draft.avatars[3].preferences.following = 2; draft.objects[carol.objectId].fields.following = bob.objectId;
    draft.objects[pet].petState = { followsObjectId: bob.objectId };
    moveLeader(draft, 1, 2);
    return applyFollowingTravel(draft, { leaderAvatarId: 1, fromRegionId: 1, toRegionId: 2, presentAvatarIds: [1, 2, 3], canEnter: () => true });
  });
  assert.deepEqual(moved, [2, 3]);
  for (const id of [bob.objectId, carol.objectId, bag, gift, pet]) assert.equal(f.store.getObject(id).regionId, 2);
  assert.deepEqual(f.store.getObject(pet).fields.position, [296, 200, 0]);
  assert.equal(f.store.getAvatar(2).regionId, 2);
  const restored = new WorldStore(f.directory); assert.equal(restored.getObject(gift).regionId, 2); restored.close();
});

test('followers cannot bypass admission and offline followers remain in their original region', t => {
  const f = fixture(t);
  const moved = f.store.transaction(draft => {
    draft.avatars[2].preferences.following = 1; draft.avatars[3].preferences.following = 1;
    moveLeader(draft, 1, 2);
    return applyFollowingTravel(draft, { leaderAvatarId: 1, fromRegionId: 1, toRegionId: 2, presentAvatarIds: [1, 2], canEnter: () => false });
  });
  assert.deepEqual(moved, []); assert.equal(f.store.getAvatar(2).regionId, 1); assert.equal(f.store.getAvatar(2).preferences.following, null);
  assert.equal(f.store.getAvatar(3).regionId, 1); assert.equal(f.store.getAvatar(3).preferences.following, 1);
});

test('pet movement respects contained pets and explicit stationary companion settings', t => {
  const f = fixture(t), actor = f.store.getAvatar(1).objectId;
  const pet = f.add(201, 1, {}, { ownerId: 1 });
  f.store.transaction(draft => { draft.objects[pet].petState = { followsObjectId: actor }; draft.objects[pet].properties = { followOwner: false }; });
  assert.deepEqual(f.store.transaction(draft => applyPetFollowing(draft)).movedObjectIds, []);
  f.store.transaction(draft => { draft.objects[pet].properties.followOwner = true; });
  assert.deepEqual(f.store.transaction(draft => applyPetFollowing(draft)).movedObjectIds, [pet]);
  assert.deepEqual(f.store.transaction(draft => applyPetFollowing(draft)).movedObjectIds, []);
});

test('scheduled buses move seated avatars and nested inventory through existing Seating objects', t => {
  const f = fixture(t), bus = f.add(53), first = f.add(204, 1), second = f.add(204, 2, { position: [120, 220, 0] });
  const alice = f.store.getAvatar(1), cash = f.add(26, 1, { position: [0, 0, 0], denom: 5 }, { ownerId: 1, containerId: alice.objectId });
  f.store.transaction(draft => {
    draft.objects[alice.objectId].containerId = bus; draft.objects[alice.objectId].fields.position = [0, 0, 0]; draft.objects[alice.objectId].slot = 0;
    configureBusRoute(draft, { id: 7, name: 'Town loop', vehicleObjectId: bus, stopObjectIds: [first, second], intervalSeconds: 10, startAt: 2000 });
  });
  assert.equal(f.store.getObject(first).fields.routeNumbers, '7'); assert.equal(busesDue(f.store.snapshot(), 1999), false);
  assert.deepEqual(f.store.transaction(draft => tickBusRoutes(draft, { now: 1999 })).departedRouteIds, []);
  const result = f.store.transaction(draft => tickBusRoutes(draft, { now: 2000 }));
  assert.deepEqual(result, { movedAvatarIds: [1], affectedRegionIds: [1, 2], departedRouteIds: [7] });
  assert.equal(f.store.getObject(bus).regionId, 2); assert.equal(f.store.getObject(alice.objectId).containerId, bus);
  assert.equal(f.store.getObject(cash).regionId, 2); assert.equal(f.store.getAvatar(1).regionId, 2);
  assert.equal(f.store.snapshot().busRoutes[7].nextAt, 12000);
  const restored = new WorldStore(f.directory);
  assert.equal(busesDue(restored.snapshot(), 12000), true);
  restored.transaction(draft => tickBusRoutes(draft, { now: 999999 }));
  assert.equal(restored.getObject(bus).regionId, 1); assert.equal(restored.snapshot().busRoutes[7].journeys, 2); restored.close();
});

test('bus admission failure is atomic and invalid or reused vehicles are rejected', t => {
  const f = fixture(t), bus = f.add(53), first = f.add(204), second = f.add(204, 2), alice = f.store.getAvatar(1);
  f.store.transaction(draft => {
    draft.objects[alice.objectId].containerId = bus;
    configureBusRoute(draft, { id: 7, vehicleObjectId: bus, stopObjectIds: [first, second] });
  });
  const result = f.store.transaction(draft => tickBusRoutes(draft, { now: 1000, canEnter: () => false }));
  assert.deepEqual(result.movedAvatarIds, []); assert.equal(f.store.getAvatar(1).regionId, 1); assert.equal(f.store.getObject(bus).regionId, 1);
  assert.match(f.store.snapshot().busRoutes[7].lastError, /cannot enter/);
  const before = f.store.snapshot();
  assert.throws(() => f.store.transaction(draft => configureBusRoute(draft, { id: 8, vehicleObjectId: bus, stopObjectIds: [first, second] })), /only one route/);
  assert.deepEqual(f.store.snapshot(), before);
});

test('bus admission checks use prospective group occupancy and roll back the complete group', t => {
  const f = fixture(t), bus = f.add(53), first = f.add(204), second = f.add(204, 2);
  f.store.transaction(draft => {
    for (const id of [1, 2]) { const actor = draft.objects[draft.avatars[id].objectId]; actor.containerId = bus; actor.slot = id - 1; actor.fields.position = [id - 1, 0, 0]; }
    configureBusRoute(draft, { id: 1, vehicleObjectId: bus, stopObjectIds: [first, second] });
  });
  const result = f.store.transaction(draft => tickBusRoutes(draft, { now: 1000,
    canEnter: (profile, regionId, candidate) => Object.values(candidate.avatars).filter(other => other.id !== profile.id && other.regionId === regionId).length < 1 }));
  assert.deepEqual(result.movedAvatarIds, []);
  for (const id of [1, 2]) assert.equal(f.store.getAvatar(id).regionId, 1);
  assert.equal(f.store.getObject(bus).regionId, 1);
});
