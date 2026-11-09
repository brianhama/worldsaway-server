import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorldStore } from '../dist/src/world-store.js';
import { applyHousingExitPolicy, PresencePolicyError } from '../dist/src/presence-policy.js';
import { createCompatibilityServer } from './helpers/fixtures.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-presence-policy-'));
  const store = new WorldStore(directory, { clock: () => 1000 });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const [id, name] of [[1, 'Owner'], [2, 'Coowner'], [3, 'Guest'], [4, 'OfflineGuest']]) {
    store.ensureAvatar({ id, accountId: id, name }, { regionId: 2, classNumber: 21 });
  }
  store.transaction(draft => { draft.regions[2].properties.housing = { ownerId: 1, coOwnerIds: [2], guestAllowed: true, kickOutOnExit: true }; });
  return { store, directory };
}

function leave(draft, avatarId, destinationId) {
  const avatar = draft.avatars[avatarId], actor = draft.objects[avatar.objectId];
  avatar.regionId = destinationId; actor.regionId = destinationId;
}

test('owner departure waits for the connected coowner; last owner moves online and offline guests with inventory', t => {
  const { store } = fixture(t), guest = store.getAvatar(3);
  const bag = store.createObject({ classNumber: 36, regionId: 2, containerId: guest.objectId, ownerId: 3, capacity: 2 });
  const note = store.createObject({ classNumber: 37, regionId: 2, containerId: bag.id, ownerId: 3 });
  store.writeDocument(note.id, { title: 'Personal', text: 'A saved inventory page' }, { actorId: 3 });
  const ground = store.createObject({ classNumber: 27, regionId: 2, ownerId: 3, fields: { name: 'Left on the ground' } });
  store.sendMail(1, 3, { body: 'Private mail survives' });
  const first = store.transaction(draft => {
    leave(draft, 1, 3);
    return applyHousingExitPolicy(draft, { departingAvatarId: 1, fromRegionId: 2, toRegionId: 3, presentAvatarIds: [1, 2, 3] });
  });
  assert.deepEqual(first, []); assert.equal(store.getAvatar(3).regionId, 2);
  const moved = store.transaction(draft => {
    leave(draft, 2, 3);
    return applyHousingExitPolicy(draft, { departingAvatarId: 2, fromRegionId: 2, toRegionId: 3, presentAvatarIds: [1, 2, 3] });
  });
  assert.deepEqual(moved, [3, 4]);
  assert.equal(store.getAvatar(1).regionId, 3); assert.equal(store.getAvatar(2).regionId, 3);
  assert.equal(store.getAvatar(3).regionId, 1); assert.equal(store.getAvatar(4).regionId, 1);
  for (const objectId of [guest.objectId, bag.id, note.id]) assert.equal(store.getObject(objectId).regionId, 1);
  assert.equal(store.getObject(note.id).containerId, bag.id);
  assert.equal(store.getObject(ground.id).regionId, 2, 'guest ground possessions remain in the home');
  assert.equal(store.getDocument(note.id).text, 'A saved inventory page');
  assert.equal(store.getAvatar(3).balance, 1000);
  assert.equal(store.listMail(3)[0].body, 'Private mail survives');
  const restored = new WorldStore(store.dataDir);
  try { assert.equal(restored.getAvatar(4).regionId, 1); } finally { restored.close(); }
});

test('disconnect uses live presence, not the saved location of an offline owner', t => {
  const { store } = fixture(t);
  const moved = store.transaction(draft => applyHousingExitPolicy(draft,
    { departingAvatarId: 1, fromRegionId: 2, presentAvatarIds: [3] }));
  assert.deepEqual(moved, [3, 4]);
  assert.equal(store.getAvatar(1).regionId, 2, 'disconnect does not move the owner');
  assert.equal(store.getAvatar(2).regionId, 2, 'offline coowner is preserved but does not count as present');
});

