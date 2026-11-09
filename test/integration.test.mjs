/** Native field checks deliberately decode bytes without production codecs. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCompatibilityServer, rawCacheAvailable, resourcePackDir } from './helpers/fixtures.mjs';

const CLIENT_DIR = fileURLToPath(new URL('../../wa', import.meta.url));

function fixed(value, width) {
  const output = Buffer.alloc(width);
  assert(Buffer.byteLength(value, 'ascii') < width);
  output.write(value, 'ascii');
  return output;
}

function frame(noid, message, body = Buffer.alloc(0)) {
  const output = Buffer.alloc(8 + body.length);
  output.writeUInt16BE(noid, 0);
  output.writeUInt16BE(message, 2);
  output.writeUInt32BE(body.length, 4);
  body.copy(output, 8);
  return output;
}

function login(account, token) {
  const body = Buffer.alloc(288);
  fixed(account, 256).copy(body);
  fixed(token, 16).copy(body, 256);
  body.writeUInt16BE(0, 276);
  body.writeUInt16BE(2, 278);
  body.writeUInt16BE(325, 280);
  return frame(10, 11, body);
}

function enter(name) {
  const body = Buffer.alloc(72);
  fixed(name, 32).copy(body);
  body.writeUInt32BE(1, 32);
  // Native machine-info is opaque, rather than necessarily zero padding.
  Buffer.from('independent native fixture').copy(body, 38);
  return frame(10, 13, body);
}

function frames(data) {
  const output = [];
  for (let cursor = 0; cursor < data.length;) {
    assert(cursor + 8 <= data.length, 'partial world header emitted');
    const noid = data.readUInt16BE(cursor);
    const id = data.readUInt16BE(cursor + 2);
    const size = data.readUInt32BE(cursor + 4);
    cursor += 8;
    assert(cursor + size <= data.length, 'partial world body emitted');
    output.push({ noid, id, body: data.subarray(cursor, cursor + size) });
    cursor += size;
  }
  return output;
}

function connectValues(body) {
  assert(Buffer.isBuffer(body));
  assert(body.subarray(0, 9).equals(Buffer.from('[Message]')));
  assert(body.length < 999, 'handoff exceeds legacy launcher response limit');
  assert(!body.includes(0) && !body.includes(37), 'native file includes a NUL or percent-format character');
  return Object.fromEntries(body.toString('ascii').split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

async function setup(t, extra = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wa-js-test-'));
  const server = createCompatibilityServer({ host: '127.0.0.1', advertiseHost: '127.0.0.1',
    httpPort: 0, worldPort: 0, rpcPort: 0, dataDir, clientDir: CLIENT_DIR, ...extra });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { server, dataDir };
}

async function request(server, pathname, params, method = 'POST') {
  const body = params === undefined ? Buffer.alloc(0) : Buffer.from(new URLSearchParams(params).toString());
  const response = await server.handleHttpRequest({ method: params === undefined ? 'GET' : method,
    path: pathname, headers: params === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }, body });
  return { ...response, body: Buffer.from(response.body ?? '') };
}

async function ticket(server, overrides = {}) {
  const response = await request(server, '/connect.iv', { account: 'demo', password: 'demo', avatar: 'Demo', ...overrides });
  assert.equal(response.status, 200, response.body.toString());
  return connectValues(response.body);
}

function session(server, kind = 'World') {
  const chunks = [];
  let closed = false;
  const connection = server[`create${kind}Session`](chunk => chunks.push(Buffer.from(chunk)), () => { closed = true; });
  return {
    connection,
    get data() { return Buffer.concat(chunks); },
    get closed() { return closed; },
    async feed(data, fragment = data.length || 1) {
      for (let index = 0; index < data.length; index += fragment) await connection.feed(data.subarray(index, index + fragment));
    },
  };
}

function assertLogin(packets) {
  const config = packets.filter(item => item.noid === 10 && item.id === 10);
  const list = packets.filter(item => item.noid === 10 && item.id === 12);
  assert.equal(config.length, 1);
  assert.equal(config[0].body.length, 16);
  assert.equal(list.length, 1);
  assert(list[0].body.length >= 276);
  assert.equal(list[0].body.readUInt32BE(4), 1, 'native numAvatars must be at offset 4');
  assert.equal(list[0].body.readUInt32BE(8), 3, 'native maxAvatars must be at offset 8');
  assert.equal(list[0].body.subarray(18, 50).toString('ascii').split('\0', 1)[0], 'Demo');
}

function assertBootstrapAndRegion(packets) {
  const start = packets.filter(item => item.noid === 10 && item.id === 16);
  assert.equal(start.length, 1);
  assert.equal(start[0].body.length, 8);
  const expectedCount = start[0].body.readUInt32BE(0);
  const expectedBytes = start[0].body.readUInt32BE(4);
  const assets = new Map();
  const arrival = [];
  let ended = false;
  let region = false;
  for (const packet of packets) {
    if (packet.noid === 10 && packet.id === 17) {
      assert(!ended, 'resource after update end');
      const body = packet.body;
      assert(body.length >= 16);
      const id = body.readUInt32BE(0);
      const version = body.readUInt32BE(4);
      const fullSize = body.readUInt32BE(8);
      const size = body.readUInt32BE(12);
      assert.equal(body.length, size + 16);
      assert(version > 0);
      if (!assets.has(id)) {
        assert(fullSize >= size && fullSize !== 0xffffffff);
        assets.set(id, { version, total: fullSize, chunks: [], size: 0 });
        arrival.push(id);
      } else {
        assert(fullSize === 0 || fullSize === 0xffffffff);
        assert.equal(assets.get(id).version, version);
      }
      assets.get(id).chunks.push(body.subarray(16));
      assets.get(id).size += size;
    } else if (packet.noid === 10 && packet.id === 18) {
      assert(!ended);
      assert.equal(assets.size, expectedCount);
      assert.equal([...assets.values()].reduce((sum, item) => sum + item.size, 0), expectedBytes);
      for (const asset of assets.values()) assert.equal(asset.size, asset.total);
      for (const id of [0x000a0005, 0x00050001, 0x00050002, 0x00010014]) assert(assets.has(id), `missing original asset ${id.toString(16)}`);
      assert(arrival.indexOf(0x000a0005) < arrival.indexOf(0x00050001));
      const schema = Buffer.concat(assets.get(0x000a0005).chunks).toString('ascii');
      assert(schema.includes('methodLen'), 'original methods require original type-5 schema');
      ended = true;
    } else if (packet.noid === 0 && packet.id === 101) {
      assert(ended, 'region must follow complete bootstrap');
      assert(packet.body.length >= 116);
      assert.equal(packet.body.length, 112 + packet.body.readUInt32BE(108));
      region = true;
    }
  }
  assert(ended && region, 'avatar must receive complete resources and RegionHereIs');
}

/** Small independent WSRES table reader for expected bytes, not ResourceStore. */
async function imageFixtures() {
  if (!rawCacheAvailable) {
    // Read expected bytes independently from the packed adapter and RPC code.
    const manifest = JSON.parse(await readFile(path.join(resourcePackDir, 'manifest.json'), 'utf8'));
    const payload = await readFile(path.join(resourcePackDir, 'payload.bin'));
    return manifest.files.map(file => ({ name: file.name, data: payload.subarray(file.offset, file.offset + file.length) }))
      .sort((left, right) => left.data.length - right.data.length).slice(0, 2);
  }
  const idx = await readFile(path.join(CLIENT_DIR, 'wsres/WS3AltA.idx'));
  const dat = await readFile(path.join(CLIENT_DIR, 'wsres/WS3AltA.dat'));
  assert.equal(idx.readUInt32LE(0), 0x50424958);
  const count = idx.readUInt32LE(4);
  const table = idx.readUInt32LE(8);
  const names = idx.subarray(idx.readUInt32LE(16), idx.readUInt32LE(16) + idx.readUInt32LE(20)).toString('ascii').split('\0');
  return Array.from({ length: count }, (_, index) => {
    const row = table + index * 28;
    const start = idx.readUInt32LE(row + 8);
    const size = idx.readUInt32LE(row + 16);
    return { name: names[index], data: dat.subarray(start, start + size) };
  }).sort((left, right) => left.data.length - right.data.length).slice(0, 2);
}

