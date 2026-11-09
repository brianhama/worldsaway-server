/** Real runtime admission and durable actor transitions, without TCP listeners. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCompatibilityServer } from './helpers/fixtures.mjs';
import { WorldStore } from '../dist/src/world-store.js';

const clientDir = fileURLToPath(new URL('../../wa', import.meta.url));

function frames(chunks) {
  const bytes = Buffer.concat(chunks), output = [];
  for (let at = 0; at < bytes.length;) {
    assert.ok(at + 8 <= bytes.length);
    const length = bytes.readUInt32BE(at + 4);
    assert.ok(at + 8 + length <= bytes.length);
    output.push({ noid: bytes.readUInt16BE(at), id: bytes.readUInt16BE(at + 2), body: bytes.subarray(at + 8, at + 8 + length) });
    at += 8 + length;
  }
  return output;
}

async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lifecycle-'));
  const server = createCompatibilityServer({ dataDir, clientDir, now: () => 1000,
    httpPort: 0, worldPort: 0, rpcPort: 0, ...options });
  t.after(async () => { await server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const account = server.store.account('demo'), avatar = server.store.listAvatars(account)[0];
  server.worldStore.ensureAvatar(avatar);
  const session = { account, avatar, closed: false, sent: [],
    send(bytes) { this.sent.push(Buffer.from(bytes)); },
    end() { if (this.closed) return; this.closed = true; server.runtime.detach(this); server.sessions.delete(this); } };
  server.sessions.add(session);
  await server.runtime.attach(session);
  session.sent.length = 0;
  return { server, store: server.worldStore, runtime: server.runtime, session, avatar, dataDir };
}

test('maximum valid world name starts and persists bounded native Region names', async t => {
  const worldName = `W${'a'.repeat(62)}`, f = await fixture(t, { worldName });
  const region = f.store.getRegion(f.store.snapshot().startRegionId);
  assert.equal(region.name, `${worldName} Lobby`.slice(0, 63));
  assert.equal(region.name.length, 63);
  await f.runtime.sendScene(f.session);
  const here = frames(f.session.sent).find(message => message.id === 101);
  assert.ok(here, 'long but valid configuration emits a complete native scene');
  const serialized = f.runtime.objectFields(f.session, f.store.getObject(region.objectId));
  assert.equal(serialized.name.length, 31);
  const reopened = new WorldStore(f.dataDir);
  try { assert.equal(reopened.getRegion(region.id).name, region.name); }
  finally { reopened.close(); }
});

test('zero admission limits block each ordinary actor mode and one slot admits one actor', async t => {
  const f = await fixture(t), destination = f.store.getRegion(2);
  f.store.transaction(draft => {
    Object.assign(draft.objects[destination.objectId].fields, { max_avatars: 0, max_ghosts: 0 });
  });
  assert.equal(f.runtime.canEnterRegion(f.session, 2, { mode: 'avatar' }), false);
  assert.equal(f.runtime.canEnterRegion(f.session, 2, { mode: 'ghost' }), false);
  await assert.rejects(f.runtime.prepareTeleport(f.session, 2), /not permitted/);
  assert.equal(f.session.regionId, 1);
  f.store.transaction(draft => { draft.objects[destination.objectId].fields.max_ghosts = 1; });
  assert.equal(f.runtime.canEnterRegion(f.session, 2, { mode: 'ghost' }), true);
  assert.equal(f.runtime.canEnterRegion(f.session, 2, { mode: 'avatar' }), false);
  f.store.transaction(draft => { draft.avatars[f.avatar.id].role = 'admin'; });
  assert.equal(f.runtime.canEnterRegion(f.session, 2, { mode: 'avatar' }), true);
});

test('ordinary HereIs flags enable native actions separately from optional player preferences', async t => {
  const f = await fixture(t);
  await f.runtime.sendScene(f.session);
  const here = frames(f.session.sent).find(message => message.id === 101);
  assert.ok(here);
  assert.equal(here.body.readUInt16BE(98), 0, 'PlayerFlags has no mandatory enable bit');
  assert.equal(here.body.readUInt16BE(100), 10, 'ordinary permission level');
  const permissions = here.body.readUInt32BE(104);
  // Native Tcl000c0003 actorCan* reads these distinct PlayerPermFlags masks.
  for (const mask of [16, 32, 64, 128, 512, 1024, 2048, 4096, 8192, 16384, 524288, 1048576, 2097152]) {
    assert.equal(permissions & mask, mask, `ordinary action permission ${mask}`);
  }
  assert.equal(permissions & 15, 0, 'ordinary clients receive no staff permission bits');
});

test('get-real relocation commits actor class, head, location and nested possessions together before reply', async t => {
  const f = await fixture(t), profile = f.store.getAvatar(f.avatar.id);
  f.store.transaction(draft => {
    draft.avatars[profile.id].role = 'builder';
    draft.objects[profile.objectId].fields.health = 117;
    // A previously materialized avatar retains possessions while ghosted.
    draft.objects[profile.objectId].capacity = 10;
  });
  const bag = f.store.createObject({ classNumber: 36, regionId: 1, containerId: profile.objectId,
    ownerId: profile.id, capacity: 2, fields: { name: 'Travel bag', position: [4, 0, 0] } });
  const note = f.store.createObject({ classNumber: 37, regionId: 1, containerId: bag.id,
    ownerId: profile.id, fields: { name: 'Keepsake', position: [0, 0, 0] } });
  const request = { noid: 0, id: 124, payload: f.runtime.registry.encodeMessage(124, {
    avatar_name: profile.name, address: '2', areaCode: 0, goto_reggroup: 0, get_real: 1,
  }) };
  const before = f.store.snapshot(), saved = fs.readFileSync(f.store.filename);
  const rename = fs.renameSync;
  let fail = true;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (fail && destination === f.store.filename) {
      const error = new Error('injected get-real persistence failure'); error.code = 'EACCES'; throw error;
    }
    return rename(source, destination);
  });
  await f.runtime.handle(f.session, request);
  const rejected = frames(f.session.sent);
  assert.ok(rejected.some(message => message.id === 70 && message.body.readUInt16BE(0) !== 0));
  assert.equal(rejected.some(message => message.id === 70 && message.body.readUInt16BE(0) === 0), false);
  assert.equal(rejected.some(message => [101, 145, 160].includes(message.id)), false, 'no uncommitted scene or delta');
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(fs.readFileSync(f.store.filename), saved);
  assert.equal(f.session.regionId, 1);
  assert.equal(f.store.getObject(profile.objectId).classNumber, 22);
  fail = false; f.session.sent.length = 0;
  const sends = f.session.send.bind(f.session);
  f.session.send = bytes => {
    if (bytes.readUInt16BE(2) === 70 && bytes.readUInt16BE(8) === 0) {
      const durable = JSON.parse(fs.readFileSync(f.store.filename, 'utf8'));
      assert.equal(durable.avatars[profile.id].regionId, 2, 'success sees committed location on disk');
      assert.equal(durable.objects[profile.objectId].classNumber, 21, 'success sees committed actor mode on disk');
    }
    sends(bytes);
  };
  await f.runtime.handle(f.session, request);
  const accepted = frames(f.session.sent), ack = accepted.findIndex(message => message.id === 70 && message.body.readUInt16BE(0) === 0);
  assert.ok(ack >= 0);
  assert.ok(accepted.findIndex(message => [101, 145, 160].includes(message.id)) > ack, 'success precedes view publication');
  assert.equal(f.session.regionId, 2);
  const current = f.store.getAvatar(profile.id), actor = f.store.getObject(profile.objectId);
  assert.equal(current.ghost, false); assert.equal(current.regionId, 2);
  assert.equal(actor.classNumber, 21); assert.equal(actor.fields.health, 117, 'mode changes preserve persisted native health');
  for (const object of [actor, f.store.getObject(bag.id), f.store.getObject(note.id)]) assert.equal(object.regionId, 2);
  assert.equal(f.store.listObjects({ containerId: actor.id }).filter(object => object.classNumber === 24).length, 1);
  const reopened = new WorldStore(f.dataDir);
  try {
    assert.equal(reopened.getAvatar(profile.id).ghost, false);
    assert.equal(reopened.getObject(profile.objectId).classNumber, 21);
    assert.equal(reopened.getObject(note.id).regionId, 2);
  } finally { reopened.close(); }
});

test('physical compass travel enters the opposite scene edge with the appropriate native facing', async t => {
  const f = await fixture(t);
  await f.runtime.setActorMode(f.session, 'avatar');
  f.store.transaction(draft => { draft.regions[1].exits = { north: 2, east: 2, south: 2, west: 2 }; });
  const expected = [[170, 48, 0], [48, 350, 0], [170, 464, 0], [464, 350, 0]];
  for (let exitDir = 0; exitDir < 4; exitDir++) {
    await f.runtime.teleport(f.session, 1, { coords: [170, 350, 12] });
    f.session.sent.length = 0;
    await f.runtime.handle(f.session, { noid: 0, id: 103,
      payload: f.runtime.registry.encodeMessage(103, { exitDir }) });
    const actor = f.runtime.actorObject(f.session), profile = f.runtime.profile(f.session);
    assert.equal(f.session.regionId, 2);
    assert.deepEqual(actor.fields.position, expected[exitDir], `entry after exit ${exitDir}`);
    assert.deepEqual(profile.position, expected[exitDir], 'durable profile agrees with native actor');
    assert.equal(actor.fields.orientation, [2, 1, 0, 3][exitDir]);
    const sent = frames(f.session.sent);
    assert.equal(sent.find(message => message.id === 70).body.readUInt16BE(0), 0);
    assert.ok(sent.find(message => message.id === 101), 'new scene carries the authoritative entry position');
  }
  const reopened = new WorldStore(f.dataDir);
  try { assert.deepEqual(reopened.getObject(f.runtime.actorObject(f.session).id).fields.position, expected[3]); }
  finally { reopened.close(); }
});

test('directional entry respects room bounds while ghosts and address travel retain their ordinary destination', async t => {
  const f = await fixture(t);
  f.store.transaction(draft => { Object.assign(draft.regions[2].properties, { width: 300, height: 200 }); });
  await f.runtime.teleport(f.session, 2, { exitDir: 2 });
  assert.deepEqual(f.runtime.actorObject(f.session).fields.position, [256, 220, 0], 'ghost travel has no physical edge placement');
  await f.runtime.teleport(f.session, 1);
  await f.runtime.setActorMode(f.session, 'avatar');
  await f.runtime.teleport(f.session, 2, { exitDir: 2 });
  assert.deepEqual(f.runtime.actorObject(f.session).fields.position, [252, 152, 0], 'entry uses destination dimensions and clamps the cross-axis');
  await f.runtime.teleport(f.session, 1);
  assert.deepEqual(f.runtime.actorObject(f.session).fields.position, [256, 220, 0], 'teleports have no compass-side assumption');
  const before = f.store.snapshot();
  await assert.rejects(f.runtime.prepareTeleport(f.session, 2, { exitDir: 4 }), /Invalid exit direction/);
  assert.deepEqual(f.store.snapshot(), before);
});

test('materialization uses native default colors and keeps customized colors through a ghost cycle', async t => {
  const f = await fixture(t);
  await f.runtime.setActorMode(f.session, 'avatar');
  const actor = f.runtime.actorObject(f.session);
  assert.deepEqual(actor.fields.colorMap, Array(16).fill(0));
  const head = f.store.listObjects({ containerId: actor.id }).find(object => object.classNumber === 24);
  assert.deepEqual(head.fields.colorMap, Array(16).fill(0));
  const custom = Array(16).fill(55);
  f.store.transaction(draft => { draft.objects[actor.id].fields.colorMap = custom; });
  await f.runtime.setActorMode(f.session, 'ghost');
  await f.runtime.setActorMode(f.session, 'avatar');
  assert.deepEqual(f.runtime.actorObject(f.session).fields.colorMap, custom);
});
