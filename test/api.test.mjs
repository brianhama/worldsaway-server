import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCompatibilityServer } from './helpers/fixtures.mjs';

const clientDir = fileURLToPath(new URL('../../wa', import.meta.url));

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-api-'));
  let server = createCompatibilityServer({ clientDir, dataDir });
  t.after(async () => { await server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const demo = server.store.findAvatar(server.store.account('demo'), 'Demo');
  server.worldStore.ensureAvatar(demo);
  const bobAccount = server.store.createAccount('bob', 'bob-password');
  const bob = server.store.createAvatar(bobAccount, 'Bob');
  server.worldStore.ensureAvatar(bob);
  return {
    get server() { return server; }, demo, bob, dataDir,
    role(role) { server.worldStore.transaction(draft => { draft.avatars[demo.id].role = role; }); },
    async restart() { await server.close(); server = createCompatibilityServer({ clientDir, dataDir }); },
    async request(route, extra = {}, credentials = {}) {
      const values = { account: 'demo', password: 'demo', avatar: 'Demo', ...credentials, ...extra };
      const response = await server.handleHttpRequest({ method: 'POST', path: route,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(new URLSearchParams(values).toString()) });
      const body = response.headers['content-type'].startsWith('application/json') ? JSON.parse(response.body.toString()) : response.body.toString();
      return { ...response, value: body };
    },
  };
}

test('profile preferences and relationships persist without granting roles or moderator flags', async t => {
  const f = await fixture(t);
  const s = f.server;
  s.worldStore.transaction(draft => { draft.avatars[f.demo.id].preferences = { flags: 128, mutedUntil: 12345 }; });
  let response = await f.request('/api/profile', { action: 'preferences', flags: '32', role: 'admin', mutedUntil: '0' });
  assert.equal(response.status, 200);
  assert.equal(response.value.profile.preferences.flags, 128 | 32);
  assert.equal(response.value.profile.preferences.mutedUntil, 12345);
  assert.equal(response.value.profile.role, 'player');
  for (const flags of ['128', '16', '1', '-1', '65536', '', '1e2']) {
    response = await f.request('/api/profile', { action: 'preferences', flags });
    assert.equal(response.status, 400, flags);
  }
  assert.equal((await f.request('/api/profile', { action: 'preferences' })).status, 400);
  assert.equal((await f.request('/api/profile', { action: 'friend', name: 'Bob' })).status, 200);
  assert.equal((await f.request('/api/profile', { action: 'ignore', name: 'Bob' })).status, 200);
  assert.equal((await f.request('/api/profile', { action: 'friend', name: 'Demo' })).status, 400);
  await f.restart();
  response = await f.request('/api/profile');
  assert.deepEqual(response.value.profile.friends, [f.bob.id]);
  assert.deepEqual(response.value.profile.ignored, [f.bob.id]);
  assert.equal(response.value.profile.preferences.flags, 160);
  assert.equal((await f.request('/api/profile', { action: 'unfriend', name: 'Bob' })).status, 200);
  assert.equal((await f.request('/api/profile', { action: 'unignore', name: 'Bob' })).status, 200);
  assert.deepEqual(f.server.worldStore.getAvatar(f.demo.id).friends, []);
  assert.deepEqual(f.server.worldStore.getAvatar(f.demo.id).ignored, []);
});

test('API uses owned avatars, current persisted roles and account bans; builder snapshots omit private profile maps', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/profile', {}, { password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/profile', {}, { avatar: 'Bob' })).status, 403);
  const before = f.server.worldStore.snapshot().revision;
  assert.equal((await f.request('/api/world', { action: 'create-region', name: 'Forbidden' })).status, 403);
  assert.equal(f.server.worldStore.snapshot().revision, before);
  f.server.worldStore.sendMail(f.bob.id, f.demo.id, { body: 'private correspondence' });
  f.role('builder');
  let response = await f.request('/api/world');
  assert.equal(response.status, 200);
  for (const key of ['avatars', 'mail', 'documents', 'ledger', 'audit', 'accountBans', 'timers']) assert.equal(response.value[key], undefined, key);
  assert.ok(response.value.regions && response.value.objects);
  assert.ok(!response.body.toString().includes('private correspondence'));
  f.role('admin');
  response = await f.request('/api/world');
  assert.equal(response.status, 200);
  assert.equal(Object.values(response.value.mail)[0].body, 'private correspondence');
  assert.equal(response.value.accounts, undefined);
  assert.ok(!response.body.toString().includes('"salt"'));
  f.role('player');
  assert.equal((await f.request('/api/world')).status, 403);
  f.server.worldStore.transaction(draft => { draft.accountBans = { [f.server.store.account('demo').id]: { until: Date.now() + 60000 } }; });
  assert.equal((await f.request('/api/profile')).status, 403);
});

