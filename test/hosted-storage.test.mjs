import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareHostedStorage } from '../dist/scripts/start-hosted.js';

test('exclusive hosted storage recovers a dead process lock while preserving all saved world bytes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-hosted-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = Buffer.from('{"saved":"world-data"}\n');
  fs.writeFileSync(path.join(directory, 'world.json'), saved);
  fs.writeFileSync(path.join(directory, 'server.lock'), '2147483647\n');
  prepareHostedStorage({ dataDir: directory, recoverStaleLock: true });
  assert.equal(fs.existsSync(path.join(directory, 'server.lock')), false);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'world.json')), saved);
});

test('hosted storage refuses a live lock owner and leaves unrecognized locks intact', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-hosted-storage-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lock = path.join(directory, 'server.lock');
  fs.writeFileSync(lock, `${process.ppid}\n`);
  assert.throws(() => prepareHostedStorage({ dataDir: directory, recoverStaleLock: true }), /Another process/);
  assert.equal(fs.readFileSync(lock, 'utf8'), `${process.ppid}\n`);
  fs.writeFileSync(lock, 'unknown\n');
  assert.throws(() => prepareHostedStorage({ dataDir: directory, recoverStaleLock: true }), /Unknown server lock/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'unknown\n');
  prepareHostedStorage({ dataDir: directory });
  assert.equal(fs.existsSync(lock), true);
});
