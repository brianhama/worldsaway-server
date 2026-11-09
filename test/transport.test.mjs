import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sendToSocket, createCompatibilityServer } from './helpers/fixtures.mjs';
import { makeConfig } from '../dist/src/config.js';

class Socket extends EventEmitter {
  destroyed = false;
  write() { return false; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('backpressure resolves on drain and rejects on close or error without leaked listeners', async () => {
  for (const mode of ['drain', 'close', 'error']) {
    const socket = new Socket();
    const waiting = sendToSocket(socket, Buffer.from('payload'));
    if (mode === 'error') socket.emit('error', new Error('socket failed'));
    else socket.emit(mode);
    if (mode === 'drain') await waiting;
    else await assert.rejects(waiting, mode === 'close' ? /closed/ : /socket failed/);
    for (const event of ['drain', 'close', 'error']) assert.equal(socket.listenerCount(event), 0);
  }
});

test('backpressure timeout destroys the socket and settles the write', async () => {
  const socket = new Socket();
  // Keep this fake-socket test alive; real sockets keep the event loop active.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(sendToSocket(socket, Buffer.alloc(1), 10), /timed out/);
    assert.equal(socket.destroyed, true);
    assert.equal(socket.listenerCount('close'), 0);
  } finally { clearTimeout(keepAlive); }
});

test('world names are safe shared Windows and archive cache basenames', () => {
  for (const worldName of ['Test (world)', 'Trailing.', 'Trailing ', 'NUL', 'CON.test', '../escape']) {
    assert.throws(() => makeConfig({ worldName }), /worldName/);
  }
  assert.equal(makeConfig({ worldName: 'Local WA-2' }).worldName, 'Local WA-2');
});

test('original launcher double-slash discovery and bounded form parsing work offline', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-js-http-'));
  const resources = { resourceProfile: 'fixture', summary: {}, bootstrapResources: () => [], listFileNames: () => [] };
  const server = createCompatibilityServer({ dataDir: directory, resources });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const list = await server.handleHttpRequest({ path: '//worlds3.php?v=2.6.1-RC1' });
  assert.equal(list.status, 200);
  assert.match(list.body.toString(), /^WorldsAway\.app\|http:\/\/127\.0\.0\.1:8080\/login\|wa32\.exe\|\|worldsaway-images\.zip/);
  assert.equal((await server.handleHttpRequest({ path: 'http://other/worlds3.php' })).status, 400);
  assert.equal((await server.handleHttpRequest({ method: 'POST', path: '/login', body: Buffer.alloc(8193) })).status, 413);
  const duplicate = await server.handleHttpRequest({ method: 'POST', path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: Buffer.from('username=demo&username=other&password=demo&action=Login') });
  assert.equal(duplicate.status, 400);
});
