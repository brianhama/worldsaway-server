import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldsAwayServer } from '../dist/src/server.js';

async function fixture(t, { count = 2 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-runtime-automation-'));
  let now = 1000;
  const server = createWorldsAwayServer({ dataDir: directory, httpPort: 0, worldPort: 0, rpcPort: 0, now: () => now });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const runtime = server.runtime, store = server.worldStore, sessions = [];
  for (let i = 0; i < count; i++) {
    const account = i === 0 ? server.store.account('demo') : server.store.createAccount(`player${i}`, 'test');
    const avatar = i === 0 ? server.store.listAvatars(account)[0] : server.store.createAvatar(account, `Player${i}`);
    const packets = [];
    const session = { avatar, account, closed: false, send: async packet => packets.push(Buffer.from(packet)),
      end() { this.closed = true; runtime.detach(this); }, packets };
    await runtime.attach(session); await runtime.setActorMode(session, 'avatar'); await runtime.sendScene(session);
    sessions.push(session);
  }
  return { server, runtime, store, sessions, directory, setTime(value) { now = value; } };
}

test('region travel publishes following chains and pets to each session and keeps inventories after restart', async t => {
  const f = await fixture(t), [leader, follower] = f.sessions;
  const dog = f.store.snapshot().contentMigrations['starter-1'].objects.pet;
  f.store.transaction(draft => {
    const owner = draft.avatars[leader.avatar.id], profile = draft.avatars[follower.avatar.id];
    profile.preferences.following = owner.id;
    draft.objects[profile.objectId].fields.following = owner.objectId;
    const pet = draft.objects[dog]; pet.ownerId = owner.id; pet.regionId = owner.regionId;
    pet.petState = { followsObjectId: owner.objectId };
  });
  await f.runtime.teleport(leader, 2);
  assert.equal(leader.regionId, 2); assert.equal(follower.regionId, 2);
  for (const session of f.sessions) {
    assert.equal(session.viewRegionId, 2);
    assert.equal(f.store.getAvatar(session.avatar.id).regionId, 2);
    const actor = f.runtime.actorObject(session);
    assert.equal(actor.regionId, 2);
    for (const child of f.store.listObjects().filter(item => item.containerId === actor.id)) assert.equal(child.regionId, 2);
    assert([...session.view.values()].some(item => item.objectId === actor.id));
  }
  assert.equal(f.store.getObject(dog).regionId, 2);
  await f.server.close();
  const restarted = createWorldsAwayServer({ dataDir: f.directory, httpPort: 0, worldPort: 0, rpcPort: 0, now: () => 2000 });
  try {
    assert.equal(restarted.worldStore.getAvatar(follower.avatar.id).regionId, 2);
    assert.equal(restarted.worldStore.getObject(dog).regionId, 2);
  } finally { await restarted.close(); }
});

test('followers obey destination population and mode transitions clear both native and durable following', async t => {
  const f = await fixture(t), [leader, follower] = f.sessions;
  f.store.transaction(draft => {
    const profile = draft.avatars[follower.avatar.id]; profile.preferences.following = leader.avatar.id;
    draft.objects[profile.objectId].fields.following = draft.avatars[leader.avatar.id].objectId;
    draft.objects[draft.regions[2].objectId].fields.max_avatars = 1;
  });
  await f.runtime.teleport(leader, 2);
  assert.equal(follower.regionId, 1); assert.equal(f.store.getAvatar(follower.avatar.id).preferences.following, null);
  assert.equal(f.runtime.actorObject(follower).fields.following, 65535);
  f.store.transaction(draft => { draft.avatars[follower.avatar.id].preferences.following = leader.avatar.id; });
  await f.runtime.setActorMode(follower, 'ghost');
  assert.equal(f.store.getAvatar(follower.avatar.id).preferences.following, null);
  assert.equal(f.runtime.actorObject(follower).fields.following, 65535);
});

test('due bus departure moves seated sessions and complete inventory before publishing native scenes', async t => {
  const f = await fixture(t), marker = f.store.snapshot().contentMigrations['worldsaway-districts-1'];
  const busId = marker.busObjectId, destination = marker.regionIds.Market;
  f.store.transaction(draft => {
    for (const [index, session] of f.sessions.entries()) {
      const profile = draft.avatars[session.avatar.id], actor = draft.objects[profile.objectId];
      actor.containerId = busId; actor.slot = index; actor.fields.position = [index, 0, 0];
    }
  });
  f.setTime(31000); await f.runtime.tick();
  assert.equal(f.store.getObject(busId).regionId, destination);
  for (const session of f.sessions) {
    assert.equal(session.regionId, destination); assert.equal(session.viewRegionId, destination);
    const actor = f.runtime.actorObject(session); assert.equal(actor.containerId, busId); assert.equal(actor.regionId, destination);
    const head = f.store.listObjects().find(item => item.containerId === actor.id && item.classNumber === 24);
    assert.equal(head.regionId, destination);
    assert([...session.view.values()].some(item => item.objectId === busId));
  }
  assert.equal(f.store.snapshot().busRoutes[1].journeys, 1);
});

test('bus capacity admission and failed durable departure leave every session and passenger at its origin', async t => {
  const f = await fixture(t), marker = f.store.snapshot().contentMigrations['worldsaway-districts-1'];
  const busId = marker.busObjectId, destination = marker.regionIds.Market;
  f.store.transaction(draft => {
    draft.objects[draft.regions[destination].objectId].fields.max_avatars = 1;
    for (const [index, session] of f.sessions.entries()) {
      const actor = draft.objects[draft.avatars[session.avatar.id].objectId]; actor.containerId = busId; actor.slot = index; actor.fields.position = [index, 0, 0];
    }
  });
  f.setTime(31000); await f.runtime.tick();
  for (const session of f.sessions) assert.equal(session.regionId, 1);
  assert.equal(f.store.getObject(busId).regionId, 1); assert.match(f.store.snapshot().busRoutes[1].lastError, /cannot enter/);
  f.store.transaction(draft => { draft.objects[draft.regions[destination].objectId].fields.max_avatars = 32; });
  const before = f.store.snapshot(), rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (target === f.store.filename) throw new Error('simulated disk failure'); return rename(source, target); };
  try { f.setTime(61000); await assert.rejects(f.runtime.tick(), /simulated disk failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(f.store.snapshot(), before);
  for (const session of f.sessions) assert.equal(session.regionId, 1);
});

test('only persisted staff can configure a bus and invalid routes roll back without publishing', async t => {
  const f = await fixture(t, { count: 1 });
  const marker = f.store.snapshot().contentMigrations['worldsaway-districts-1'];
  const post = data => f.server.handleHttpRequest({ method: 'POST', path: '/api/world',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: Buffer.from(new URLSearchParams({ account: 'demo', password: 'demo', avatar: 'Demo', action: 'configure-bus', data: JSON.stringify(data) }).toString()) });
  const data = { id: 1, vehicleObjectId: marker.busObjectId, stopObjectIds: marker.stopObjectIds, intervalSeconds: 15 };
  assert.equal((await post(data)).status, 403);
  f.store.transaction(draft => { draft.avatars[f.sessions[0].avatar.id].role = 'builder'; });
  const response = await post(data); assert.equal(response.status, 200);
  assert.equal(f.store.snapshot().busRoutes[1].intervalSeconds, 15);
  const before = f.store.snapshot(); assert.equal((await post({ ...data, stopObjectIds: [123456, 234567] })).status, 400);
  assert.deepEqual(f.store.snapshot(), before);
});
