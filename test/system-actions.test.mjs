import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WorldStore } from '../dist/src/world-store.js';
import { ResourceStore } from './helpers/fixtures.mjs';
import { ClassRegistry } from '../dist/src/classes.js';
import { SystemActions, SUPPORTED_REQUESTS } from '../dist/src/system-actions.js';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../wa');
const available = true; // Raw cache or bundled resource pack through the fixture adapter.
const registry = available ? new ClassRegistry(new ResourceStore({ clientDir })) : null;

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-system-'));
  const store = new WorldStore(directory, { clock: () => 1000 });
  const avatars = [{ id: 1, accountId: 1, name: 'Alice' }, { id: 2, accountId: 2, name: 'Bob' }];
  avatars.forEach(avatar => store.ensureAvatar(avatar, { classNumber: 21 }));
  const alice = { avatar: avatars[0], regionId: 1 }, bob = { avatar: avatars[1], regionId: 1 };
  const sessions = new Set([alice, bob]), messages = [], events = [];
  const noidFor = (_session, object) => object.classNumber === 20 ? 0 : object.id + 100;
  const map = value => {
    if (Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(map);
    if (value && typeof value === 'object') {
      if (value.ref !== undefined) return noidFor(null, store.getObject(value.ref));
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, map(item)]));
    }
    return value;
  };
  const move = (session, destination, { mode } = {}) => {
    store.transaction(draft => {
      const profile = draft.avatars[session.avatar.id], actor = draft.objects[profile.objectId];
      if (mode) { profile.ghost = mode === 'ghost'; actor.classNumber = profile.ghost ? 22 : 21; }
      profile.regionId = destination; actor.regionId = destination; actor.containerId = null;
      const descend = parent => { for (const object of Object.values(draft.objects).filter(item => item.containerId === parent)) { object.regionId = destination; descend(object.id); } };
      descend(actor.id);
    });
    session.regionId = destination;
  };
  const context = { worldStore: store, registry, sessions,
    ref: object => ({ ref: object.id }),
    resolveObject: (session, noid) => store.listObjects({ regionId: store.getAvatar(session.avatar.id).regionId }).find(object => noidFor(session, object) === noid),
    reply: async (session, noid, id, fields) => {
      const payload = registry.encodeMessage(id, map(fields));
      const result = { session, noid, id, fields: registry.decodeMessage(id, payload), payload };
      messages.push(result); events.push(`reply:${id}`);
    },
    broadcast: async (_regionId, _noid, id, fields) => {
      registry.encodeMessage(id, map(fields)); events.push(`notice:${id}`);
    }, refreshRegion: async () => events.push('refresh'),
    teleport: async (session, destination) => { events.push('teleport'); move(session, destination); },
    prepareTeleport: async (session, destination, options) => {
      move(session, destination, options);
      return { regionId: destination, afterReply: async () => { events.push('teleport'); } };
    },
    setActorMode: async session => { store.transaction(draft => { draft.avatars[session.avatar.id].ghost = false; draft.objects[draft.avatars[session.avatar.id].objectId].classNumber = 21; }); return {}; },
  };
  const actions = new SystemActions(context);
  const request = async (session, id, fields = {}, noid = 0) => {
    await actions.handle(session, { noid, id, fields, object: context.resolveObject(session, noid) });
    return messages.at(-1);
  };
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, alice, bob, sessions, messages, events, noidFor, context, actions, request, move };
}

test('native exit enum follows authored topology and acknowledgement precedes travel with possessions', { skip: !available }, async t => {
  const h = setup(t), actor = h.store.getAvatar(1).objectId;
  const item = h.store.createObject({ classNumber: 37, regionId: 1, containerId: actor, ownerId: 1, fields: { name: 'Carried', position: [2, 0, 0] } });
  const result = await h.request(h.alice, 103, { exitDir: 0 });
  assert.equal(result.id, 70); assert.equal(result.fields.success, 0);
  assert.deepEqual(h.events.slice(0, 2), ['reply:70', 'teleport']);
  assert.equal(h.store.getAvatar(1).regionId, 2);
  assert.equal(h.store.getObject(item.id).regionId, 2);
  const blocked = await h.request(h.alice, 103, { exitDir: 3 });
  assert.notEqual(blocked.fields.success, 0);
  assert.equal(h.store.getAvatar(1).regionId, 2);
});

