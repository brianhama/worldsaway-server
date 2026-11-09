import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ResourceStore } from './helpers/fixtures.mjs';
import { ClassRegistry } from '../dist/src/classes.js';
import { WorldStore } from '../dist/src/world-store.js';
import { SocialActions, SUPPORTED_REQUESTS, isPhysicalMail } from '../dist/src/social-actions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientDir = path.join(root, 'wa');
const available = true; // Raw cache or bundled resource pack through the fixture adapter.
let registry;
if (available) registry = new ClassRegistry(new ResourceStore({ clientDir }));

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-social-'));
  let now = 100000;
  const store = new WorldStore(directory, { clock: () => now });
  const regionId = store.snapshot().startRegionId;
  const avatars = [{ id: 1, accountId: 1, name: 'Alice' }, { id: 2, accountId: 2, name: 'Bob' }, { id: 3, accountId: 3, name: 'Cara' }];
  for (const avatar of avatars) store.ensureAvatar(avatar, { regionId, classNumber: 21 });
  const sessions = new Set(avatars.slice(0, 2).map(avatar => ({ avatar, regionId, closed: false })));
  const [alice, bob] = sessions, messages = [], notices = [];
  const actorObject = session => store.getObject(store.getAvatar(session.avatar.id).objectId);
  const noidFor = (session, object) => object.id + session.avatar.id * 1000;
  const mapFields = (session, value) => {
    if (Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(item => mapFields(session, item));
    if (value && typeof value === 'object') {
      if ('objectRef' in value) return noidFor(session, store.getObject(value.objectRef));
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapFields(session, item)]));
    }
    return value;
  };
  const reply = async (session, noid, id, fields) => {
    const mapped = mapFields(session, fields);
    const bytes = registry.encodeMessage(id, mapped);
    messages.push({ session, noid, id, fields: registry.decodeMessage(id, bytes), bytes });
  };
  const context = { worldStore: store, sessions, clock: () => now,
    actorObject, noidFor, ref: object => ({ objectRef: typeof object === 'object' ? object.id : object }), reply,
    resolveObject: (session, noid) => store.listObjects({ regionId: store.getAvatar(session.avatar.id).regionId }).find(object => noidFor(session, object) === noid),
    broadcastObject: async (region, objectId, id, fields, except) => {
      notices.push({ region, objectId, id, fields });
      for (const session of sessions) if (session !== except && store.getAvatar(session.avatar.id).regionId === region) await reply(session, noidFor(session, store.getObject(objectId)), id, fields);
    },
    broadcast: async (region, noid, id, fields, except) => {
      notices.push({ region, noid, id, fields });
      for (const session of sessions) if (session !== except && store.getAvatar(session.avatar.id).regionId === region) await reply(session, noid, id, fields);
    }, refreshRegion: async () => {},
  };
  const actions = new SocialActions(context);
  const request = async (session, id, fields = {}, object = actorObject(session)) => {
    const noid = object ? noidFor(session, object) : 0;
    await actions.handle(session, { id, noid, fields, object });
    return messages.at(-1);
  };
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, actions, context, actorObject, noidFor, alice, bob, sessions, messages, notices, request,
    tick: delta => { now += delta; } };
}

test('social handlers use recovered message schemas and remap room speakers per recipient', { skip: !available }, async t => {
  const h = setup(t);
  await h.request(h.alice, 72, { type: 0, text: 'Hello Bob' });
  assert.equal(h.messages[0].id, 73);
  const notice = h.messages.find(message => message.id === 74);
  assert.equal(notice.session, h.bob);
  assert.equal(notice.noid, h.noidFor(h.bob, h.actorObject(h.alice)));
  assert.equal(notice.fields.speaker, notice.noid);
  assert.equal(notice.fields.text, 'Hello Bob');
  await h.request(h.alice, 72, { type: 0, text: 'Hello “Bob” — €' });
  assert.equal(h.messages.at(-1).fields.text, 'Hello “Bob” — €');
  h.actions.setIgnored(2, 1);
  const count = h.messages.filter(message => message.id === 74).length;
  await h.request(h.alice, 72, { type: 0, text: 'Hidden by ignore' });
  assert.equal(h.messages.filter(message => message.id === 74).length, count);
  const foreign = h.actorObject(h.bob);
  const denied = await h.request(h.alice, 72, { type: 0, text: 'spoof' }, foreign);
  assert.equal(denied.id, 73); assert.notEqual(denied.fields.success, 0);
});

