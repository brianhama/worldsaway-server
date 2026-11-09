import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { defaultRuntimeDirectory, LaunchError, parseArgs, passwordFromStdin,
  prepareRuntime, readPassword, requestBuffer, runLauncher, serverUrl,
  validateConnection, validateWindowsConnectionPath, writeConnection } from '../dist/scripts/launch-client.js';

function connection(overrides = {}) {
  const info = { worldname: 'LocalWA', serveraddr: '127.0.0.1', loginport: '1701', rpcport: '1702',
    acctname: 'demo', username: 'demo', avatarname: 'Demo', loginregion: '1', onetimepass: 'ABCDEFGHIJKLMNO',
    ...overrides };
  return Buffer.from('[Message]\r\nmessagetype=Connect\r\n[Connect Info]\r\n' +
    Object.entries(info).map(([key, value]) => key + '=' + value + '\r\n').join(''), 'ascii');
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-launcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = path.join(root, 'original');
  const runtime = path.join(root, 'runtime');
  await fs.mkdir(client);
  await fs.writeFile(path.join(client, 'wa32.exe'), 'MZ test main client');
  await fs.writeFile(path.join(client, 'reno32.exe'), 'MZ test editor client');
  await fs.writeFile(path.join(client, 'worldsaw.fon'), 'test font');
  await fs.writeFile(path.join(client, 'postmort.exe'), 'MZ test helper');
  await fs.writeFile(path.join(client, 'sbtcls32.sdt'), 'Region 20');
  await fs.writeFile(path.join(client, 'aalogin.ini'), 'not to copy');
  await fs.mkdir(path.join(client, 'mag'));
  await fs.writeFile(path.join(client, 'mag', 'private.dat'), 'not to copy');
  await fs.mkdir(path.join(client, 'wsres'));
  await fs.writeFile(path.join(client, 'wsres', 'original.dat'), 'not to copy');
  return { root, client, runtime };
}

test('argument parsing rejects credential URLs and ambiguous password options', () => {
  assert.equal(serverUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  for (const url of ['ftp://localhost', 'https://user:secret@localhost', 'http://host/?password=x', 'http://host/#x']) {
    assert.throws(() => serverUrl(url), LaunchError);
  }
  assert.throws(() => parseArgs(['--demo', '--password-stdin']), LaunchError);
  assert.throws(() => parseArgs(['--server']), LaunchError);
  assert.throws(() => parseArgs(['--unknown']), LaunchError);
  assert.equal(parseArgs(['--editor']).editor, true);
  assert.match(defaultRuntimeDirectory('a'.repeat(64), { LOCALAPPDATA: 'C:\\Local' }), /aaaaaaaaaaaa/);
});

test('Connect validation enforces native field limits and rejects injected text', () => {
  assert.equal(validateConnection(connection()).avatarname, 'Demo');
  for (const body of [
    connection({ onetimepass: 'x'.repeat(16) }),
    connection({ serveraddr: 'x'.repeat(64) }),
    connection({ loginport: '65536' }),
    connection({ rpcport: '0' }),
    connection({ worldname: 'bad%name' }),
    Buffer.concat([connection(), Buffer.from('acctname=other\r\n')]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), connection()]),
    Buffer.from('[Message]\r\nmessagetype=Connect\r\n[Connect Info]\r\n'),
  ]) assert.throws(() => validateConnection(body), LaunchError);
});

test('quoted native path limit includes both quotes and disallows lossy ANSI paths', () => {
  const prefix = 'C:\\Folder with spaces\\';
  const filename = prefix + 'a'.repeat(277 - prefix.length - 3) + '.iv';
  assert.equal(filename.length, 277);
  assert.doesNotThrow(() => validateWindowsConnectionPath(filename));
  assert.throws(() => validateWindowsConnectionPath(filename + 'a'), LaunchError);
  assert.throws(() => validateWindowsConnectionPath('C:\\é\\connect.iv'), LaunchError);
});

test('handoff bytes are preserved and existing output files cannot be replaced', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'connect.iv');
  const body = connection();
  await writeConnection(body, file, { platform: 'linux' });
  assert.deepEqual(await fs.readFile(file), body);
  await assert.rejects(writeConnection(Buffer.from('replace'), file, { platform: 'linux' }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(file), body);
  await assert.rejects(writeConnection(body, path.join(root, 'bad.vz')), LaunchError);
});