test('failed travel persistence emits no success acknowledgement or scene', { skip: !available }, async t => {
  const h = setup(t);
  const initial = h.store.snapshot();
  const before = fs.readFileSync(h.store.filename);
  t.mock.method(fs, 'renameSync', () => { const error = new Error('injected save failure'); error.code = 'EACCES'; throw error; });
  const failure = await h.request(h.alice, 103, { exitDir: 0 });
  assert.equal(failure.id, 70);
  assert.notEqual(failure.fields.success, 0);
  assert.match(failure.fields.fail_msg, /could not be committed/);
  assert.equal(h.messages.some(message => message.id === 70 && message.fields.success === 0), false);
  assert.equal(h.events.includes('teleport'), false);
  assert.equal(h.store.getAvatar(1).regionId, initial.avatars[1].regionId);
  assert.equal(h.alice.regionId, 1);
  assert.deepEqual(fs.readFileSync(h.store.filename), before);
  t.mock.restoreAll();
});

test('room owner controls persist guest policy and population limits and deny guest travel', { skip: !available }, async t => {
  const h = setup(t);
  const denied = await h.request(h.alice, 155, { guestAllowed: 0, maxAvatars: 4, maxGhosts: 5 });
  assert.notEqual(denied.fields.success, 0);
  h.move(h.alice, 2);
  h.store.transaction(draft => { draft.regions[2].properties.ownerId = 1; });
  const changed = await h.request(h.alice, 155, { guestAllowed: 0, maxAvatars: 4, maxGhosts: 5 });
  assert.equal(changed.fields.success, 0); assert.equal(changed.fields.regionFlags & 2048, 2048);
  assert.equal(h.store.getObject(h.store.getRegion(2).objectId).fields.max_ghosts, 5);
  const noGuests = await h.request(h.bob, 103, { exitDir: 0 });
  assert.notEqual(noGuests.fields.success, 0);
  await h.request(h.alice, 133, { allow: 1 });
  await h.request(h.alice, 135, { which: 0, how_many: 0 });
  const full = await h.request(h.bob, 103, { exitDir: 0 });
  assert.notEqual(full.fields.success, 0);
  await h.request(h.alice, 135, { which: 0, how_many: 2 });
  assert.equal((await h.request(h.bob, 103, { exitDir: 0 })).fields.success, 0);
  assert.equal(h.store.getAvatar(2).regionId, 2);
  h.store.close();
  const reopened = new WorldStore(h.directory);
  assert.equal(reopened.getObject(reopened.getRegion(2).objectId).fields.max_avatars, 2);
  reopened.close();
});

test('address relocation restricts staff and resolves local region groups', { skip: !available }, async t => {
  const h = setup(t);
  const fields = { avatar_name: 'Alice', address: 'Library', areaCode: 0, goto_reggroup: 0, get_real: 0 };
  assert.notEqual((await h.request(h.alice, 124, fields)).fields.success, 0);
  h.store.transaction(draft => { draft.avatars[1].role = 'builder'; });
  assert.equal((await h.request(h.alice, 124, fields)).fields.success, 0);
  assert.equal(h.store.getAvatar(1).regionId, 3);
  assert.notEqual((await h.request(h.alice, 124, { ...fields, avatar_name: 'Bob' })).fields.success, 0);
  h.store.transaction(draft => {
    draft.avatars[1].role = 'admin';
    draft.regionGroups[1] = { id: 1, name: 'Tour', address: 'tour', areaCode: 0, flags: 0, regionIds: [1, 2], entryRegionId: 2 };
    draft.next.regionGroup = 2;
  });
  h.sessions.delete(h.bob); // offline relocation remains durable without a process/session
  assert.equal((await h.request(h.alice, 124, { ...fields, avatar_name: 'Bob', address: 'tour', goto_reggroup: 1 })).fields.success, 0);
  assert.equal(h.store.getAvatar(2).regionId, 2);
});

