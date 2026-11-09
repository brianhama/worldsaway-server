import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BuilderActions, SUPPORTED_REQUESTS } from '../dist/src/builder-actions.js';
import { ResourceStore } from './helpers/fixtures.mjs';
import { ClassRegistry } from '../dist/src/classes.js';
import { WorldStore } from '../dist/src/world-store.js';

const clientDir = fileURLToPath(new URL('../../wa/', import.meta.url));
const resources = new ResourceStore({ clientDir });
const registry = resources ? new ClassRegistry(resources) : null;

function fixture(t, role = 'admin', classNumber = 22) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-builder-'));
  const store = new WorldStore(directory, { clock: () => 1000 });
  const profile = store.ensureAvatar({ id: 1, accountId: 1, name: 'Builder' }, { role, classNumber });
  const session = { avatar: { id: 1, name: 'Builder' }, role: 'admin', regionId: profile.regionId };
  const replies = [], refreshes = [];
  const resolveObject = (s, noid) => {
    const current = store.getAvatar(s.avatar.id);
    return noid === 0 ? store.getObject(store.getRegion(current.regionId).objectId) : store.getObject(noid - 100);
  };
  const context = { worldStore: store, registry, resources, now: () => 1000, resolveObject,
    nativeNoid: (s, object) => object.id + 100,
    contentsVector: () => Buffer.from([0, 0, 0, 0]),
    reply: async (s, noid, id, fields) => {
      // Every success and denial reply must survive its actual recovered schema.
      const bytes = registry.encodeMessage(id, fields);
      const decoded = registry.decodeMessage(id, bytes);
      replies.push({ noid, id, fields: { ...fields }, decoded });
    },
    refreshRegion: async regionId => refreshes.push(regionId),
  };
  const actions = new BuilderActions(context);
  const invoke = async (id, fields = {}, noid = 0) => {
    const result = await actions.handle(session, { noid, id, fields });
    return { handled: result, ...replies.at(-1) };
  };
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, session, profile, context, actions, replies, refreshes, invoke, directory };
}

test('recovered builder contracts exist and client-side role flags cannot grant authority', { skip: !registry }, async t => {
  const f = fixture(t, 'player');
  for (const contract of SUPPORTED_REQUESTS) {
    assert.ok(registry.getMessage(contract.id), `request ${contract.id}`);
    assert.ok(registry.getMessage(contract.replyId), `reply ${contract.replyId}`);
  }
  const before = f.store.snapshot();
  const reply = await f.invoke(200, { classno: 37, xloc: 100, yloc: 220, count: 1 });
  assert.equal(reply.decoded.success, 16);
  assert.match(reply.decoded.fail_msg, /permission/);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(await f.actions.handle(f.session, { noid: 0, id: 12345, fields: {} }), false);
});

test('builder create, clone and delete persist real class instances with protected lifecycle records', { skip: !registry }, async t => {
  const f = fixture(t);
  const created = await f.invoke(5310, { classno: 37, xloc: 170, yloc: 230 });
  assert.equal(created.decoded.success, 0);
  const objectId = created.decoded.new_noid - 100;
  assert.equal(f.store.getObject(objectId).classNumber, 37);
  assert.deepEqual(f.store.getObject(objectId).fields.position, [170, 230, 0]);
  const before = Object.keys(f.store.snapshot().objects).length;
  assert.equal((await f.invoke(201, { target: objectId + 100, count: 2 })).decoded.success, 0);
  assert.equal(Object.keys(f.store.snapshot().objects).length, before + 2);
  assert.equal((await f.invoke(202, { target: objectId + 100 })).decoded.success, 0);
  assert.equal(f.store.getObject(objectId), null);
  for (const classno of [0, 1, 2, 3, 4, 10, 11, 20, 21, 22]) assert.notEqual((await f.invoke(200, { classno, xloc: 0, yloc: 0, count: 1 })).decoded.success, 0);
  assert.notEqual((await f.invoke(202, { target: 0 })).decoded.success, 0);
  const restored = new WorldStore(f.directory);
  assert.equal(Object.keys(restored.snapshot().objects).length, before + 1);
  restored.close();
});