test('runtime copies only client support files and binds existing caches to the profile', async t => {
  const { client, runtime } = await fixture(t);
  const first = await prepareRuntime(client, runtime, { resourceProfile: 'profile-a' });
  assert.equal(path.basename(first.executable), 'wa32.exe');
  assert.deepEqual((await fs.readdir(runtime)).sort(), ['postmort.exe', 'wa-compat-runtime.json', 'wa32.exe', 'worldsaw.fon']);
  const original = await fs.readFile(path.join(client, 'wa32.exe'));
  const before = (await fs.stat(first.executable)).mtimeMs;
  await prepareRuntime(client, runtime, { resourceProfile: 'profile-a' });
  assert.equal((await fs.stat(first.executable)).mtimeMs, before, 'unchanged EXE need not be replaced while Windows is running it');
  assert.deepEqual(await fs.readFile(path.join(client, 'wa32.exe')), original);
  await assert.rejects(prepareRuntime(client, runtime, { resourceProfile: 'profile-b' }), LaunchError);
  await assert.rejects(prepareRuntime(client, client), LaunchError);
});

test('unowned runtime directories are rejected; editor catalogs are explicitly copied', async t => {
  const { root, client, runtime } = await fixture(t);
  await fs.mkdir(runtime);
  await fs.writeFile(path.join(runtime, 'unrelated.txt'), 'preserve');
  await assert.rejects(prepareRuntime(client, runtime), LaunchError);
  assert.equal(await fs.readFile(path.join(runtime, 'unrelated.txt'), 'utf8'), 'preserve');
  const edited = await prepareRuntime(client, path.join(root, 'editor'), { editor: true });
  assert.equal(path.basename(edited.executable), 'reno32.exe');
  assert.equal(await fs.readFile(path.join(edited.runtimeDirectory, 'sbtcls32.sdt'), 'utf8'), 'Region 20');
  assert.equal((await fs.readdir(edited.runtimeDirectory)).includes('aalogin.ini'), false);
});

test('launcher submits an encoded password only in POST and spawns with one handoff argument', async t => {
  const { root, client, runtime } = await fixture(t);
  const password = 'a&b=secret #';
  const calls = [];
  const launched = [];
  const output = path.join(root, 'session.iv');
  const result = await runLauncher(['--server', 'http://localhost:8080', '--client-dir', client,
    '--runtime-dir', runtime, '--password-stdin', '--output', output], {
    platform: 'win32',
    passwordFromStdin: async () => password,
    request: async (url, body) => {
      calls.push({ url, body });
      return body === undefined ? Buffer.from('{"status":"ok","resourceProfile":"test-profile"}') : connection();
    },
    launch: async (...args) => launched.push(args),
  });
  assert.equal(calls[0].url, 'http://localhost:8080/health');
  assert.equal(calls[1].url, 'http://localhost:8080/connect.iv');
  assert.equal(calls[1].url.includes(password), false);
  assert.equal(new URLSearchParams(calls[1].body.toString()).get('password'), password);
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0][1], [output]);
  assert.equal(launched[0][2].cwd, await fs.realpath(runtime));
  assert.equal(launched[0][1].join(' ').includes(password), false);
  assert.equal(result.output, output);
  assert.deepEqual(await fs.readFile(output), connection());
});

test('download-only works without a Windows client and never invokes a process', async t => {
  const { root } = await fixture(t);
  const output = path.join(root, 'download.iv');
  let spawnCount = 0;
  await runLauncher(['--demo', '--download-only', '--client-dir', path.join(root, 'missing'), '--output', output], {
    platform: 'linux',
    request: async (url, body) => body === undefined ? Buffer.from('{"status":"ok"}') : connection(),
    launch: async () => spawnCount++,
  });
  assert.equal(spawnCount, 0);
  assert.deepEqual(await fs.readFile(output), connection());
  await assert.rejects(runLauncher(['--demo'], { platform: 'linux' }), LaunchError);
});

function fakeRequest(statusCode, data) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.end = body => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = statusCode;
      callback(response);
      response.end(data);
    });
    return req;
  };
}

test('HTTP helper refuses redirects, failed auth, and oversized responses', async () => {
  assert.deepEqual(await requestBuffer('http://localhost/health', undefined,
    { request: fakeRequest(200, Buffer.from('ok')) }), Buffer.from('ok'));
  for (const [status, bytes] of [[302, 'redirect'], [401, 'failed'], [200, Buffer.alloc(4097)]]) {
    await assert.rejects(requestBuffer('http://localhost/health', undefined,
      { request: fakeRequest(status, bytes) }), LaunchError);
  }
});

test('interactive password masking restores terminal mode; stdin mode reads one line', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  let printed = '';
  const promise = readPassword('demo', { input, output: { write: text => { printed += text; } } });
  input.write('secret\r');
  assert.equal(await promise, 'secret');
  assert.equal(input.isRaw, false);
  assert.equal(printed.includes('secret'), false);
  assert.match(printed, /\*{6}/);
  assert.equal(await passwordFromStdin(Readable.from(['first\r\nsecond\n'])), 'first');
});