test('same-region refreshes, guest departures, disabled policies and ended leases do not evict', t => {
  const { store } = fixture(t), original = store.snapshot();
  for (const options of [
    { departingAvatarId: 1, fromRegionId: 2, toRegionId: 2 },
    { departingAvatarId: 3, fromRegionId: 2, toRegionId: 3 },
    { departingAvatarId: 1, fromRegionId: 1, toRegionId: 3 },
  ]) {
    const draft = structuredClone(original);
    assert.deepEqual(applyHousingExitPolicy(draft, options), []);
    assert.deepEqual(draft, original);
  }
  for (const patch of [{ kickOutOnExit: false }, { endedAt: 500 }]) {
    const draft = structuredClone(original); Object.assign(draft.regions[2].properties.housing, patch);
    const before = structuredClone(draft);
    assert.deepEqual(applyHousingExitPolicy(draft, { departingAvatarId: 1, fromRegionId: 2 }), []);
    assert.deepEqual(draft, before);
  }
});

test('physical write failure rolls owner departure and all guest relocation back together', t => {
  const { store } = fixture(t), before = store.snapshot(), oldBytes = fs.readFileSync(store.filename);
  const original = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === store.filename) throw new Error('injected housing commit failure');
    return original(source, destination);
  });
  assert.throws(() => store.transaction(draft => {
    leave(draft, 1, 3);
    const moved = applyHousingExitPolicy(draft, { departingAvatarId: 1, fromRegionId: 2, toRegionId: 3, presentAvatarIds: [3] });
    assert.deepEqual(moved, [3, 4]);
  }), /injected housing commit failure/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(fs.readFileSync(store.filename), oldBytes);
});

test('seated guests stand up and logical binder contents move without resetting their data', t => {
  const { store } = fixture(t), guest = store.getAvatar(3);
  const seat = store.createObject({ classNumber: 53, regionId: 2, capacity: 10, portable: false });
  const binder = store.createObject({ classNumber: 37, regionId: 2, ownerId: 3, containerId: guest.objectId });
  const member = store.createObject({ classNumber: 37, regionId: 2, ownerId: 3 });
  store.transaction(draft => {
    const actor = draft.objects[guest.objectId]; actor.containerId = seat.id; actor.slot = 2; actor.fields.choreState = 1;
    draft.documents[binder.id] = { objectId: binder.id, title: 'Binder', text: '', updatedAt: 1000, entries: [member.id] };
    draft.documents[member.id] = { objectId: member.id, title: 'Member', text: 'Archived text', updatedAt: 1000 };
    draft.objects[member.id].archivedIn = binder.id;
    applyHousingExitPolicy(draft, { departingAvatarId: 1, fromRegionId: 2, presentAvatarIds: [3] });
  });
  const actor = store.getObject(guest.objectId);
  assert.equal(actor.containerId, null); assert.equal(actor.slot, 0); assert.equal(actor.fields.choreState, 0);
  assert.deepEqual(actor.fields.position, [256, 220, 0]);
  assert.equal(store.getObject(seat.id).regionId, 2);
  assert.equal(store.getObject(member.id).regionId, 1); assert.equal(store.getObject(member.id).archivedIn, binder.id);
  assert.equal(store.getDocument(member.id).text, 'Archived text');
});

test('an unavailable safe fallback aborts instead of losing or partially moving guest state', t => {
  const { store } = fixture(t), draft = store.snapshot();
  draft.startRegionId = 2;
  const before = structuredClone(draft);
  assert.throws(() => applyHousingExitPolicy(draft, { departingAvatarId: 1, fromRegionId: 2 }), PresencePolicyError);
  assert.deepEqual(draft, before);
});