function rpcRequest(names, opcode = 0x31) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(opcode, 0);
  header.writeUInt32BE(names.length, 4);
  return Buffer.concat([header, ...names.map(name => fixed(name, 64))]);
}

function rpcReplies(data, expectedCount) {
  const replies = [];
  let cursor = 0;
  while (cursor < data.length) {
    assert(cursor + 76 <= data.length, 'short RPC reply header');
    const header = data.subarray(cursor, cursor + 76);
    cursor += 76;
    const status = header.readUInt32BE(0);
    const size = header.readUInt32BE(68);
    assert(cursor + size <= data.length, 'short RPC reply body');
    replies.push({ status, name: header.subarray(4, 68).toString('ascii').split('\0', 1)[0], data: data.subarray(cursor, cursor + size) });
    cursor += size;
  }
  assert.equal(replies.length, expectedCount);
  return replies;
}

test('HTTP world directory, native launcher login and fresh Connect tickets', async t => {
  const { server } = await setup(t);
  const health = await request(server, '/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).status, 'ok');
  const worlds = await request(server, '/worlds3.php?v=2.6.1-RC1');
  assert.equal(worlds.status, 200);
  const descriptor = worlds.body.toString().split(/\r?\n/).find(line => line.includes('|'))?.split('|');
  assert(descriptor?.length >= 5);
  assert(descriptor[1].endsWith('/login'));
  assert.equal(descriptor[2], 'wa32.exe');
  assert(!descriptor[3].includes('w'), 'direct server must not advertise unsupported tunnel mode');
  const native = await request(server, '/login', { username: 'demo', password: 'demo', action: 'Login' });
  assert.equal(native.status, 200);
  assert.equal(connectValues(native.body).acctname, 'demo');
  const first = await ticket(server);
  const second = await ticket(server);
  assert.notEqual(first.onetimepass, second.onetimepass);
  assert.match(first.onetimepass, /^[A-Za-z0-9_-]{15}$/);
  assert.equal(first.avatarname, 'Demo');
});

test('HTTP credentials and foreign avatar are rejected without issuing handoff', async t => {
  const { server } = await setup(t);
  const account = await server.store.createAccount('other', 'otherpass');
  await server.store.createAvatar(account, 'ForeignAvatar');
  for (const overrides of [{ password: 'wrong' }, { avatar: 'ForeignAvatar' }]) {
    const response = await request(server, '/connect.iv', { account: 'demo', password: 'demo', avatar: 'Demo', ...overrides });
    assert.notEqual(response.status, 200);
    assert(!response.body.subarray(0, 9).equals(Buffer.from('[Message]')));
  }
});

test('fragmented native login advertises correct counts and completes original bootstrap/region/logout', async t => {
  const { server } = await setup(t);
  const info = await ticket(server);
  const client = session(server);
  await client.feed(Buffer.concat([login('demo', info.onetimepass), enter('Demo'), frame(10, 19, Buffer.alloc(1)), frame(10, 20, Buffer.alloc(1))]), 3);
  const packets = frames(client.data);
  assertLogin(packets);
  assertBootstrapAndRegion(packets);
  assert(client.closed, 'logout closes session');
});

test('one-use tickets reject replay and a wrong-account attempt does not consume the right account ticket', async t => {
  const { server } = await setup(t);
  await server.store.createAccount('other', 'otherpass');
  const info = await ticket(server);
  const wrong = session(server);
  await wrong.feed(login('other', info.onetimepass));
  assert(!frames(wrong.data).some(item => item.noid === 10 && item.id === 12));
  assert(wrong.closed);
  const first = session(server);
  await first.feed(Buffer.concat([login('demo', info.onetimepass), frame(10, 20, Buffer.alloc(1))]));
  assertLogin(frames(first.data));
  const replay = session(server);
  await replay.feed(login('demo', info.onetimepass));
  assert(!frames(replay.data).some(item => item.noid === 10 && item.id === 12));
  assert(replay.closed);
});

test('avatar tickets enforce selected-avatar and account ownership', async t => {
  const { server } = await setup(t);
  const other = await server.store.createAccount('other', 'otherpass');
  await server.store.createAvatar(other, 'ForeignAvatar');
  const demo = await server.store.authenticate('demo', 'demo');
  await server.store.createAvatar(demo, 'Second');
  for (const avatar of ['ForeignAvatar', 'Second']) {
    const info = await ticket(server);
    const client = session(server);
    await client.feed(Buffer.concat([login('demo', info.onetimepass), enter(avatar)]));
    assert(!frames(client.data).some(item => (item.noid === 10 && item.id === 16) || (item.noid === 0 && item.id === 101)));
    assert(client.closed);
  }
});

test('expired ticket cannot advertise avatars', async t => {
  let now = Date.now();
  const { server } = await setup(t, { now: () => now, tokenTtlSeconds: 1 });
  const info = await ticket(server);
  now += 2000;
  const client = session(server);
  await client.feed(login('demo', info.onetimepass));
  assert(!frames(client.data).some(item => item.noid === 10 && item.id === 12));
  assert(client.closed);
});

test('busy avatar is advertised and cannot enter twice; logout releases it', async t => {
  const { server } = await setup(t);
  const firstTicket = await ticket(server);
  const first = session(server);
  await first.feed(Buffer.concat([login('demo', firstTicket.onetimepass), enter('Demo')]));
  assertBootstrapAndRegion(frames(first.data));
  const secondTicket = await ticket(server);
  const second = session(server);
  await second.feed(login('demo', secondTicket.onetimepass));
  const avatarPacket = frames(second.data).find(item => item.noid === 10 && item.id === 12);
  assert(avatarPacket);
  assert.equal(avatarPacket.body.readUInt32BE(12) & 1, 1, 'busy mask must mark the connected avatar');
  await second.feed(enter('Demo'));
  assert(!frames(second.data).some(item => item.noid === 0 && item.id === 101));
  assert(second.closed);
  await first.feed(frame(10, 20, Buffer.alloc(1)));
  const thirdTicket = await ticket(server);
  const third = session(server);
  await third.feed(Buffer.concat([login('demo', thirdTicket.onetimepass), enter('Demo'), frame(10, 20, Buffer.alloc(1))]));
  assertBootstrapAndRegion(frames(third.data));
});

test('unauthenticated avatar entry, malformed login and enormous world frame are rejected', async t => {
  const { server } = await setup(t);
  const enormous = Buffer.alloc(8);
  enormous.writeUInt16BE(10, 0);
  enormous.writeUInt16BE(11, 2);
  enormous.writeUInt32BE(0xffffffff, 4);
  for (const data of [enter('Demo'), frame(10, 11), enormous, login('demo', 'invalidTOKEN123')]) {
    const client = session(server);
    await client.feed(data, 2);
    assert(!frames(client.data).some(item => item.noid === 10 && item.id === 12));
    assert(client.closed);
  }
});

test('WA RPC sends consecutive 76-byte replies for one/two filename requests and denies traversal', async t => {
  const { server } = await setup(t);
  const fixtures = await imageFixtures();
  for (const batch of [fixtures.slice(0, 1), fixtures]) {
    const client = session(server, 'Rpc');
    await client.feed(rpcRequest(batch.map(item => item.name)), 1);
    const replies = rpcReplies(client.data, batch.length);
    for (let index = 0; index < batch.length; index += 1) {
      assert.equal(replies[index].status, 0);
      assert.equal(replies[index].name, batch[index].name);
      assert.deepEqual(replies[index].data, batch[index].data);
    }
    assert(client.closed);
  }
  for (const name of ['missing.img', '../aalogin.ini', '..\\aalogin.ini', '/etc/passwd']) {
    const client = session(server, 'Rpc');
    await client.feed(rpcRequest([name]));
    const [reply] = rpcReplies(client.data, 1);
    assert.notEqual(reply.status, 0);
    assert.equal(reply.data.length, 0);
  }
  const mixed = session(server, 'Rpc');
  await mixed.feed(rpcRequest(['missing.img', fixtures[0].name]));
  const [missing, found] = rpcReplies(mixed.data, 2);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.data.length, 0);
  assert.equal(found.status, 0);
  assert.deepEqual(found.data, fixtures[0].data);
});