test('admin API creates, updates and deletes every spawnable native class with exact codec validation', async t => {
  const f = await fixture(t); f.role('admin');
  const regionId = f.server.worldStore.snapshot().startRegionId;
  const lifecycle = new Set([0, 1, 2, 3, 4, 10, 11, 20, 21, 22]);
  const classes = f.server.runtime.registry.list().filter(item => !lifecycle.has(item.classNumber) && item.fields.some(field => field.name === 'noid'));
  assert.equal(classes.length, 48);
  for (const definition of classes) {
    const classNumber = definition.classNumber;
    let response = await f.request('/api/world', { action: 'create-object', classNumber, regionId,
      data: JSON.stringify({ fields: { name: `Object ${classNumber}` }, properties: { description: 'operator configuration' } }) });
    assert.equal(response.status, 200, `${classNumber}: ${response.value}`);
    const object = response.value.result;
    assert.equal(object.classNumber, classNumber);
    assert.equal(object.regionId, regionId);
    assert.equal(object.capacity, definition.capacity);
    assert.equal(object.ownerId, null);
    f.server.runtime.registry.validateObject(object, { includeServer: true });
    response = await f.request('/api/world', { action: 'update-object', id: object.id,
      data: JSON.stringify({ fields: { name: `Updated ${classNumber}` }, properties: { updated: true }, portable: false }) });
    assert.equal(response.status, 200, `${classNumber}: ${response.value}`);
    assert.equal(response.value.result.fields.name, `Updated ${classNumber}`);
    assert.equal(response.value.result.portable, false);
    response = await f.request('/api/world', { action: 'delete-object', id: object.id });
    assert.equal(response.status, 200);
    assert.equal(f.server.worldStore.getObject(object.id), null);
  }
  for (const classNumber of lifecycle) assert.equal((await f.request('/api/world', { action: 'create-object', classNumber, regionId })).status, 400);
});

test('operator patch bounds, native identity, images and reserved properties fail before commit', async t => {
  const f = await fixture(t); f.role('admin');
  const regionId = f.server.worldStore.snapshot().startRegionId;
  const response = await f.request('/api/world', { action: 'create-object', classNumber: 36, regionId, data: JSON.stringify({ fields: { name: 'Chest' } }) });
  assert.equal(response.status, 200);
  const id = response.value.result.id;
  const values = [
    { id: 99 }, { classNumber: 27 }, { ownerId: f.bob.id }, { containerId: f.bob.id }, { regionId: 2 },
    { virtualGhost: true }, { archivedIn: id }, { deleted: true }, { role: 'admin' },
    { fields: { noid: 15 } }, { fields: { container_noid: 15 } }, { fields: { classNumber: 22 } },
    { fields: { object_info: 1 } }, { fields: { unknownField: 'x' } }, { fields: { name: 'x'.repeat(32) } },
    { fields: { imageURL: 'missing.img' } }, { fields: { position: [32768, 0, 0] } },
    { fields: null }, { properties: [] }, { capacity: null }, { capacity: 11 }, { portable: 'true' }, { cashReserve: -1 },
  ];
  const before = f.server.worldStore.snapshot();
  for (const value of values) {
    const result = await f.request('/api/world', { action: 'update-object', id, data: JSON.stringify(value) });
    assert.equal(result.status, 400, JSON.stringify(value));
    assert.deepEqual(f.server.worldStore.snapshot(), before);
  }
  for (const data of ['{"properties":{"__proto__":{"admin":true}}}', '{"properties":{"nested":{"constructor":1}}}', '[]', 'null', '{bad']) {
    assert.equal((await f.request('/api/world', { action: 'update-object', id, data })).status, 400);
    assert.deepEqual(f.server.worldStore.snapshot(), before);
  }
  assert.equal(Object.prototype.admin, undefined);
  f.role('builder');
  assert.equal((await f.request('/api/world', { action: 'update-object', id, data: '{"cashReserve":1}' })).status, 400);
});