test('online get_real supplies avatar mode to the durable region preparation', { skip: !available }, async t => {
  const h = setup(t);
  h.store.transaction(draft => {
    draft.avatars[1].role = 'builder'; draft.avatars[1].ghost = true;
    draft.objects[draft.avatars[1].objectId].classNumber = 22;
  });
  let modes = 0, options;
  const prepare = h.context.prepareTeleport;
  h.context.setActorMode = async () => { modes++; throw new Error('Separate mode transition must not run'); };
  h.context.prepareTeleport = async (session, destination, input) => {
    options = input;
    return prepare(session, destination, input);
  };
  const result = await h.request(h.alice, 124,
    { avatar_name: 'Alice', address: 'Library', areaCode: 0, goto_reggroup: 0, get_real: 1 });
  assert.equal(result.fields.success, 0);
  assert.deepEqual(options, { reason: 'native-124', mode: 'avatar' });
  assert.equal(modes, 0);
  assert.equal(h.store.getAvatar(1).ghost, false);
  assert.equal(h.store.getObject(h.store.getAvatar(1).objectId).classNumber, 21);
  assert.equal(h.store.getAvatar(1).regionId, 3);
  assert.deepEqual(h.events, ['reply:70', 'teleport']);
});

test('offline relocation carries archived binder members and document text through restart', { skip: !available }, async t => {
  const h = setup(t), actor = h.store.getAvatar(2).objectId;
  const binder = h.store.createObject({ classNumber: 37, regionId: 1, ownerId: 2, containerId: actor, fields: { name: 'Binder' } });
  const archived = h.store.createObject({ classNumber: 37, regionId: 1, ownerId: 2, fields: { name: 'Archived' } });
  const logical = h.store.createObject({ classNumber: 37, regionId: 1, ownerId: 2, fields: { name: 'Logical' } });
  const nested = h.store.createObject({ classNumber: 37, regionId: 1, ownerId: 2, fields: { name: 'Nested' } });
  const ground = h.store.createObject({ classNumber: 37, regionId: 1, ownerId: 2, fields: { name: 'Ground' } });
  h.store.transaction(draft => {
    draft.avatars[1].role = 'admin';
    draft.objects[archived.id].archivedIn = binder.id;
    draft.objects[nested.id].archivedIn = archived.id;
    draft.documents[binder.id] = { objectId: binder.id, title: 'Trip binder', text: 'Binder notes', entries: [archived.id, logical.id] };
    draft.documents[archived.id] = { objectId: archived.id, title: 'Archive', text: 'Archived text', entries: [nested.id] };
    draft.documents[logical.id] = { objectId: logical.id, title: 'Logical page', text: 'Retained document text' };
    draft.documents[nested.id] = { objectId: nested.id, title: 'Nested page', text: 'Nested document text' };
  });
  const documents = h.store.snapshot().documents;
  h.sessions.delete(h.bob);
  const result = await h.request(h.alice, 124,
    { avatar_name: 'Bob', address: 'Library', areaCode: 0, goto_reggroup: 0, get_real: 0 });
  assert.equal(result.fields.success, 0);
  const verify = store => {
    assert.equal(store.getAvatar(2).regionId, 3);
    for (const id of [actor, binder.id, archived.id, logical.id, nested.id]) assert.equal(store.getObject(id).regionId, 3, `object ${id}`);
    assert.equal(store.getObject(binder.id).containerId, actor);
    assert.equal(store.getObject(archived.id).archivedIn, binder.id);
    assert.equal(store.getObject(nested.id).archivedIn, archived.id);
    assert.equal(store.getObject(ground.id).regionId, 1);
    assert.deepEqual(store.snapshot().documents, documents);
  };
  verify(h.store);
  h.store.close();
  const reopened = new WorldStore(h.directory);
  try { verify(reopened); } finally { reopened.close(); }
});