async function runtimeFixture(t, { connectCoowner = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-housing-runtime-'));
  const clientDir = fileURLToPath(new URL('../../wa', import.meta.url));
  const server = createCompatibilityServer({ clientDir, dataDir: directory, httpPort: 0, worldPort: 0, rpcPort: 0, now: () => 1000 });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const users = {};
  for (const [key, name] of [['owner', 'Owner'], ['coowner', 'Coowner'], ['guest', 'Guest'], ['offline', 'OfflineGuest']]) {
    const account = server.store.createAccount(key, 'pw'), avatar = server.store.createAvatar(account, name);
    server.worldStore.ensureAvatar(avatar, { regionId: 2, classNumber: 21 });
    users[key] = { account, avatar };
  }
  server.worldStore.transaction(draft => {
    draft.regions[2].properties.housing = { ownerId: users.owner.avatar.id, coOwnerIds: [users.coowner.avatar.id], guestAllowed: true, kickOutOnExit: true };
  });
  for (const key of ['owner', ...(connectCoowner ? ['coowner'] : []), 'guest']) {
    const user = users[key];
    const session = { ...user, closed: false, sent: [], send(bytes) { this.sent.push(Buffer.from(bytes)); },
      end() { if (this.closed) return; this.closed = true; server.runtime.detach(this); server.sessions.delete(this); } };
    server.sessions.add(session); user.session = session;
    await server.runtime.attach(session);
  }
  for (const user of Object.values(users)) if (user.session) user.session.sent.length = 0;
  return { server, runtime: server.runtime, store: server.worldStore, users, directory };
}

function latestSceneName(session) {
  const frame = session.sent.filter(bytes => bytes.length >= 8 && bytes.readUInt16BE(2) === 101).at(-1);
  assert.ok(frame, 'relocated client receives a full destination scene');
  const compressed = frame.subarray(8 + 112), expected = compressed.readUInt32BE(0), expanded = [];
  for (let offset = 4; offset < compressed.length; offset++) {
    if (compressed[offset] !== 255) expanded.push(compressed[offset]);
    else { const count = compressed[++offset]; if (count === 255) expanded.push(255); else expanded.push(...Array(count).fill(0)); }
  }
  assert.equal(expanded.length, expected);
  const data = Buffer.from(expanded), firstLength = data.readUInt16BE(0);
  assert.ok(firstLength >= 44); assert.equal(data.readUInt16BE(2), 20, 'first CV object is the Region');
  return data.subarray(2 + 4, 2 + 36).toString('latin1').split('\0')[0];
}

test('real runtime owner travel publishes evictions only after the last connected owner leaves', async t => {
  const f = await runtimeFixture(t), { owner, coowner, guest, offline } = f.users;
  await f.runtime.teleport(owner.session, 3);
  assert.equal(guest.session.regionId, 2); assert.equal(f.store.getAvatar(guest.avatar.id).regionId, 2);
  guest.session.sent.length = 0;
  await f.runtime.teleport(coowner.session, 3);
  assert.equal(owner.session.regionId, 3); assert.equal(coowner.session.regionId, 3);
  assert.equal(guest.session.regionId, 1); assert.equal(f.store.getAvatar(offline.avatar.id).regionId, 1);
  assert.equal(latestSceneName(guest.session), f.store.getRegion(1).name.slice(0, 31));
});

test('real runtime disconnect evicts guests while offline coowners retain their home location', async t => {
  const f = await runtimeFixture(t, { connectCoowner: false }), { owner, coowner, guest } = f.users;
  owner.session.end();
  await f.runtime.queue;
  assert.equal(f.store.getAvatar(owner.avatar.id).regionId, 2);
  assert.equal(f.store.getAvatar(coowner.avatar.id).regionId, 2);
  assert.equal(guest.session.regionId, 1); assert.equal(f.store.getAvatar(guest.avatar.id).regionId, 1);
  assert.equal(latestSceneName(guest.session), f.store.getRegion(1).name.slice(0, 31));
});

test('ordinary runtime travel carries logical binder members as well as physical inventory', async t => {
  const f = await runtimeFixture(t), guest = f.users.guest;
  const profile = f.store.getAvatar(guest.avatar.id);
  const binder = f.store.createObject({ classNumber: 37, regionId: 2, ownerId: profile.id, containerId: profile.objectId });
  const member = f.store.createObject({ classNumber: 37, regionId: 2, ownerId: profile.id });
  f.store.transaction(draft => {
    draft.documents[binder.id] = { objectId: binder.id, title: 'Binder', text: '', updatedAt: 1000, entries: [member.id] };
    draft.documents[member.id] = { objectId: member.id, title: 'Member', text: 'Travels with the binder', updatedAt: 1000 };
    draft.objects[member.id].archivedIn = binder.id;
  });
  await f.runtime.teleport(guest.session, 3);
  for (const objectId of [profile.objectId, binder.id, member.id]) assert.equal(f.store.getObject(objectId).regionId, 3);
  assert.equal(f.store.getObject(member.id).archivedIn, binder.id);
  assert.equal(f.store.getDocument(member.id).text, 'Travels with the binder');
});