test('movement, facing, mood and gestures persist and cannot modify another actor', { skip: !available }, async t => {
  const h = setup(t), actorId = h.actorObject(h.alice).id;
  await h.request(h.alice, 1570, { coords: [700, -5, 0] });
  assert.deepEqual(h.store.getObject(actorId).fields.position, [512, 0, 0]);
  await h.request(h.alice, 1570, { coords: [100, 600, 0] });
  assert.deepEqual(h.store.getObject(actorId).fields.position, [100, 512, 0], 'native depth spans 0..512 across the scene');
  assert.ok(h.messages.some(message => message.id === 1571 && message.fields.success === 0));
  assert.ok(h.messages.some(message => message.id === 1572));
  await h.request(h.alice, 1616, { mood: 2 });
  await h.request(h.alice, 1688, { facing: 3 });
  await h.request(h.alice, 1594, { gesture: 'jump_up' });
  assert.equal(h.store.getObject(actorId).fields.mood, 2);
  assert.equal(h.store.getObject(actorId).fields.orientation, 3);
  assert.ok(h.messages.some(message => message.id === 1595 && message.fields.gesture === 'jump_up'));
  const before = h.store.getObject(h.actorObject(h.bob).id).fields.position;
  const denied = await h.request(h.alice, 1570, { coords: [1, 2, 0] }, h.actorObject(h.bob));
  assert.notEqual(denied.fields.success, 0);
  assert.deepEqual(h.store.getObject(h.actorObject(h.bob).id).fields.position, before);
  const bad = await h.request(h.alice, 1616, { mood: 500 });
  assert.notEqual(bad.fields.success, 0);
  h.store.close();
  const reopened = new WorldStore(h.directory);
  assert.equal(reopened.getObject(actorId).fields.orientation, 3);
  reopened.close();
});

test('ESP obeys recipient preference and offers durable offline mail', { skip: !available }, async t => {
  const h = setup(t);
  await h.request(h.alice, 109, { type: 0, to: 'bob', text: 'Private' }, null);
  assert.ok(h.messages.some(message => message.id === 110 && message.session === h.bob && message.fields.from === 'Alice'));
  await h.request(h.bob, 1916, { type: 60 });
  const blocked = await h.request(h.alice, 109, { type: 0, to: 'Bob', text: 'Blocked' }, null);
  assert.equal(blocked.id, 111); assert.notEqual(blocked.fields.success, 0);
  await h.request(h.alice, 109, { type: 0, to: 'Cara', text: 'Offline' }, null);
  assert.equal(h.messages.at(-1).id, 243);
  await h.request(h.alice, 244, { to: 'Cara', text: 'Offline letter | retained' }, null);
  assert.equal(h.store.listMail(3).length, 1);
  assert.equal(h.store.listMail(3)[0].body, 'Offline letter | retained');
  assert.equal(h.store.getAvatar(3).preferences.flags & 1024, 1024);
  const cara = { avatar: { id: 3, accountId: 3, name: 'Cara' }, regionId: h.store.getAvatar(3).regionId };
  const read = await h.request(cara, 247, {}, null);
  assert.equal(read.id, 246); assert.match(read.fields.text, /From Alice on /);
  assert.ok(!read.fields.text.includes('|')); // delimiter is not injected by message content
  assert.equal(h.store.listMail(3)[0].readAt !== null, true);
  assert.equal(h.store.getAvatar(3).preferences.flags & 1024, 0);
  const second = await h.request(cara, 247, {}, null);
  assert.equal(second.fields.text, '');
});

test('follow state rejects cycles and foreign stop requests', { skip: !available }, async t => {
  const h = setup(t);
  await h.request(h.alice, 1600, {}, h.actorObject(h.bob));
  assert.equal(h.store.getAvatar(1).preferences.following, 2);
  assert.equal(h.store.getObject(h.actorObject(h.alice).id).fields.following, h.actorObject(h.bob).id);
  const cycle = await h.request(h.bob, 1600, {}, h.actorObject(h.alice));
  assert.notEqual(cycle.fields.success, 0);
  await h.request(h.bob, 1570, { coords: [100, 200, 0] });
  assert.deepEqual(h.actorObject(h.alice).fields.position, [100, 200, 0]);
  await h.request(h.bob, 1603, {}, h.actorObject(h.alice));
  assert.equal(h.store.getAvatar(1).preferences.following, null);
  assert.equal(h.actorObject(h.alice).fields.following, 65535);
});