test('failed get_real travel does not materialize the actor before preparation succeeds', { skip: !available }, async t => {
  const h = setup(t);
  h.store.transaction(draft => {
    draft.avatars[1].role = 'builder'; draft.avatars[1].ghost = true;
    draft.objects[draft.avatars[1].objectId].classNumber = 22;
  });
  const initial = h.store.snapshot(), before = fs.readFileSync(h.store.filename);
  let options, modeCalls = 0;
  const mode = h.context.setActorMode;
  h.context.setActorMode = async (...args) => { modeCalls++; return mode(...args); };
  h.context.prepareTeleport = async (_session, _destination, input) => {
    options = input;
    throw new Error('injected preparation failure');
  };
  const result = await h.request(h.alice, 124,
    { avatar_name: 'Alice', address: 'Library', areaCode: 0, goto_reggroup: 0, get_real: 1 });
  assert.notEqual(result.fields.success, 0);
  assert.deepEqual(options, { reason: 'native-124', mode: 'avatar' });
  assert.equal(modeCalls, 0);
  assert.deepEqual(h.store.snapshot(), initial);
  assert.deepEqual(fs.readFileSync(h.store.filename), before);
  assert.equal(h.alice.regionId, 1);
  assert.deepEqual(h.events, ['reply:70']);
});

test('object positioning enforces ownership and emits recovered191/192 contracts', { skip: !available }, async t => {
  const h = setup(t);
  const object = h.store.createObject({ classNumber: 36, regionId: 1, ownerId: 1, capacity: 10, fields: { name: 'Box' } });
  const native = h.noidFor(h.alice, object);
  const reply = await h.request(h.alice, 190, { item: native, coords: [123, 220, -2], orientation: 2 });
  assert.equal(reply.id, 191); assert.equal(reply.fields.success, 0);
  assert.deepEqual(h.store.getObject(object.id).fields.position, [123, 220, -2]);
  assert.ok(h.events.includes('notice:192'));
  const denied = await h.request(h.bob, 190, { item: native, coords: [4, 5, 0], orientation: 0 });
  assert.notEqual(denied.fields.success, 0);
  assert.deepEqual(h.store.getObject(object.id).fields.position, [123, 220, -2]);
});

test('teleporter configuration persists aliases, destination and native sound/cost fields', { skip: !available }, async t => {
  const h = setup(t);
  const object = h.store.createObject({ classNumber: 56, regionId: 1, ownerId: 1, fields: { name: 'Teleport' } });
  const f = { address: 'Garden', aliases0: 'park', aliases1: '', aliases2: '', aliases3: '', aliases4: '',
    secret_address: 0, areaCode: 0, rideCost: 5, entrySound: 1, exitSound: 2, operateOrientation: 3 };
  const result = await h.request(h.alice, 1207, f, h.noidFor(h.alice, object));
  assert.equal(result.fields.success, 0);
  const stored = h.store.getObject(object.id);
  assert.equal(stored.properties.connection.aliases0, 'park');
  assert.equal(stored.properties.destinationRegionId, 2);
  assert.equal(stored.fields.rideCost, 5);
  assert.ok(h.events.includes('notice:1208'));
  assert.notEqual((await h.request(h.bob, 1207, { ...f, rideCost: 1 }, h.noidFor(h.bob, object))).fields.success, 0);
});

test('all system reply schemas exist and unrelated requests are not claimed', { skip: !available }, async t => {
  const h = setup(t);
  for (const contract of SUPPORTED_REQUESTS) assert.ok(registry.getMessage(contract.replyId));
  assert.equal(await h.actions.handle(h.alice, { id: 64000, noid: 0, fields: {} }), false);
});
