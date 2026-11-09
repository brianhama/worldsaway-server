import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorldsAwayServer } from '../dist/src/server.js';
import { environmentConfig, makeConfig } from '../dist/src/config.js';
import { asciiField, frame } from '../dist/src/protocol.js';

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-registration-'));
  const server = createWorldsAwayServer({ dataDir: directory, httpPort: 0, worldPort: 0, rpcPort: 0, ...options });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const post = (fields, extra = {}) => server.handleHttpRequest({ method: 'POST', path: '/api/register',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(new URLSearchParams(fields).toString()), ...extra });
  return { directory, server, post };
}
const input = () => ({ account: 'newplayer', password: 'Private 42', avatar: 'New Player' });

test('registration creates a hashed account and first avatar together, then native login creates an ordinary durable player', async t => {
  const f = fixture(t), response = await f.post(input());
  assert.equal(response.status, 201, response.body.toString());
  assert.deepEqual(JSON.parse(response.body), { application: 'WorldsAway.app', account: { name: 'newplayer' }, avatar: { name: 'New Player' }, capacity: 3 });
  const account = f.server.store.authenticate('NEWPLAYER', 'Private 42'), avatar = f.server.store.findAvatar(account, 'new player');
  assert(account); assert(avatar); assert.equal(account.capacity, 3);
  const saved = fs.readFileSync(path.join(f.directory, 'accounts.json'), 'utf8');
  assert(!saved.includes('Private 42')); assert(!response.body.toString().includes(account.hash));
  assert.match(account.salt, /^[a-f0-9]{32}$/); assert.match(account.hash, /^[a-f0-9]{64}$/);
  const beforeAccountFile = JSON.parse(saved); assert.equal(beforeAccountFile.nextAccount, 3); assert.equal(beforeAccountFile.nextAvatar, 3);
  const token = f.server.store.issueToken(account, avatar), output = [];
  const session = f.server.createWorldSession(bytes => output.push(Buffer.from(bytes)));
  const login = Buffer.alloc(282); asciiField(account.name, 256).copy(login); asciiField(token, 16).copy(login, 256);
  await session.feed(frame(10, 11, login));
  const enter = Buffer.alloc(70); asciiField(avatar.name, 32).copy(enter); enter.writeUInt32BE(1, 32);
  await session.feed(frame(10, 13, enter));
  assert.equal(session.regionId, f.server.worldStore.snapshot().startRegionId);
  assert.equal(f.server.worldStore.getAvatar(avatar.id).role, 'player');
  await f.server.close();
  const restarted = createWorldsAwayServer({ dataDir: f.directory, httpPort: 0, worldPort: 0, rpcPort: 0 });
  try {
    const restored = restarted.store.authenticate('newplayer', 'Private 42'); assert(restored);
    assert.equal(restarted.store.findAvatar(restored, 'New Player').id, avatar.id);
    assert.equal(restarted.worldStore.getAvatar(avatar.id).role, 'player');
  } finally { await restarted.close(); }
});

test('case-insensitive duplicate account or avatar names leave identities, counters and disk unchanged', async t => {
  const f = fixture(t);
  assert.equal((await f.post(input())).status, 201);
  const before = structuredClone(f.server.store.state), saved = fs.readFileSync(f.server.store.filename);
  for (const fields of [{ ...input(), account: 'NEWPLAYER', avatar: 'Unused Avatar' }, { ...input(), account: 'another', avatar: 'NEW PLAYER' }]) {
    assert.equal((await f.post(fields)).status, 409);
    assert.deepEqual(f.server.store.state, before); assert.deepEqual(fs.readFileSync(f.server.store.filename), saved);
  }
  assert.equal(f.server.store.account('another'), null);
});

test('native bounds and unauthorized registration fields fail before any account or avatar is saved', async t => {
  const f = fixture(t), before = structuredClone(f.server.store.state), saved = fs.readFileSync(f.server.store.filename);
  for (const fields of [
    { ...input(), account: '' }, { ...input(), account: 'a'.repeat(25) }, { ...input(), account: 'bad account' },
    { ...input(), password: '' }, { ...input(), password: 'a'.repeat(25) }, { ...input(), password: 'line\nbreak' },
    { ...input(), avatar: '' }, { ...input(), avatar: 'a'.repeat(30) }, { ...input(), avatar: 'Create New' },
    { ...input(), role: 'admin' }, { ...input(), capacity: '8' }, { ...input(), accountId: '1' },
  ]) {
    const response = await f.post(fields); assert.equal(response.status, 400, response.body.toString());
    assert.deepEqual(f.server.store.state, before); assert.deepEqual(fs.readFileSync(f.server.store.filename), saved);
  }
  assert.equal((await f.post({ account: 'x'.repeat(24), password: 'p'.repeat(24), avatar: 'A'.repeat(29) })).status, 201);
});

test('registration is POST-only, bounded, correctly encoded and rejects duplicate fields, query credentials and foreign browser origins', async t => {
  const f = fixture(t);
  assert.equal((await f.post(input(), { method: 'GET' })).status, 405);
  assert.equal((await f.post(input(), { headers: { 'content-type': 'application/json' } })).status, 415);
  assert.equal((await f.post(input(), { path: '/api/register?account=secret' })).status, 400);
  assert.equal((await f.post(input(), { body: Buffer.from('account=one&account=two&password=p&avatar=Name') })).status, 400);
  assert.equal((await f.post(input(), { body: Buffer.alloc(8193) })).status, 413);
  assert.equal((await f.post(input(), { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://foreign.example' } })).status, 403);
  assert.equal(f.server.store.account(input().account), null);
});

test('capabilities report disabled self-registration and neither disabled registrations nor injected failures partially commit', async t => {
  const disabled = fixture(t, { allowRegistration: false });
  const capabilities = JSON.parse((await disabled.server.handleHttpRequest({ path: '/api/capabilities' })).body);
  assert.equal(capabilities.application, 'WorldsAway.app'); assert.equal(capabilities.registration.enabled, false);
  assert.equal((await disabled.post(input())).status, 403); assert.equal(disabled.server.store.account(input().account), null);
  const f = fixture(t), before = structuredClone(f.server.store.state), saved = fs.readFileSync(f.server.store.filename);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === f.server.store.filename) throw new Error('injected registration disk failure');
    return rename(source, target);
  });
  try {
    assert.equal((await f.post(input())).status, 500);
    assert.deepEqual(f.server.store.state, before); assert.deepEqual(fs.readFileSync(f.server.store.filename), saved);
    assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
  } finally { t.mock.restoreAll(); }
  assert.equal((await f.post(input())).status, 201);
  assert.equal(f.server.store.account(input().account).id, before.nextAccount);
  assert.equal(f.server.store.findAvatar(f.server.store.account(input().account), input().avatar).id, before.nextAvatar);
});

test('registration environment flag accepts only explicit boolean values', () => {
  assert.equal(makeConfig(environmentConfig({ WORLDSAWAY_ALLOW_REGISTRATION: 'false' })).allowRegistration, false);
  assert.equal(makeConfig(environmentConfig({ WORLDSAWAY_ALLOW_REGISTRATION: 'true' })).allowRegistration, true);
  assert.throws(() => environmentConfig({ WORLDSAWAY_ALLOW_REGISTRATION: 'no' }), /true or false/);
  assert.throws(() => makeConfig({ allowRegistration: 'false' }), /boolean/);
});
