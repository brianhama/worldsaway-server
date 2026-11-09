import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorldsAwayServer } from '../dist/src/server.js';
import { makeConfig, environmentConfig } from '../dist/src/config.js';
import { parseArgs } from '../dist/src/cli.js';

test('public HTTP origin and a shared native TCP proxy do not change the bound listener ports', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-public-handoff-'));
  const server = createWorldsAwayServer({ dataDir: directory, httpPort: 0, worldPort: 0, rpcPort: 0,
    advertiseHost: 'worldsaway.proxy.example', advertiseWorldPort: 32456, advertiseRpcPort: 32456,
    publicUrl: 'https://worldsaway-backend.example/' });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await server.start();
  assert.equal(server.baseUrl, 'https://worldsaway-backend.example');
  assert.equal(new Set(Object.values(server.addresses)).size, 3);
  assert(Object.values(server.addresses).every(port => port > 0 && port !== 32456));
  const response = await server.handleHttpRequest({ path: '/worlds3.php' });
  assert.match(response.body.toString(), /^WorldsAway\.app\|https:\/\/worldsaway-backend\.example\/login\|/);
  const account = server.store.account('demo'), avatar = server.store.findAvatar(account, 'Demo');
  const connection = server.connectionFile(account, avatar).toString('ascii');
  assert.match(connection, /serveraddr=worldsaway\.proxy\.example\r\n/);
  assert.match(connection, /loginport=32456\r\n/); assert.match(connection, /rpcport=32456\r\n/);
  const health = await (await fetch(`http://127.0.0.1:${server.addresses.httpPort}/health`)).json();
  assert.equal(health.worldPort, server.addresses.worldPort); assert.equal(health.rpcPort, server.addresses.rpcPort);
});

test('public handoff environment and CLI options preserve explicit port overrides and normalize the public origin', () => {
  const env = environmentConfig({ WORLDSAWAY_ADVERTISE_WORLD_PORT: '32000', WORLDSAWAY_ADVERTISE_RPC_PORT: '32000', WORLDSAWAY_PUBLIC_URL: 'https://worldsaway.example/' });
  assert.deepEqual(env, { advertiseWorldPort: 32000, advertiseRpcPort: 32000, publicUrl: 'https://worldsaway.example/' });
  const config = makeConfig({ ...env, ...parseArgs(['--advertise-world-port', '33000', '--advertise-rpc-port', '33000', '--public-url', 'https://new-world.example/']) });
  assert.equal(config.advertiseWorldPort, 33000); assert.equal(config.advertiseRpcPort, 33000); assert.equal(config.publicUrl, 'https://new-world.example');
  assert.equal(makeConfig({ publicUrl: 'http://127.0.0.1:8180/' }).publicUrl, 'http://127.0.0.1:8180');
});

test('advertised port and public origin validation reject ambiguous or credential-bearing handoffs', () => {
  for (const name of ['advertiseWorldPort', 'advertiseRpcPort']) for (const value of [0, -1, 65536, 3.5, '1701']) {
    assert.throws(() => makeConfig({ [name]: value }), /integer/);
  }
  for (const publicUrl of ['ftp://world.example', 'https://user:password@world.example', 'https://world.example/path', 'https://world.example/?token=secret', 'https://world.example/#fragment', 'http://public.example']) {
    assert.throws(() => makeConfig({ publicUrl }), /publicUrl/);
  }
  assert.throws(() => environmentConfig({ WORLDSAWAY_ADVERTISE_RPC_PORT: 'not-a-port' }), /integer/);
});
