/** Failure-path regressions using isolated state and no TCP listeners. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCompatibilityServer } from './helpers/fixtures.mjs';

const clientDir = fileURLToPath(new URL('../../wa', import.meta.url));

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-runtime-safety-'));
  let now = 1000;
  const server = createCompatibilityServer({ dataDir, clientDir, now: () => now,
    httpPort: 0, worldPort: 0, rpcPort: 0 });
  const account = server.store.account('demo'), avatar = server.store.listAvatars(account)[0];
  server.worldStore.ensureAvatar(avatar, { classNumber: 21 });
  const session = { account, avatar, closed: false, sent: [],
    send(bytes) { this.sent.push(Buffer.from(bytes)); },
    end() { if (this.closed) return; this.closed = true; server.runtime.detach(this); server.sessions.delete(this); } };
  server.sessions.add(session);
  await server.runtime.attach(session);
  session.sent.length = 0;
  t.after(async () => { await server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { server, runtime: server.runtime, store: server.worldStore, account, avatar, session, dataDir,
    setNow(value) { now = value; } };
}

function emitted(session) {
  const data = Buffer.concat(session.sent), messages = [];
  for (let offset = 0; offset < data.length;) {
    assert(offset + 8 <= data.length, 'complete frame header');
    const length = data.readUInt32BE(offset + 4);
    assert(offset + 8 + length <= data.length, 'complete frame body');
    messages.push({ noid: data.readUInt16BE(offset), id: data.readUInt16BE(offset + 2), body: data.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  return messages;
}

function pendingEffect(f) {
  const profile = f.store.getAvatar(f.avatar.id);
  const timer = f.store.scheduleTimer(profile.objectId, 'special-effect-expire', 1000,
    { avatarId: profile.id, effect: 'invisibility', effectId: 321, previous: { visibilityBit: 0 } });
  f.store.transaction(draft => {
    draft.avatars[profile.id].effects = { invisibility: { id: 321 } };
    draft.objects[profile.objectId].fields.common_flags = 1;
  });
  return { profile, timer };
}

test('failed timer commit retains its job and later work can retry through the same runtime queue', async t => {
  const f = await fixture(t), { profile, timer } = pendingEffect(f);
  const original = f.store.transaction.bind(f.store);
  let fail = true;
  t.mock.method(f.store, 'transaction', (fn, metadata) => {
    if (fail && metadata?.action === 'timer-fired') throw new Error('injected timer persistence failure');
    return original(fn, metadata);
  });
  await assert.rejects(f.runtime.tick(), /injected timer persistence failure/);
  assert.ok(f.store.snapshot().timers[timer.id]);
  assert.equal(f.store.getObject(profile.objectId).fields.common_flags & 1, 1);
  fail = false;
  await f.runtime.tick();
  assert.equal(f.store.snapshot().timers[timer.id], undefined);
  assert.equal(f.store.getObject(profile.objectId).fields.common_flags & 1, 0);
  assert.equal(f.store.getAvatar(profile.id).effects.invisibility, undefined);
});

test('server close releases account lock despite a failed queued timer and permits reopening state', async t => {
  const f = await fixture(t), { timer } = pendingEffect(f);
  const original = f.store.transaction.bind(f.store);
  t.mock.method(f.store, 'transaction', (fn, metadata) => {
    if (metadata?.action === 'timer-fired') throw new Error('injected shutdown timer failure');
    return original(fn, metadata);
  });
  await assert.rejects(f.runtime.tick(), /injected shutdown timer failure/);
  await f.server.close();
  assert.equal(fs.existsSync(path.join(f.dataDir, 'server.lock')), false);
  const reopened = createCompatibilityServer({ dataDir: f.dataDir, clientDir,
    httpPort: 0, worldPort: 0, rpcPort: 0, now: () => 1000 });
  try { assert.ok(reopened.worldStore.snapshot().timers[timer.id]); }
  finally { await reopened.close(); }
});

test('shutdown cleanup failure still closes the world store and releases the account directory lock', async t => {
  const f = await fixture(t);
  t.mock.method(f.store, 'finalizePendingRegions', () => { throw new Error('injected retirement cleanup failure'); });
  await assert.rejects(f.server.close(), /injected retirement cleanup failure/);
  assert.equal(f.store.closed, true);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'server.lock')), false);
});

test('a failed native passage commit sends no success acknowledgement or region scene and leaves inventory in place', async t => {
  const f = await fixture(t), profile = f.store.getAvatar(f.avatar.id);
  const bag = f.store.createObject({ classNumber: 36, regionId: 1, containerId: profile.objectId,
    ownerId: profile.id, capacity: 1, fields: { name: 'Bag', position: [4, 0, 0] } });
  const note = f.store.createObject({ classNumber: 37, regionId: 1, containerId: bag.id,
    ownerId: profile.id, fields: { name: 'Note', position: [0, 0, 0] } });
  const cash = f.store.createObject({ classNumber: 26, regionId: 1, containerId: profile.objectId,
    ownerId: profile.id, fields: { name: 'Tokens', position: [0, 0, 0], denom: 20 } });
  const passage = f.store.createObject({ classNumber: 56, regionId: 1, portable: false,
    fields: { name: 'Garden teleport', position: [256, 220, 0], common_flags: 0, rideCost: 5 } });
  const noid = f.runtime.objectNoid(f.session, passage.id);
  const original = fs.renameSync;
  let fail = true;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (fail && destination === f.store.filename) throw new Error('injected travel persistence failure');
    return original(source, destination);
  });
  f.session.sent.length = 0;
  await f.runtime.handle(f.session, { noid, id: 1202, payload: Buffer.from('2\0') });
  const rejected = emitted(f.session);
  assert.ok(rejected.some(message => message.id === 70), 'native request receives a failure reply');
  assert.ok(rejected.filter(message => message.id === 70).every(message => message.body.readUInt16BE(0) !== 0), 'no success before durable travel commit');
  assert.ok(!rejected.some(message => message.id === 101 || message.id === 145), 'failed travel cannot publish a new scene');
  assert.equal(f.session.regionId, 1); assert.equal(f.store.getAvatar(profile.id).regionId, 1);
  for (const objectId of [profile.objectId, bag.id, note.id, cash.id]) assert.equal(f.store.getObject(objectId).regionId, 1);
  assert.equal(f.store.getObject(cash.id).fields.denom, 20, 'failed travel cannot charge a fare');
  fail = false; f.session.sent.length = 0;
  await f.runtime.handle(f.session, { noid, id: 1202, payload: Buffer.from('2\0') });
  const accepted = emitted(f.session), successIndex = accepted.findIndex(message => message.id === 70 && message.body.readUInt16BE(0) === 0);
  const sceneIndex = accepted.findIndex(message => message.id === 101 || message.id === 145);
  assert.ok(successIndex >= 0); assert.ok(sceneIndex > successIndex, 'native acknowledgement precedes publication after durable commit');
  assert.equal(f.session.regionId, 2); assert.equal(f.store.getAvatar(profile.id).regionId, 2);
  for (const objectId of [profile.objectId, bag.id, note.id, cash.id]) assert.equal(f.store.getObject(objectId).regionId, 2);
  assert.equal(f.store.getObject(cash.id).fields.denom, 15, 'successful retry charges exactly once');
});

test('runtime action RNG returns bounded integers rather than fractions', async t => {
  const f = await fixture(t), context = f.runtime.context(f.session);
  for (const maximum of [1, 2, 6, 100, 65535]) {
    for (let sample = 0; sample < 30; sample++) {
      const value = context.random(maximum);
      assert.ok(Number.isInteger(value), `integer RNG result for bound ${maximum}`);
      assert.ok(value >= 0 && value < maximum, `RNG result is below exclusive bound ${maximum}`);
    }
  }
});
