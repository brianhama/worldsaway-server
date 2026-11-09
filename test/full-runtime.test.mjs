/** Independent persistent/multiplayer protocol checks; no original client execution. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ResourceStore } from './helpers/fixtures.mjs';
import { buildFeatureCoverage, extractRequestCandidates } from '../dist/src/coverage.js';
import { createCompatibilityServer } from './helpers/fixtures.mjs';

const clientDir = fileURLToPath(new URL('../../wa', import.meta.url));

test('feature ledger inventories every supplied class without calling schemas complete behavior', () => {
  const resources = new ResourceStore({ clientDir });
  const ledger = buildFeatureCoverage(resources);
  assert.equal(ledger.summary.classes, 58);
  assert.equal(ledger.summary.messageSchemas, 710);
  assert.equal(ledger.summary.methods, 469);
  assert.equal(ledger.summary.libraries, 24);
  assert.equal(ledger.summary.literalRequestCandidates, 258);
  assert.equal(ledger.summary.uniqueLiteralRequestIds, 197);
  assert.equal(ledger.classes.find(item => item.classNumber === 20)?.name, 'Region');
  assert.equal(ledger.classes.find(item => item.classNumber === 21)?.name, 'Avatar');
  assert.equal(ledger.classes.find(item => item.classNumber === 215)?.name, 'Decorator');
  assert.equal(new Set(ledger.classes.map(item => item.classNumber)).size, 58);
  assert.equal(ledger.allOriginalBehaviorImplemented, false);
  assert(ledger.classes.every(item => item.structuralStatus === 'schema-present' && item.behaviorComplete === false));
  assert(ledger.summary.unimplementedLiteralIds.includes(72));
});

test('literal contract extraction preserves nested Tcl words, reply IDs and uncertainty', () => {
  const source = `request $self 26 {newName [format {%s} $name]} 70\n`
    + `# request $self 999 {unused 0} 70\n`
    + `request $actor 1570 {coords {1 2 3}} 1571\n`
    + `request $self 76 $dynamic $reply\n`;
  const rows = extractRequestCandidates(source, 'fixture');
  assert.deepEqual(rows.map(item => item.requestId), [26, 999, 1570, 76]);
  assert.deepEqual(rows.map(item => item.replyId), [70, 70, 1571, null]);
  assert.equal(rows[1].commentedLine, true);
  assert.equal(rows[2].targetExpression, '$actor');
  assert.equal(rows[3].bodyKind, 'dynamic');
  assert.equal(rows[2].line, 3);
});

test('handler IDs do not falsely cover another class or unresolved request receiver', () => {
  const resources = new ResourceStore({ clientDir });
  const ledger = buildFeatureCoverage(resources, { handlers: [
    { id: 26, name: 'region-rename', classNumbers: [20], replyId: 70 },
    { id: 1575, name: 'avatar-manipulate', classNumbers: [21], replyId: 70 },
  ] });
  const region = ledger.classes.find(item => item.classNumber === 20);
  const object = ledger.classes.find(item => item.classNumber === 27);
  assert.equal(region.contracts.find(item => item.requestId === 26)?.status, 'handler-declared');
  assert.equal(object.contracts.find(item => item.requestId === 26)?.status, 'unimplemented');
  const actorCall = ledger.classes.flatMap(item => item.contracts).find(item => item.requestId === 1575 && item.targetExpression === '$actor');
  assert.equal(actorCall?.implementedId, true);
  assert.equal(actorCall?.status, 'receiver-unresolved');
  assert.equal(ledger.allOriginalBehaviorImplemented, false);
});

function fixed(value, size) {
  const result = Buffer.alloc(size); assert(Buffer.byteLength(value, 'ascii') < size); result.write(value, 'ascii'); return result;
}
function packet(noid, id, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(8); header.writeUInt16BE(noid, 0); header.writeUInt16BE(id, 2); header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
function packets(data) {
  const result = [];
  for (let cursor = 0; cursor < data.length;) {
    assert(cursor + 8 <= data.length, 'partial header');
    const size = data.readUInt32BE(cursor + 4); assert(cursor + 8 + size <= data.length, 'partial body');
    result.push({ noid: data.readUInt16BE(cursor), id: data.readUInt16BE(cursor + 2), body: data.subarray(cursor + 8, cursor + 8 + size) });
    cursor += 8 + size;
  }
  return result;
}
function expandCv(data) {
  assert(data.length >= 4); const expected = data.readUInt32BE(0), result = [];
  for (let cursor = 4; cursor < data.length; cursor++) {
    if (data[cursor] !== 255) result.push(data[cursor]);
    else {
      assert(++cursor < data.length); const count = data[cursor];
      if (count === 255) result.push(255); else result.push(...Array(count).fill(0));
    }
    assert(result.length <= expected);
  }
  assert.equal(result.length, expected); return Buffer.from(result);
}
function cvObjects(compressed) {
  const cv = expandCv(compressed);
  const objects = [];
  for (let cursor = 0; cursor < cv.length;) {
    const size = cv.readUInt16BE(cursor); cursor += 2; assert(size >= 44 && cursor + size <= cv.length);
    const body = cv.subarray(cursor, cursor + size); cursor += size;
    objects.push({ body, classNumber: body.readUInt16BE(0), name: body.subarray(4, 36).toString('latin1').split('\0')[0], noid: body.readUInt16BE(40), containerNoid: body.readUInt16BE(42),
      position: body.length >= 50 ? [body.readInt16BE(44), body.readInt16BE(46), body.readInt16BE(48)] : null });
  }
  return objects;
}
function sceneObjects(list) {
  const here = list.filter(item => item.id === 101).at(-1); assert(here, 'full region snapshot required');
  assert(here.body.length >= 116); return cvObjects(here.body.subarray(112));
}
function coords(values) {
  const body = Buffer.alloc(6); values.forEach((value, index) => body.writeInt16BE(value, index * 2)); return body;
}
function captured(server) {
  let chunks = [];
  const connection = server.createWorldSession(bytes => chunks.push(Buffer.from(bytes)), () => {});
  return { connection, actorNoid: 15,
    take() { const result = packets(Buffer.concat(chunks)); chunks = []; return result; },
    async send(noid, id, body) { await connection.feed(packet(noid, id, body)); return this.take(); } };
}
async function openClient(server, account, password, avatar) {
  const response = await server.handleHttpRequest({ method: 'POST', path: '/connect.iv',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: Buffer.from(new URLSearchParams({ account, password, avatar }).toString()) });
  assert.equal(response.status, 200, response.body.toString());
  const values = Object.fromEntries(response.body.toString('ascii').split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  const login = Buffer.alloc(288); fixed(account, 256).copy(login); fixed(values.onetimepass, 16).copy(login, 256);
  login.writeUInt16BE(2, 278); login.writeUInt16BE(325, 280);
  const entry = Buffer.alloc(72); fixed(avatar, 32).copy(entry); entry.writeUInt32BE(1, 32);
  const client = captured(server);
  await client.connection.feed(Buffer.concat([packet(10, 11, login), packet(10, 13, entry)]));
  const initial = client.take(); const here = initial.filter(item => item.id === 101).at(-1);
  assert(here, 'persistent runtime should emit a scene'); client.actorNoid = here.body.readUInt16BE(96); client.initial = initial;
  return client;
}
async function materialize(client) {
  if (client.actorNoid !== 15) return;
  const response = (await client.send(client.actorNoid, 2005, coords([250, 220, 0]))).find(item => item.id === 2006);
  assert(response, 'native materialize reply'); assert.equal(response.body.readUInt16BE(0), 0);
  client.actorNoid = response.body.readUInt16BE(2);
  assert.notEqual(client.actorNoid, 15, 'Avatar actor must not retain reserved Ghost noid');
}
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-full-runtime-'));
  let server = createCompatibilityServer({ clientDir, dataDir, httpPort: 0, worldPort: 0, rpcPort: 0 });
  t.after(async () => { await server.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  assert(server.worldStore && server.runtime, 'persistent multiplayer runtime must be installed');
  const aliceAccount = server.store.createAccount('alice', 'pw');
  const bobAccount = server.store.createAccount('bob', 'pw');
  const alice = server.store.createAvatar(aliceAccount, 'Alice');
  const bob = server.store.createAvatar(bobAccount, 'Bob');
  return { get server() { return server; }, alice, bob, dataDir,
    async restart() { await server.close(); server = createCompatibilityServer({ clientDir, dataDir, httpPort: 0, worldPort: 0, rpcPort: 0 }); return server; } };
}

test('two clients see an Avatar speech/move and cannot move someone else; position survives restart', async t => {
  const f = await fixture(t);
  const alice = await openClient(f.server, 'alice', 'pw', 'Alice');
  const bob = await openClient(f.server, 'bob', 'pw', 'Bob');
  assert(sceneObjects(bob.initial).some(object => object.name === 'Alice'), 'late join must include existing player');
  alice.take(); await materialize(alice);
  const bobAfterMode = bob.take();
  const remoteAlice = sceneObjects(bobAfterMode).find(object => object.classNumber === 21 && object.name === 'Alice');
  assert(remoteAlice, 'materialized Avatar must appear in the other client scene');
  const walk = await alice.send(alice.actorNoid, 1570, coords([123, 210, 0]));
  const walked = walk.find(item => item.id === 1571); assert(walked); assert.equal(walked.body.readUInt16BE(0), 0);
  assert.deepEqual([walked.body.readInt16BE(2), walked.body.readInt16BE(4), walked.body.readInt16BE(6)], [123, 210, 0]);
  const movement = bob.take().find(item => item.id === 1572); assert(movement);
  assert.equal(movement.noid, remoteAlice.noid); assert.deepEqual([...movement.body], [...coords([123, 210, 0])]);
  const speech = Buffer.concat([Buffer.alloc(4), Buffer.from('A real shared room\0')]);
  const said = (await alice.send(alice.actorNoid, 72, speech)).find(item => item.id === 73);
  assert(said); assert.equal(said.body.readUInt16BE(0), 0); assert.equal(said.body.subarray(8).toString('latin1'), 'A real shared room\0');
  const heard = bob.take().find(item => item.id === 74); assert(heard);
  assert.equal(heard.noid, remoteAlice.noid); assert.equal(heard.body.subarray(8).toString('latin1'), 'A real shared room\0');
  const denied = (await bob.send(remoteAlice.noid, 1570, coords([400, 200, 0]))).find(item => item.id === 1571);
  assert(denied); assert.notEqual(denied.body.readUInt16BE(0), 0);
  const profile = f.server.worldStore.getAvatar(f.alice.id);
  assert.deepEqual(f.server.worldStore.getObject(profile.objectId).fields.position, [123, 210, 0]);
  await f.restart();
  const again = await openClient(f.server, 'alice', 'pw', 'Alice');
  const own = sceneObjects(again.initial).find(object => object.noid === again.actorNoid);
  assert.equal(own?.classNumber, 21); assert.deepEqual(own.position, [123, 210, 0]);
});

test('offline mail is committed before success, survives restart, and is read only by its owner', async t => {
  const f = await fixture(t);
  f.server.worldStore.ensureAvatar(f.bob);
  const alice = await openClient(f.server, 'alice', 'pw', 'Alice');
  const body = Buffer.from('Bob\0Durable mail from Alice\0');
  const sent = (await alice.send(0, 244, body)).find(item => item.id === 70);
  assert(sent); assert.equal(sent.body.readUInt16BE(0), 0);
  assert.equal(f.server.worldStore.listMail(f.bob.id)[0]?.body, 'Durable mail from Alice');
  assert.equal(f.server.worldStore.listMail(f.alice.id).length, 0);
  await f.restart();
  assert.equal(f.server.worldStore.listMail(f.bob.id)[0]?.body, 'Durable mail from Alice');
  const bob = await openClient(f.server, 'bob', 'pw', 'Bob');
  const received = (await bob.send(0, 247, Buffer.alloc(2))).find(item => item.id === 246);
  assert(received); assert.equal(received.body.readUInt16BE(0), 0);
  assert(received.body.toString('latin1').includes('Durable mail from Alice'));
  assert.notEqual(f.server.worldStore.listMail(f.bob.id)[0].readAt, null);
});

test('unprivileged builder requests cannot create objects or trust client permission flags', async t => {
  const f = await fixture(t);
  const alice = await openClient(f.server, 'alice', 'pw', 'Alice');
  const before = Object.keys(f.server.worldStore.snapshot().objects).length;
  const create = Buffer.alloc(8); create.writeUInt16BE(27, 0); create.writeInt16BE(150, 2); create.writeInt16BE(200, 4); create.writeUInt16BE(1, 6);
  const denied = (await alice.send(0, 200, create)).find(item => item.id === 70);
  assert(denied); assert.notEqual(denied.body.readUInt16BE(0), 0);
  assert.equal(Object.keys(f.server.worldStore.snapshot().objects).length, before);
  assert.equal(f.server.worldStore.getAvatar(f.alice.id).role, 'player');
});

test('native pickup enforces ownership and held inventory survives a full server restart', async t => {
  const f = await fixture(t);
  const aliceProfile = f.server.worldStore.ensureAvatar(f.alice);
  f.server.worldStore.ensureAvatar(f.bob);
  const keepsake = f.server.worldStore.createObject({ classNumber: 27, regionId: aliceProfile.regionId,
    ownerId: f.alice.id, portable: true, fields: { name: 'Alice keepsake', position: [180, 210, 0], imageURL: 'o.bookopen.img' } });
  const alice = await openClient(f.server, 'alice', 'pw', 'Alice');
  const bob = await openClient(f.server, 'bob', 'pw', 'Bob');
  await materialize(alice); await materialize(bob);
  const itemNoid = sceneObjects(alice.take()).find(object => object.name === 'Alice keepsake')?.noid;
  assert(Number.isInteger(itemNoid));
  const get = Buffer.alloc(4); get.writeUInt16BE(itemNoid, 0);
  const denied = (await bob.send(bob.actorNoid, 1575, get)).find(item => item.id === 70);
  assert(denied); assert.notEqual(denied.body.readUInt16BE(0), 0);
  assert.equal(f.server.worldStore.getObject(keepsake.id).containerId, null);
  const pickupFrames = await alice.send(alice.actorNoid, 1575, get);
  assert(!pickupFrames.some(item => [145, 101].includes(item.id)), 'ordinary pickup must not reset the sender native CV/thread context');
  const peerFrames = bob.take();
  assert(!peerFrames.some(item => [145, 101].includes(item.id)), 'ordinary pickup must use peer notices/CV deltas rather than NewCV');
  const got = pickupFrames.find(item => item.id === 70);
  assert(got); assert.equal(got.body.readUInt16BE(0), 0);
  const profile = f.server.worldStore.getAvatar(f.alice.id);
  assert.equal(f.server.worldStore.getObject(keepsake.id).containerId, profile.objectId);
  assert.equal(f.server.worldStore.getObject(keepsake.id).ownerId, f.alice.id);
  assert.deepEqual(f.server.worldStore.getObject(keepsake.id).fields.position, [0, 0, 0]);
  await f.restart();
  const restored = await openClient(f.server, 'alice', 'pw', 'Alice');
  const held = sceneObjects(restored.initial).find(object => object.name === 'Alice keepsake');
  assert(held); assert.equal(held.containerNoid, restored.actorNoid); assert.deepEqual(held.position, [0, 0, 0]);
  assert.equal(f.server.worldStore.getObject(keepsake.id).ownerId, f.alice.id);
});

test('HereIs exposes native action/status gates and persisted staff levels without trusting stale session roles', async t => {
  const f = await fixture(t);
  const profile = f.server.worldStore.ensureAvatar(f.alice);
  f.server.worldStore.transaction(draft => {
    draft.avatars[f.alice.id].preferences.flags = 1024 | 512;
    draft.regions[profile.regionId].properties.housing = { ownerId: f.alice.id, coOwnerIds: [] };
  });
  const alice = await openClient(f.server, 'alice', 'pw', 'Alice');
  const player = alice.initial.filter(item => item.id === 101).at(-1).body;
  const flags = player.readUInt32BE(104);
  // Exact actorCan* predicates in original library000c0003, lines589–664.
  for (const bit of [16, 32, 64, 128, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
    131072, 262144, 524288, 1048576, 2097152, 8388608]) assert.equal(flags & bit, bit, `missing native capability ${bit}`);
  assert.equal(flags & 0x0100000f, 0, 'ordinary players must not advertise staff abilities');
  assert.equal(player.readUInt16BE(100), 10);
  assert.equal(player.readUInt16BE(98) & (1024 | 512 | 16), 1024 | 512 | 16, 'saved mail state and current locale ownership must reach PlayerFlags');
  const mode = (await alice.send(alice.actorNoid, 2005, coords([250, 220, 0]))).find(item => item.id === 2006);
  assert(mode); assert.equal(mode.body.readUInt16BE(0), 0); alice.actorNoid = mode.body.readUInt16BE(2);
  const materialized = cvObjects(mode.body.subarray(12, 12 + mode.body.readUInt32BE(8)));
  const actor = materialized.find(object => object.classNumber === 21); assert(actor);
  assert.equal(actor.body.readUInt16BE(120), 10, 'Avatar reducedCapacity is an exclusive usable-slot upper bound');
  const head = materialized.find(object => object.classNumber === 24 && object.containerNoid === alice.actorNoid); assert(head);
  assert.deepEqual(head.position, [1, 0, 0], 'the worn head belongs in slot1, leaving the hand at slot0');
  f.server.worldStore.transaction(draft => { draft.avatars[f.alice.id].role = 'builder'; });
  await f.server.runtime.sendScene(alice.connection);
  const builder = alice.take().filter(item => item.id === 101).at(-1).body;
  assert.equal(builder.readUInt16BE(100), 2000, 'Oracle UI threshold is2000');
  assert.equal(builder.readUInt32BE(104) & 1, 1);
  assert.equal(builder.readUInt32BE(104) & 0x0100000e, 0);
  f.server.worldStore.transaction(draft => { draft.avatars[f.alice.id].role = 'admin'; });
  await f.server.runtime.sendScene(alice.connection);
  const adminFrames = alice.take(), admin = adminFrames.filter(item => item.id === 101).at(-1).body;
  assert.equal(admin.readUInt16BE(100), 3000, 'Dog UI threshold is3000');
  assert.equal(admin.readUInt32BE(104) & 0x0100000f, 0x0100000f);
  const chest = sceneObjects(adminFrames).find(object => object.name === 'Community chest'); assert(chest);
  f.server.worldStore.transaction(draft => { draft.avatars[f.alice.id].role = 'player'; });
  const renamed = (await alice.send(chest.noid, 26, Buffer.from('Taken over\0'))).find(item => item.id === 70);
  assert(renamed); assert.notEqual(renamed.body.readUInt16BE(0), 0, 'current persisted authority must override the stale admin session profile');
  assert.equal(f.server.worldStore.listObjects().find(object => object.fields.name === 'Taken over'), undefined);
});

test('archiving a container excludes its descendants from scenes and native object lookup', async t => {
  const f = await fixture(t);
  const profile = f.server.worldStore.ensureAvatar(f.alice);
  const parent = f.server.worldStore.createObject({ classNumber: 36, regionId: profile.regionId, ownerId: profile.id,
    capacity: 10, fields: { name: 'Archived parent', imageURL: 'o.chest5.img', position: [180, 210, 0], reducedCapacity: 10 } });
  const child = f.server.worldStore.createObject({ classNumber: 27, regionId: profile.regionId, ownerId: profile.id,
    containerId: parent.id, fields: { name: 'Archived child', imageURL: 'o.bookopen.img', position: [0, 0, 0] } });
  f.server.worldStore.transaction(draft => { draft.objects[parent.id].archivedIn = 'test-archive'; });
  const alice = await openClient(f.server, 'alice', 'pw', 'Alice');
  assert(!sceneObjects(alice.initial).some(object => ['Archived parent', 'Archived child'].includes(object.name)));
  assert.equal(f.server.runtime.visible(alice.connection, f.server.worldStore.getObject(child.id)), false);
  const allocatedNoid = f.server.runtime.regionMap(profile.regionId).forward.get(child.id);
  assert(Number.isInteger(allocatedNoid)); assert.equal(f.server.runtime.resolveObject(alice.connection, allocatedNoid), null);
});

test('full-class health remains within the Windows launcher 4096-byte response bound', async t => {
  const f = await fixture(t);
  const response = await f.server.handleHttpRequest({ path: '/health' });
  assert.equal(response.status, 200); assert(response.body.length <= 4096);
  const health = JSON.parse(response.body.toString());
  assert.equal(health.status, 'ok'); assert.match(health.resourceProfile, /^[a-f0-9]{64}$/);
  assert.equal(f.server.resources.summary.sceneOverrides.length, 8);
});

test('changed inventory values synchronize through Region81 deltas without NewCV thread resets', async t => {
  const f = await fixture(t);
  const alice = await openClient(f.server, 'alice', 'pw', 'Alice');
  await materialize(alice);
  const profile = f.server.worldStore.getAvatar(f.alice.id);
  const reserve = f.server.worldStore.createObject({ classNumber: 26, regionId: profile.regionId,
    ownerId: profile.id, containerId: profile.objectId, fields: { name: 'Pocket reserve', position: [2, 0, 0], denom: 100 } });
  const held = f.server.worldStore.createObject({ classNumber: 26, regionId: profile.regionId,
    ownerId: profile.id, containerId: profile.objectId, fields: { name: 'Held tokens', position: [0, 0, 0], denom: 10 } });
  await f.server.runtime.refreshRegion(profile.regionId);
  const installed = alice.take();
  assert(!installed.some(item => [145, 101].includes(item.id)));
  const objects = installed.filter(item => item.id === 81).flatMap(item => cvObjects(item.body.subarray(4)));
  const target = objects.find(object => object.name === 'Pocket reserve'); assert(target);
  const amount = Buffer.alloc(4); amount.writeInt32BE(25);
  const changed = await alice.send(target.noid, 1139, amount);
  const result = changed.find(item => item.id === 1142); assert(result); assert.equal(result.body.readUInt16BE(0), 0);
  assert(!changed.some(item => [145, 101].includes(item.id)), 'ordinary state changes must not destroy native request contexts');
  const deltas = changed.filter(item => item.id === 81).flatMap(item => cvObjects(item.body.subarray(4)));
  assert.equal(deltas.find(object => object.name === 'Pocket reserve')?.body.readInt32BE(152), 75);
  assert.equal(deltas.find(object => object.name === 'Held tokens')?.body.readInt32BE(152), 35);
  assert.equal(f.server.worldStore.getObject(reserve.id).fields.denom, 75);
  assert.equal(f.server.worldStore.getObject(held.id).fields.denom, 35);
  assert.equal(f.server.worldStore.getAvatar(profile.id).balance, 1000);
});

test('native region exit carries owned inventory and reconnect restores the destination', async t => {
  const f = await fixture(t);
  const profile = f.server.worldStore.ensureAvatar(f.alice);
  const charm = f.server.worldStore.createObject({ classNumber: 27, regionId: profile.regionId,
    ownerId: profile.id, fields: { name: 'Travel charm', position: [180, 210, 0], imageURL: 'o.bookopen.img' } });
  const alice = await openClient(f.server, 'alice', 'pw', 'Alice');
  const itemNoid = sceneObjects(alice.initial).find(object => object.name === 'Travel charm')?.noid;
  assert(Number.isInteger(itemNoid)); await materialize(alice);
  const get = Buffer.alloc(4); get.writeUInt16BE(itemNoid);
  const pickedUp = (await alice.send(alice.actorNoid, 1575, get)).find(item => item.id === 70);
  assert.equal(pickedUp?.body.readUInt16BE(0), 0);
  const exit = Buffer.alloc(2); // Direction0 is the authored north exit from the seeded lobby.
  const traveled = await alice.send(0, 103, exit);
  const result = traveled.find(item => item.id === 70); assert(result); assert.equal(result.body.readUInt16BE(0), 0);
  const destination = f.server.worldStore.getAvatar(f.alice.id).regionId;
  assert.equal(f.server.worldStore.getRegion(destination).name, 'Garden');
  assert.equal(f.server.worldStore.getObject(charm.id).regionId, destination);
  assert.equal(f.server.worldStore.getObject(charm.id).containerId, f.server.worldStore.getAvatar(f.alice.id).objectId);
  assert.equal(sceneObjects(traveled).find(object => object.noid === 0)?.name, 'Garden');
  await f.restart();
  const restored = await openClient(f.server, 'alice', 'pw', 'Alice');
  assert.equal(sceneObjects(restored.initial).find(object => object.noid === 0)?.name, 'Garden');
  assert.equal(sceneObjects(restored.initial).find(object => object.name === 'Travel charm')?.containerNoid, restored.actorNoid);
});

async function networkClient(server, account, avatar) {
  const form = new URLSearchParams({ account, password: 'pw', avatar }).toString();
  const handoff = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.addresses.httpPort,
      path: '/connect.iv', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('error', reject);
      response.on('end', () => { if (response.statusCode !== 200) reject(new Error(`HTTP ${response.statusCode}`)); else resolve(Buffer.concat(chunks)); });
    });
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('HTTP test timeout'))); request.end(form);
  });
  const values = Object.fromEntries(handoff.toString('ascii').split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  const socket = net.createConnection({ host: '127.0.0.1', port: server.addresses.worldPort });
  let buffer = Buffer.alloc(0), stopped = null;
  const messages = [], listeners = new Set();
  socket.on('error', error => { stopped = error; for (const listener of listeners) listener(); });
  socket.on('close', () => { stopped ??= new Error('World socket closed'); for (const listener of listeners) listener(); });
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const size = buffer.readUInt32BE(4); if (size > 16 * 1024 * 1024) { socket.destroy(new Error('Oversized test response')); return; }
      if (buffer.length < 8 + size) break;
      const message = { noid: buffer.readUInt16BE(0), id: buffer.readUInt16BE(2), body: Buffer.from(buffer.subarray(8, 8 + size)) };
      buffer = buffer.subarray(8 + size);
      if (message.id !== 17) messages.push(message); // Resource bytes have independent acceptance coverage.
    }
    for (const listener of listeners) listener();
  });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const client = { socket, actorNoid: 15, send(noid, id, body) { socket.write(packet(noid, id, body)); },
    wait(id) { return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timed out awaiting ${id}`)), 8000);
      const finish = (error, value) => { clearTimeout(timer); listeners.delete(check); if (error) reject(error); else resolve(value); };
      const check = () => { const index = messages.findIndex(item => item.id === id); if (index >= 0) { const value = messages[index]; messages.splice(0, index + 1); finish(null, value); } else if (stopped) finish(stopped); };
      listeners.add(check); check();
    }); } };
  const login = Buffer.alloc(288); fixed(account, 256).copy(login); fixed(values.onetimepass, 16).copy(login, 256);
  login.writeUInt16BE(2, 278); login.writeUInt16BE(325, 280);
  const entry = Buffer.alloc(72); fixed(avatar, 32).copy(entry); entry.writeUInt32BE(1, 32);
  client.send(10, 11, login); client.send(10, 13, entry);
  const scene = await client.wait(101); client.actorNoid = scene.body.readUInt16BE(96);
  return client;
}

test('two actual TCP clients materialize and exchange room speech when loopback binding is available', async t => {
  const f = await fixture(t);
  try { await f.server.start(); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip(`Host denies local multiplayer listeners: ${error.code}`); return; }
    throw error;
  }
  const alice = await networkClient(f.server, 'alice', 'Alice');
  const bob = await networkClient(f.server, 'bob', 'Bob');
  t.after(() => { alice.socket.destroy(); bob.socket.destroy(); });
  alice.send(alice.actorNoid, 2005, coords([250, 220, 0]));
  const materialized = await alice.wait(2006); assert.equal(materialized.body.readUInt16BE(0), 0);
  alice.actorNoid = materialized.body.readUInt16BE(2); assert.notEqual(alice.actorNoid, 15);
  const peerScene = await bob.wait(101); assert(sceneObjects([peerScene]).some(object => object.name === 'Alice' && object.classNumber === 21));
  alice.send(alice.actorNoid, 72, Buffer.concat([Buffer.alloc(4), Buffer.from('TCP shared room\0')]));
  const acknowledgement = await alice.wait(73), heard = await bob.wait(74);
  assert.equal(acknowledgement.body.readUInt16BE(0), 0);
  assert.equal(heard.body.subarray(8).toString('latin1'), 'TCP shared room\0');
});
