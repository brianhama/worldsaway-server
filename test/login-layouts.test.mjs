import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseLogin, parseAvatarEntry, ProtocolError } from '../dist/src/protocol.js';
import { createCompatibilityServer } from './helpers/fixtures.mjs';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../wa');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Independent fixtures: packed CUTESI fields occupy282/70 bytes; native stack
// construction appends six/two additional bytes without moving any fields.
function loginBody(size, account = 'layout_account', token = 'ticket-secret') {
  const body = Buffer.alloc(size);
  body.write(account, 0, 255, 'ascii'); body.write(token, 256, 15, 'ascii');
  body.writeUInt32BE(0xa1b2c3d4, 272); body.writeUInt16BE(0x1234, 276);
  body.writeUInt16BE(2, 278); body.writeUInt16BE(325, 280);
  return body;
}
function entryBody(size, name = 'Layout Avatar') {
  const body = Buffer.alloc(size); body.write(name, 0, 31, 'ascii');
  body.writeUInt32BE(0x10203040, 32); body.writeUInt16BE(0x3456, 36);
  body.write('test-machine', 38, 31, 'ascii'); return body;
}
function packet(noid, id, body) {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(noid); header.writeUInt16BE(id, 2); header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

test('packed and native login layouts preserve account/token bounds and scalar byte offsets', () => {
  for (const size of [282, 288]) {
    assert.deepEqual(parseLogin(loginBody(size)), { account: 'layout_account', token: 'ticket-secret',
      resourceCursor: 0xa1b2c3d4, locale: 0x1234, architecture: 2, version: 325 });
    const maximum = parseLogin(loginBody(size, 'a'.repeat(255), 't'.repeat(15)));
    assert.equal(maximum.account.length, 255); assert.equal(maximum.token.length, 15);
    const minimum = parseLogin(loginBody(size, 'a', 't'));
    assert.equal(minimum.account, 'a'); assert.equal(minimum.token, 't');
  }
});

test('packed and native avatar selection layouts preserve name and region offsets', () => {
  for (const size of [70, 72]) {
    assert.deepEqual(parseAvatarEntry(entryBody(size)), { name: 'Layout Avatar', region: 0x10203040 });
    assert.equal(parseAvatarEntry(entryBody(size, 'n'.repeat(31))).name.length, 31);
  }
});

test('all other login/selection sizes are rejected with actual size and no identifier contents', () => {
  for (const [parse, sizes] of [[parseLogin, [0, 1, 70, 72, 272, 281, 283, 287, 289, 512]],
    [parseAvatarEntry, [0, 1, 32, 69, 71, 73, 282, 288]]]) {
    for (const size of sizes) {
      const body = Buffer.alloc(size); Buffer.from('do-not-echo-this').copy(body);
      assert.throws(() => parse(body), error => error instanceof ProtocolError
        && new RegExp(`\\b${size}\\b`).test(error.message) && !error.message.includes('do-not-echo-this'));
    }
  }
});

function captured(server) {
  const packets = [], streamed = new Map(); let closed = false;
  const connection = server.createWorldSession(async bytes => {
    for (let offset = 0; offset < bytes.length;) {
      assert.ok(offset + 8 <= bytes.length, 'Complete response frame header');
      const noid = bytes.readUInt16BE(offset), id = bytes.readUInt16BE(offset + 2), size = bytes.readUInt32BE(offset + 4);
      const body = bytes.subarray(offset + 8, offset + 8 + size);
      assert.equal(body.length, size, 'Complete response frame body');
      if (noid === 10 && id === 17) {
        const resourceId = body.readUInt32BE(0), version = body.readUInt32BE(4);
        const total = body.readUInt32BE(8), length = body.readUInt32BE(12);
        assert.equal(body.length, 16 + length);
        let resource = streamed.get(resourceId);
        if (!resource) {
          assert.ok(total > 0 && total !== 0xffffffff, 'First resource chunk declares its full length');
          resource = { version, total, received: 0, hash: createHash('sha256') }; streamed.set(resourceId, resource);
        } else { assert.equal(resource.version, version); assert.ok(total === 0 || total === 0xffffffff); }
        resource.received += length; resource.hash.update(body.subarray(16));
      } else packets.push({ noid, id, body: Buffer.from(body) });
      offset += 8 + size;
    }
  }, () => { closed = true; });
  return { connection, packets, streamed, get closed() { return closed; } };
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-login-layouts-'));
  const logs = [];
  const server = createCompatibilityServer({ clientDir, dataDir, httpPort: 0, worldPort: 0, rpcPort: 0,
    log: (event, details) => logs.push({ event, details }) });
  t.after(async () => { await server.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const account = server.store.createAccount('layout_account', 'test-password');
  server.store.createAvatar(account, 'Layout Avatar');
  const response = await server.handleHttpRequest({ method: 'POST', path: '/connect.iv',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: Buffer.from(new URLSearchParams({ account: account.name, password: 'test-password', avatar: 'Layout Avatar' }).toString()) });
  assert.equal(response.status, 200);
  const ticketLine = response.body.toString('ascii').split(/\r?\n/).find(line => line.startsWith('onetimepass='));
  assert.ok(ticketLine); return { server, account, token: ticketLine.slice('onetimepass='.length), logs };
}

for (const [loginSize, entrySize] of [[282, 70], [282, 72], [288, 70], [288, 72]]) {
  test(`fragmented/coalesced ${loginSize}/${entrySize} session completes resource bootstrap and rejects ticket replay`, async t => {
    const f = await fixture(t), client = captured(f.server);
    const login = packet(10, 11, loginBody(loginSize, f.account.name, f.token));
    const entry = entryBody(entrySize); entry.writeUInt32BE(1, 32);
    const input = Buffer.concat([login, packet(10, 13, entry)]);
    // The final fragment contains the login tail and complete avatar selection.
    let previous = 0;
    for (const cut of [1, 7, 9, 27, 73, 281, input.length]) {
      await client.connection.feed(input.subarray(previous, cut)); previous = cut;
      if (cut < login.length) assert.equal(client.packets.length, 0);
    }
    assert.equal(client.closed, false);
    assert.equal(client.connection.client.resourceCursor, 0xa1b2c3d4);
    assert.equal(client.connection.client.locale, 0x1234);
    assert.deepEqual(client.packets.slice(0, 3).map(item => [item.noid, item.id]), [[10, 10], [10, 12], [10, 16]]);
    const admitted = f.server.resources.bootstrapResources(), start = client.packets.find(item => item.noid === 10 && item.id === 16);
    assert.equal(start.body.readUInt32BE(0), admitted.length);
    assert.equal(start.body.readUInt32BE(4), admitted.reduce((total, resource) => total + resource.data.length, 0));
    assert.equal(client.streamed.size, admitted.length);
    for (const resource of admitted) {
      const streamed = client.streamed.get(resource.id); assert.ok(streamed);
      assert.equal(streamed.version, resource.version); assert.equal(streamed.total, resource.data.length);
      assert.equal(streamed.received, resource.data.length); assert.equal(streamed.hash.digest('hex'), digest(resource.data));
    }
    assert.ok(client.packets.some(item => item.noid === 10 && item.id === 18), 'Bootstrap completion');
    assert.ok(client.packets.some(item => item.noid === 0 && item.id === 101), 'Entered native region');
    assert.equal(client.packets.some(item => item.id === 15), false);

    const replay = captured(f.server); await replay.connection.feed(login);
    assert.equal(replay.closed, true); assert.equal(replay.streamed.size, 0);
    const rejected = replay.packets.find(item => item.noid === 10 && item.id === 15);
    assert.ok(rejected); assert.match(rejected.body.toString('ascii'), /ticket.*already used/i);
    assert.equal(rejected.body.includes(Buffer.from(f.token)), false);
    assert.equal(client.closed, false);
  });
}

test('invalid frame body sizes report the size and leave the HTTP-issued ticket usable', async t => {
  const f = await fixture(t), bad = captured(f.server);
  const malformed = Buffer.concat([loginBody(282, f.account.name, f.token), Buffer.alloc(1)]);
  await bad.connection.feed(packet(10, 11, malformed));
  assert.equal(bad.closed, true);
  const failure = bad.packets.find(item => item.id === 15)?.body.toString('ascii');
  assert.ok(failure); assert.match(failure, /\b283\b/);
  assert.equal(failure.includes(f.account.name), false); assert.equal(failure.includes(f.token), false);
  const diagnostic = f.logs.find(item => item.event === 'login-error');
  assert.ok(diagnostic); assert.equal(diagnostic.details.bytes, 283);
  assert.match(diagnostic.details.reason, /\b283\b/);
  const logged = JSON.stringify(diagnostic);
  assert.equal(logged.includes(f.account.name), false); assert.equal(logged.includes(f.token), false);
  const retry = captured(f.server); await retry.connection.feed(packet(10, 11, loginBody(282, f.account.name, f.token)));
  assert.equal(retry.closed, false); assert.ok(retry.packets.some(item => item.id === 12));
  await retry.connection.feed(packet(10, 13, Buffer.alloc(71)));
  const entryFailure = retry.packets.find(item => item.id === 15)?.body.toString('ascii');
  assert.equal(retry.closed, true); assert.match(entryFailure, /\b71\b/);
  assert.equal(entryFailure.includes(f.account.name), false); assert.equal(entryFailure.includes(f.token), false);
});