test('invalid RPC batches and unterminated names close without publishing bytes', async t => {
  const { server } = await setup(t);
  for (const [opcode, count] of [[0x31, 0], [0x31, 3], [0x31, 0xffffffff], [0xffffffff, 1]]) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(opcode, 0);
    header.writeUInt32BE(count, 4);
    const client = session(server, 'Rpc');
    await client.feed(header);
    assert(client.closed);
    assert.equal(client.data.length, 0);
  }
  const client = session(server, 'Rpc');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0x31, 0);
  header.writeUInt32BE(1, 4);
  await client.feed(Buffer.concat([header, Buffer.alloc(64, 65)]));
  assert(client.closed);
  assert.equal(client.data.length, 0);
});

test('accounts and avatars persist across server restart', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wa-js-persist-'));
  const server = createCompatibilityServer({ dataDir, clientDir: CLIENT_DIR, httpPort: 0, worldPort: 0, rpcPort: 0 });
  let next;
  t.after(async () => { await next?.close(); await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const account = await server.store.createAccount('persist', 'persistpass');
  await server.store.createAvatar(account, 'Persistent');
  await server.close();
  next = createCompatibilityServer({ dataDir, clientDir: CLIENT_DIR, httpPort: 0, worldPort: 0, rpcPort: 0 });
  const response = await request(next, '/connect.iv', { account: 'persist', password: 'persistpass', avatar: 'Persistent' });
  assert.equal(response.status, 200);
  assert.equal(connectValues(response.body).avatarname, 'Persistent');
});

test('actual HTTP/world/RPC listeners accept an independent loopback client', async t => {
  const { server } = await setup(t);
  try { await server.start(); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip(`Host denies local listener binding: ${error.code}`); return; }
    throw error;
  }
  const { httpPort, worldPort, rpcPort } = server.addresses;
  assert(httpPort > 0 && worldPort > 0 && rpcPort > 0);
  const response = await fetch(`http://127.0.0.1:${httpPort}/connect.iv`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account: 'demo', password: 'demo', avatar: 'Demo' }),
  });
  assert.equal(response.status, 200);
  const info = connectValues(Buffer.from(await response.arrayBuffer()));
  assert.equal(Number(info.loginport), worldPort);
  assert.equal(Number(info.rpcport), rpcPort);
  const world = await socketExchange(worldPort, Buffer.concat([login('demo', info.onetimepass), enter('Demo'), frame(10, 20, Buffer.alloc(1))]));
  assertLogin(frames(world));
  assertBootstrapAndRegion(frames(world));
  const fixtures = await imageFixtures();
  const replies = rpcReplies(await socketExchange(rpcPort, rpcRequest(fixtures.map(item => item.name))), 2);
  assert.deepEqual(replies.map(item => item.data), fixtures.map(item => item.data));
});

function socketExchange(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    socket.setTimeout(5000, () => socket.destroy(new Error('Loopback exchange timed out')));
    socket.once('connect', () => socket.write(request));
    socket.on('data', data => chunks.push(data));
    socket.once('error', reject);
    socket.once('end', () => { socket.destroy(); resolve(Buffer.concat(chunks)); });
  });
}