test('native mail batches stay bounded and leave undisplayed messages unread', { skip: !available }, async t => {
  const h = setup(t);
  for (let index = 0; index < 3; index++) h.store.sendMail(1, 2, { body: String(index).repeat(40000) });
  await h.request(h.bob, 247, {}, null);
  const first = h.messages.find(message => message.id === 246);
  assert.equal(first.fields.text.length < 61 * 1024, true);
  assert.equal(h.store.listMail(2).filter(item => item.readAt === null).length, 2);
  assert.equal(h.messages.at(-1).id, 248);
  await h.request(h.bob, 247, {}, null);
  await h.request(h.bob, 247, {}, null);
  assert.equal(h.store.listMail(2).filter(item => item.readAt === null).length, 0);
});

test('ESP reading cannot consume Postbox parcels or attachment records', { skip: !available }, async t => {
  const h = setup(t);
  const postbox = h.store.listObjects().find(object => object.classNumber === 50);
  const parcel = h.store.createObject({ classNumber: 37, regionId: 1, ownerId: 2,
    fields: { name: 'Posted document', common_flags: 1 } });
  h.store.sendMail(1, 2, { body: 'Plain ESP content' });
  const ids = h.store.transaction(draft => {
    const parcelId = draft.next.message++, attachmentId = draft.next.message++;
    draft.objects[parcel.id].archivedIn = postbox.id;
    draft.objects[parcel.id].archivedFlags = 0;
    draft.mail[parcelId] = { id: parcelId, fromId: 1, toId: 2, subject: 'Parcel', body: 'Physical label',
      createdAt: 100000, readAt: null, objectId: parcel.id, deliveredAt: null };
    draft.mail[attachmentId] = { id: attachmentId, fromId: 1, toId: 2, fromName: 'Alice', subject: 'Attached item',
      body: 'Attachment label', createdAt: 100000, readAt: null, attachments: [{ objectId: parcel.id }] };
    draft.avatars[2].mailbox.push(parcelId, attachmentId);
    draft.avatars[2].preferences.flags = 1024;
    return [parcelId, attachmentId];
  });
  const mailbox = [...h.store.getAvatar(2).mailbox];
  const read = await h.request(h.bob, 247, {}, null);
  assert.equal(read.id, 246); assert.match(read.fields.text, /Plain ESP content/);
  assert.ok(!read.fields.text.includes('Physical label'));
  assert.ok(!read.fields.text.includes('Attachment label'));
  const state = h.store.snapshot();
  for (const id of ids) assert.equal(state.mail[id].readAt, null);
  assert.equal(state.mail[ids[0]].deliveredAt, null);
  assert.equal(state.objects[parcel.id].archivedIn, postbox.id);
  assert.deepEqual(state.avatars[2].mailbox, mailbox);
  assert.equal(state.avatars[2].preferences.flags & 1024, 0);
  assert.equal(isPhysicalMail(state.mail[ids[0]]), true);
  assert.equal(isPhysicalMail(state.mail[ids[1]]), true);
  h.store.close();
  const reopened = new WorldStore(h.directory);
  assert.equal(reopened.snapshot().mail[ids[0]].deliveredAt, null);
  assert.equal(reopened.getObject(parcel.id).archivedIn, postbox.id);
  reopened.close();
});

test('Ghost speech is rejected and touching uses the installed information notice', { skip: !available }, async t => {
  const h = setup(t);
  const touched = await h.request(h.alice, 1591, {}, h.actorObject(h.bob));
  assert.equal(touched.id, 118); assert.equal(touched.session, h.bob);
  assert.match(touched.fields.text, /Alice touched you/);
  h.store.transaction(draft => {
    draft.objects[h.actorObject(h.alice).id].classNumber = 22;
    draft.avatars[1].ghost = true;
  });
  const refused = await h.request(h.alice, 72, { type: 0, text: 'Ghost speech' });
  assert.equal(refused.id, 73); assert.notEqual(refused.fields.success, 0);
});

test('status preferences and staff checks persist while unknown requests remain unclaimed', { skip: !available }, async t => {
  const h = setup(t);
  const denied = await h.request(h.alice, 1916, { type: 93 });
  assert.notEqual(denied.fields.success, 0);
  await h.request(h.alice, 1916, { type: 251 });
  assert.equal(h.store.getAvatar(1).preferences.flags & 512, 512);
  h.actions.setFriend(1, 2);
  assert.deepEqual(h.store.getAvatar(1).friends, [2]);
  h.tick(4000); h.actions.onDisconnect(h.alice);
  assert.equal(h.store.getAvatar(1).onlineSeconds, 4);
  assert.equal(await h.actions.handle(h.alice, { id: 65000, noid: 0, fields: {} }), false);
});