test('new regions validate native fields and preserve a matching root identity', async t => {
  const f = await fixture(t); f.role('admin');
  const before = f.server.worldStore.snapshot();
  for (const fields of [{ classNumber: 27 }, { noid: 5 }, { name: 'Alias' }, { imageURL: 'missing.img' }, { horizon: 65536 }, { anything: 1 }]) {
    const response = await f.request('/api/world', { action: 'create-region', name: 'API room', fields: JSON.stringify(fields) });
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.deepEqual(f.server.worldStore.snapshot(), before);
  }
  let response = await f.request('/api/world', { action: 'create-region', name: 'API room', fields: '{"horizon":77}', properties: '{"address":"api-room"}' });
  assert.equal(response.status, 200);
  const region = response.value.region, root = f.server.worldStore.getObject(region.objectId);
  assert.equal(root.classNumber, 20);
  assert.equal(root.fields.classNumber, 20);
  assert.equal(root.fields.name, 'API room');
  assert.equal(root.fields.horizon, 77);
  await f.restart();
  assert.equal(f.server.worldStore.getRegion(region.id).properties.address, 'api-room');
});

test('failed API world writes roll back state and IDs while retaining valid last-good backup', async t => {
  const f = await fixture(t); f.role('admin');
  const store = f.server.worldStore, before = store.snapshot(), bytes = fs.readFileSync(store.filename);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === store.filename) { const error = new Error('injected write failure'); error.code = 'EACCES'; throw error; }
    return rename(from, to);
  });
  const response = await f.request('/api/world', { action: 'create-object', classNumber: 27, regionId: before.startRegionId,
    data: '{"fields":{"name":"Uncommitted"}}' });
  assert.equal(response.status, 500);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(fs.readFileSync(store.filename), bytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.backupFilename, 'utf8')), before);
  t.mock.restoreAll();
  await f.restart();
  assert.equal(f.server.worldStore.snapshot().next.object, before.next.object);
  assert.ok(!f.server.worldStore.listObjects().some(object => object.fields.name === 'Uncommitted'));
});

test('operator deletion refuses undelivered parcels and logical binder references', async t => {
  const f = await fixture(t); f.role('admin');
  const store = f.server.worldStore, regionId = store.snapshot().startRegionId;
  const parcel = store.createObject({ classNumber: 27, regionId, fields: { name: 'Parcel' } });
  const mail = store.sendMail(f.bob.id, f.demo.id, { subject: 'Physical parcel' });
  store.transaction(draft => { draft.mail[mail.id].objectId = parcel.id; draft.objects[parcel.id].archivedIn = 'postbox'; });
  assert.equal((await f.request('/api/world', { action: 'delete-object', id: parcel.id })).status, 409);
  const binder = store.createObject({ classNumber: 37, regionId, fields: { name: 'Binder' } });
  const page = store.createObject({ classNumber: 37, regionId, fields: { name: 'Page' } });
  store.transaction(draft => {
    draft.documents[binder.id] = { objectId: binder.id, title: 'Binder', text: '', entries: [page.id] };
    draft.objects[page.id].archivedIn = binder.id;
  });
  assert.equal((await f.request('/api/world', { action: 'delete-object', id: binder.id, recursive: 'true' })).status, 409);
  assert.equal((await f.request('/api/world', { action: 'delete-object', id: page.id })).status, 409);
  assert.ok(store.getObject(parcel.id) && store.getObject(binder.id) && store.getObject(page.id));
});