test('typed field writes validate numeric ranges and identity before atomically updating', { skip: !registry }, async t => {
  const f = fixture(t);
  const created = await f.invoke(5310, { classno: 37, xloc: 100, yloc: 220 });
  const target = created.decoded.new_noid, objectId = target - 100;
  const updated = await f.invoke(205, { target, field: 'position', value: '222 111 -3', where: 's' });
  assert.equal(updated.id, 80); assert.equal(updated.decoded.success, 0);
  assert.equal(updated.decoded.cvsize, 4);
  assert.deepEqual(f.store.getObject(objectId).fields.position, [222, 111, -3]);
  const before = f.store.snapshot();
  for (const [field, value] of [['position', '999999 0 0'], ['noid', '500'], ['__proto__', '1'], ['classNumber', '21']]) {
    assert.notEqual((await f.invoke(205, { target, field, value, where: 's' })).decoded.success, 0);
  }
  assert.deepEqual(f.store.snapshot(), before);
  const list = await f.invoke(206, { target });
  assert.match(list.decoded.fields, /position s/); assert.doesNotMatch(list.decoded.fields, /(?:^|\{)noid s/);
  assert.equal((await f.invoke(203, { target, field: 'position' })).decoded.value, '222 111 -3');
});

test('public property lookup allows menu metadata and rejects secrets without touching world state', { skip: !registry }, async t => {
  const f = fixture(t);
  const created = await f.invoke(5310, { classno: 37, xloc: 100, yloc: 220 });
  const target = created.decoded.new_noid;
  assert.equal((await f.invoke(210, { target, property: '.popDests', value: 'Lobby|Garden' })).decoded.success, 0);
  f.store.transaction(draft => { draft.avatars[1].role = 'player'; });
  const before = f.store.snapshot();
  assert.equal((await f.invoke(211, { target, propname: '.popDests' })).decoded.propdata, 'Lobby|Garden');
  for (const propname of ['role', 'ownerId', 'secret', '__proto__']) assert.notEqual((await f.invoke(211, { target, propname })).decoded.success, 0);
  assert.deepEqual(f.store.snapshot(), before);
});

test('newline Builder editor data changes exact common fields and rejects unavailable images', { skip: !registry }, async t => {
  const f = fixture(t);
  const created = await f.invoke(5310, { classno: 37, xloc: 100, yloc: 220 });
  const target = created.decoded.new_noid;
  const values = ['Edited € book', '1', '1', '1', 'o.bookopen.img', '0', '2', '25',
    ...Array.from({ length: 16 }, (_, index) => String(index)), 'Read me', 'https://example.test/', 'Authored help', '3', '222', '223', '-1'];
  const reply = await f.invoke(5322, { item: target, newData: values.join('\n') + '\n' });
  assert.equal(reply.decoded.success, 0);
  const object = f.store.getObject(target - 100);
  assert.equal(object.fields.name, 'Edited € book'); assert.equal(object.fields.common_flags & 518, 518);
  assert.equal(object.portable, false); assert.deepEqual(object.fields.position, [222, 223, -1]);
  assert.equal(object.properties.help, 'Authored help');
  const before = f.store.snapshot(); values[4] = '../../private.img';
  assert.notEqual((await f.invoke(5322, { item: target, newData: values.join('\n') })).decoded.success, 0);
  assert.deepEqual(f.store.snapshot(), before);
});

test('region creation, duplication, listing and deferred deletion keep valid roots', { skip: !registry }, async t => {
  const f = fixture(t);
  assert.equal((await f.invoke(220, { name: 'Workshop', address: 'workshop', areaCode: 2, regionFlags: 65536, regionNum: 40 })).decoded.success, 0);
  const region = f.store.getRegion(40); assert.equal(f.store.getObject(region.objectId).classNumber, 20);
  assert.equal((await f.invoke(221, { address: 'copy', areaCode: 2, randomFactor: 0 })).decoded.success, 0);
  const list = await f.invoke(226, { areaCode: 2 });
  assert.equal(list.decoded.num_regions, 2); assert.ok(list.decoded.region_nums.includes(40));
  assert.notEqual((await f.invoke(222)).decoded.success, 0);
  f.store.moveObject(f.store.getAvatar(1).objectId, { regionId: 40 }, { admin: true });
  assert.equal((await f.invoke(225, { name: 'Changed', address: 'changed', areaCode: 3, regionFlags: 0 })).decoded.success, 0);
  const details = await f.invoke(223); assert.equal(details.decoded.regionNum, 40); assert.equal(details.decoded.name, 'Changed');
  assert.equal((await f.invoke(222)).decoded.success, 0);
  assert.equal(f.store.getRegion(40).properties.pendingDeletion, true);
});

test('group operations preserve membership, fixed tables and entry-region invariants', { skip: !registry }, async t => {
  const f = fixture(t);
  assert.equal((await f.invoke(230, { name: 'Studio', address: 'studio', areaCode: 7, count: 2, reggroupFlags: 16 })).decoded.success, 0);
  const group = Object.values(f.store.snapshot().regionGroups)[0];
  assert.equal(group.regionIds.length, 2);
  f.store.moveObject(f.store.getAvatar(1).objectId, { regionId: group.regionIds[0] }, { admin: true });
  const details = await f.invoke(233);
  assert.equal(details.decoded.entryRegNum, group.entryRegionId);
  assert.equal(details.decoded.regionNums[1], group.regionIds[1]);
  assert.equal(details.fields.regionNames.length, 1024);
  assert.equal((await f.invoke(235, { name: 'Updated studio', address: 'studio', areaCode: 7, entryRegNum: group.regionIds[1], reggroupFlags: 0 })).decoded.success, 0);
  assert.equal((await f.invoke(238, { areaCode: 7 })).decoded.num_reggroups, 1);
  assert.equal((await f.invoke(237, { reggroupAddr: 'studio', reggroupAC: 7, regionAddr: 'studio2', regionAC: 7 })).decoded.success, 0);
  assert.equal(f.store.snapshot().regionGroups[group.id].entryRegionId, group.regionIds[0]);
  assert.equal((await f.invoke(236, { reggroupAddr: 'studio', reggroupAC: 7, regionAddr: 'studio2', regionAC: 7 })).decoded.success, 0);
  assert.equal((await f.invoke(231, { address: 'studio-copy', areaCode: 8 })).decoded.success, 0);
  assert.equal((await f.invoke(232)).decoded.success, 0);
  assert.equal(f.store.snapshot().regionGroups[group.id].pendingDeletion, true);
});

test('action metadata persists and binds without evaluating its source', { skip: !registry }, async t => {
  const f = fixture(t);
  const created = await f.invoke(5310, { classno: 37, xloc: 100, yloc: 220 });
  const target = created.decoded.new_noid;
  const script = 'globalThis.__builder_script_executed = true; process.exit(9)';
  assert.equal((await f.invoke(30006, { id_action: 9, action_name: 'Metadata', action_description: 'Stored only', script })).decoded.success, 0);
  assert.equal((await f.invoke(30003, { target, id_action: 9, next_action: 0 })).decoded.success, 0);
  const binding = await f.invoke(30001, { target }); assert.equal(binding.decoded.id_action, 9);
  const action = await f.invoke(30004, { id_action: 9 }); assert.equal(action.decoded.script, script);
  assert.equal(f.store.snapshot().actions[9].executable, false);
  assert.equal(globalThis.__builder_script_executed, undefined);
  assert.equal((await f.invoke(30003, { target, id_action: 0, next_action: 0 })).decoded.success, 0);
  assert.equal((await f.invoke(30001, { target })).decoded.id_action, 0);
});

test('object URL, glue and description edits enforce ownership; builder cosmetic tools require persisted role', { skip: !registry }, async t => {
  const f = fixture(t, 'player');
  const owned = f.store.createObject({ classNumber: 37, regionId: f.profile.regionId, ownerId: 1, fields: { name: 'Owned', position: [100, 220, 0] } });
  const target = owned.id + 100;
  assert.equal((await f.invoke(165, { target, newURLlabel: 'Site', newURL: 'https://example.test/' })).decoded.success, 0);
  assert.equal((await f.invoke(161, { target, which: 0 })).decoded.URL, 'https://example.test/');
  const before = f.store.snapshot();
  assert.notEqual((await f.invoke(165, { target, newURLlabel: 'Bad', newURL: 'file:///private.txt' })).decoded.success, 0);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal((await f.invoke(194, { target, newTMA: 'New description' })).decoded.success, 0);
  assert.equal(f.store.getObject(owned.id).properties.description, 'New description');
  assert.equal((await f.invoke(186, { item: target, glued: 1 })).decoded.success, 0);
  assert.equal(f.store.getObject(owned.id).portable, false);
  assert.notEqual((await f.invoke(5302, { target, name: 'No grant' })).decoded.success, 0);
  f.store.transaction(draft => { draft.avatars[1].role = 'builder'; });
  assert.equal((await f.invoke(5302, { target, name: 'Renamed' })).decoded.success, 0);
  assert.equal((await f.invoke(5333, { target, colorMap: Array(16).fill(3) })).decoded.success, 0);
  assert.equal((await f.invoke(5306, { target, TMAtext: 'Builder TMA' })).decoded.success, 0);
  assert.equal(f.store.getObject(owned.id).properties.TMA, 'Builder TMA');
});

function managerAndTokens(f, denomination = 100) {
  const manager = f.store.createObject({ classNumber: 46, regionId: f.profile.regionId, portable: false,
    fields: { name: 'Manager', position: [300, 220, 0], rent: [100, 0, 0, 0, 0, 0, 0, 0], num_available: [2, 0, 0, 0, 0, 0, 0, 0] } });
  const tokens = f.store.createObject({ classNumber: 26, regionId: f.profile.regionId, containerId: f.profile.objectId,
    ownerId: 1, fields: { name: 'Tokens', denom: denomination, position: [0, 0, 0] } });
  return { manager, tokens, noid: manager.id + 100 };
}

test('player housing consumes physical held cash once, persists lease and quotes server-defined rent', { skip: !registry }, async t => {
  const f = fixture(t, 'player', 21), { manager, tokens, noid } = managerAndTokens(f);
  const balance = f.store.getAvatar(1).balance;
  assert.equal((await f.invoke(4001, { plan: 0 }, noid)).decoded.success, 0);
  const rented = await f.invoke(4005, { plan: 0, primary: 1, address: 'Chez Builder' }, noid);
  assert.equal(rented.decoded.success, 0);
  assert.equal(f.store.getObject(tokens.id), null);
  assert.equal(f.store.getAvatar(1).balance, balance);
  const home = f.store.getRegion(f.store.getAvatar(1).homeRegionId);
  assert.equal(home.properties.housing.ownerId, 1);
  assert.equal(f.store.getObject(manager.id).fields.num_available[0], 1);
  const quote = await f.invoke(4016, { address: 'Chez Builder' }, noid);
  assert.equal(quote.decoded.rent, 100); assert.ok(quote.decoded.max_rent >= 200);
  const payment = f.store.createObject({ classNumber: 26, regionId: f.profile.regionId, containerId: f.profile.objectId,
    ownerId: 1, fields: { name: 'Tokens', denom: 200, position: [0, 0, 0] } });
  const previousPaidUntil = home.properties.housing.paidUntil;
  assert.equal((await f.invoke(4009, { address: 'Chez Builder' }, noid)).decoded.success, 0);
  assert.equal(f.store.getObject(payment.id), null);
  assert.equal(f.store.getRegion(home.id).properties.housing.paidUntil, previousPaidUntil + 2 * home.properties.housing.periodMs);
  assert.equal(f.store.getAvatar(1).balance, balance);
  const ended = await f.invoke(4013, { address: 'Chez Builder' }, noid);
  assert.equal(ended.decoded.success, 0); assert.equal(ended.decoded.num_avail, 2);
  assert.equal(f.store.getRegion(home.id).properties.pendingDeletion, true);
  const refund = f.store.listObjects({ containerId: f.profile.objectId }).find(object => object.classNumber === 26);
  assert.equal(refund.fields.denom, 200);
  assert.equal(f.store.getAvatar(1).homeRegionId, null);
});

test('rent rejects missing or inexact cash without bank debit, and active leases protect their manager', { skip: !registry }, async t => {
  const f = fixture(t, 'player', 21), { tokens, noid, manager } = managerAndTokens(f, 101);
  const before = f.store.snapshot();
  assert.notEqual((await f.invoke(4005, { plan: 0, primary: 1, address: 'Wrong amount' }, noid)).decoded.success, 0);
  assert.deepEqual(f.store.snapshot(), before);
  f.store.updateObject(tokens.id, { fields: { denom: 100 } }, { actorId: 1 });
  assert.equal((await f.invoke(4005, { plan: 0, primary: 1, address: 'Right amount' }, noid)).decoded.success, 0);
  f.store.transaction(draft => { draft.avatars[1].role = 'admin'; });
  assert.notEqual((await f.invoke(202, { target: manager.id + 100 })).decoded.success, 0);
  assert.ok(f.store.getObject(manager.id));
});

test('home co-owners, guest access and eviction use persisted ownership rather than avatar role flags', { skip: !registry }, async t => {
  const f = fixture(t, 'player', 21), { noid } = managerAndTokens(f);
  f.store.ensureAvatar({ id: 2, accountId: 2, name: 'CoOwner' });
  f.store.ensureAvatar({ id: 3, accountId: 3, name: 'Guest' });
  assert.equal((await f.invoke(4005, { plan: 0, primary: 1, address: 'Owned home' }, noid)).decoded.success, 0);
  const homeId = f.store.getAvatar(1).homeRegionId;
  assert.equal((await f.invoke(4024, { address: 'Owned home', newOwnerName: 'CoOwner' }, noid)).decoded.success, 0);
  assert.equal((await f.invoke(4028, { address: 'Owned home', newAddress: 'Renamed home' }, noid)).decoded.success, 0);
  f.store.moveObject(f.profile.objectId, { regionId: homeId }, { admin: true });
  f.store.moveObject(f.store.getAvatar(3).objectId, { regionId: homeId }, { admin: true });
  const guestSession = { avatar: { id: 3 }, role: 'admin' };
  f.context.sessions = [f.session, guestSession];
  const evictions = [];
  f.context.teleport = async (session, regionId) => {
    evictions.push(session.avatar.id); f.store.moveObject(f.store.getAvatar(session.avatar.id).objectId, { regionId }, { admin: true });
  };
  const owners = await f.invoke(147); assert.equal(owners.decoded.coOwnerNames, 'CoOwner');
  assert.equal((await f.invoke(131, { guestAllowed: 0, kickOutOnExit: 1 })).decoded.success, 0);
  const access = await f.invoke(150); assert.equal(access.decoded.guestAllowed, 0); assert.equal(access.decoded.kickOutOnExit, 1);
  const denied = await f.actions.handle(guestSession, { noid: 0, id: 143, fields: {} });
  assert.equal(denied, true); assert.equal(f.replies.at(-1).decoded.success, 16);
  assert.equal((await f.invoke(139, { guest_name: 'Guest' })).decoded.success, 0);
  assert.deepEqual(evictions, [3]);
  assert.equal(f.store.getAvatar(3).regionId, f.store.snapshot().startRegionId);
});

test('legacy Fiddle create and delete share authoring checks and validate coordinates', { skip: !registry }, async t => {
  const f = fixture(t);
  const before = new Set(Object.keys(f.store.snapshot().objects));
  assert.equal((await f.invoke(3051, { target: 0, classno: 37, xloc: 170, yloc: 210, zloc: 5 })).decoded.success, 0);
  const created = Object.values(f.store.snapshot().objects).find(object => !before.has(String(object.id)));
  assert.deepEqual(created.fields.position, [170, 210, 5]);
  assert.equal((await f.invoke(3053, { target: created.id + 100 })).decoded.success, 0);
  assert.equal(f.store.getObject(created.id), null);
  assert.notEqual((await f.invoke(3051, { target: 0, classno: 37, xloc: 65535, yloc: 210, zloc: 0 })).decoded.success, 0);
});