test('mode hooks acknowledge original Tcl conversion contracts before refresh callbacks', { skip: !available }, async t => {
  const h = setup(t);
  const order = [];
  h.context.setActorMode = async (_session, mode, coords) => ({ actorNoid: 45, contentsVector: Buffer.from([0, 0, 0, 0]),
    afterReply: async () => { order.push('after'); assert.ok(h.messages.some(message => message.id === (mode === 'ghost' ? 1588 : 2006))); } });
  await h.request(h.alice, 1587);
  await h.request(h.alice, 2005, { coords: [20, 30, 0] });
  const ack = h.messages.find(message => message.id === 2006);
  assert.equal(ack.fields.actor_noid, 45);
  assert.equal(ack.fields.cvsize, 4);
  assert.deepEqual(order, ['after', 'after']);
});

test('web tours enforce invitations and safe URL schemes', { skip: !available }, async t => {
  const h = setup(t);
  await h.request(h.alice, 171, { newstate: 1 }, null);
  const denied = await h.request(h.bob, 179, { target: h.noidFor(h.bob, h.actorObject(h.alice)) }, null);
  assert.notEqual(denied.fields.success, 0);
  await h.request(h.alice, 175, { target: h.noidFor(h.alice, h.actorObject(h.bob)), allow: 1 }, null);
  await h.request(h.bob, 179, { target: h.noidFor(h.bob, h.actorObject(h.alice)) }, null);
  assert.equal(h.store.getAvatar(2).preferences.tourFollowing, 1);
  const unsafe = await h.request(h.alice, 183, { newURL: 'file:///private/file' }, null);
  assert.notEqual(unsafe.fields.success, 0);
  await h.request(h.alice, 183, { newURL: 'https://example.test/tour' }, null);
  assert.ok(h.messages.some(message => message.id === 184 && message.session === h.bob && message.fields.newURL === 'https://example.test/tour'));
});

test('every social request has its recovered reply descriptor', { skip: !available }, () => {
  for (const contract of SUPPORTED_REQUESTS) assert.ok(registry.getMessage(contract.replyId), `${contract.id} -> ${contract.replyId}`);
});

test('owned Robot speech uses its speaker identity and rejects another owner while asleep mood persists', { skip: !available }, async t => {
  const h = setup(t);
  const robot = h.store.createObject({ classNumber: 40, ownerId: 1, regionId: h.alice.regionId,
    fields: { name: 'Alice Robot', position: [200, 220, 0] } });
  await h.request(h.alice, 72, { type: 0, text: 'Robot speaking' }, robot);
  assert.equal(h.messages[0].id, 73); assert.equal(h.messages[0].fields.success, 0);
  assert.equal(h.messages[0].fields.speaker, h.noidFor(h.alice, robot));
  assert.ok(h.messages.some(message => message.session === h.bob && message.id === 74 && message.fields.speaker === h.noidFor(h.bob, robot)));
  await h.request(h.bob, 72, { type: 0, text: 'Not my robot' }, robot);
  assert.equal(h.messages.at(-1).id, 73); assert.notEqual(h.messages.at(-1).fields.success, 0);
  await h.request(h.alice, 1616, { mood: 4 });
  assert.equal(h.store.getObject(h.actorObject(h.alice).id).fields.mood, 4);
});

test('token status counts physical hand and nested pocket cash separately from bank and floor tokens', { skip: !available }, async t => {
  const h = setup(t), actor = h.actorObject(h.alice);
  h.store.createObject({ classNumber: 26, ownerId: 1, regionId: 1, containerId: actor.id, fields: { position: [0, 0, 0], denom: 12 } });
  const bag = h.store.createObject({ classNumber: 36, ownerId: 1, regionId: 1, containerId: actor.id, capacity: 4, fields: { position: [4, 0, 0] } });
  h.store.createObject({ classNumber: 26, ownerId: 1, regionId: 1, containerId: bag.id, fields: { position: [0, 0, 0], denom: 30 } });
  h.store.createObject({ classNumber: 26, ownerId: 1, regionId: 1, fields: { position: [300, 220, 0], denom: 99 } });
  const reply = await h.request(h.alice, 1916, { type: 59 });
  assert.equal(reply.fields.text, 'You hold 12 Tokens in your hand and 30 in your pockets. Your bank balance is 1000 Tokens.');
});
