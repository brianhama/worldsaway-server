import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeConfig } from '../dist/src/config.js';
import { PackedResourceStore, exportResourcePack, loadServerResources } from '../dist/src/resource-pack.js';
import { ClassRegistry } from '../dist/src/classes.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const resources = new PackedResourceStore(path.join(root, 'resources'));
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-pack-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('portable pack preserves every class, message, resource version and native asset checksum', t => {
  const directory = fixture(t), pack = path.join(directory, 'resources');
  const result = exportResourcePack(resources, pack), loaded = new PackedResourceStore(pack);
  assert.equal(result.magResources, 1637); assert.equal(result.fileAssets, 3538);
  assert.equal(loaded.getFile('H.AbrahamR.img').length, 6232, 'latest image additions remain in the portable pack');
  assert.equal(loaded.getFile('O.GRND05.img').length, 33027, 'latest image payloads replace older versions');
  assert.equal(loaded.getFile('o.dog1.img').length, 74932, 'existing world images absent from the latest archive remain available');
  assert.equal(loaded.resourceProfile, resources.resourceProfile);
  assert.deepEqual(loaded.bootstrapResources(), resources.bootstrapResources());
  assert.deepEqual(loaded.listFileNames(), resources.listFileNames());
  for (const name of loaded.listFileNames()) assert.deepEqual(loaded.getFileInfo(name), resources.getFileInfo(name));
  assert.equal(new ClassRegistry(loaded).summary.classes, 58);
  assert.equal(new ClassRegistry(loaded).summary.messages, 710);
  assert.throws(() => exportResourcePack(resources, pack), /exist/);
  const item = loaded.getResource(0x10014); item.data.fill(255);
  assert.notDeepEqual(loaded.getResource(0x10014).data, item.data);
  assert.equal(loaded.getFile('../accounts.json'), null);
});

test('payload corruption, record extents, duplicate identities and native checksum changes are rejected', t => {
  const directory = fixture(t), pack = path.join(directory, 'resources');
  exportResourcePack(resources, pack);
  const manifestPath = path.join(pack, 'manifest.json'), original = JSON.parse(fs.readFileSync(manifestPath));
  for (const mutate of [
    manifest => { manifest.records[0].offset = 1; },
    manifest => { manifest.records[1].id = manifest.records[0].id; },
    manifest => { manifest.files[0].name = '../private'; },
    manifest => { manifest.files[0].checksum ^= 1; },
    manifest => { manifest.resourceProfile = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    fs.writeFileSync(manifestPath, JSON.stringify(changed));
    assert.throws(() => new PackedResourceStore(pack), /Invalid|mismatch/);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(original));
  const fd = fs.openSync(path.join(pack, 'payload.bin'), 'r+');
  try { fs.writeSync(fd, Buffer.from([255]), 0, 1, 0); } finally { fs.closeSync(fd); }
  assert.throws(() => new PackedResourceStore(pack), /hash mismatch/);
});

test('explicit original-cache configuration is honored and a damaged installed pack never silently falls back', t => {
  const directory = fixture(t);
  const config = makeConfig({ resourcePackDir: directory, clientDir: path.join(directory, 'absent') });
  fs.writeFileSync(path.join(directory, 'manifest.json'), '{broken');
  assert.throws(() => loadServerResources(config), /Invalid resource manifest/);
  assert.equal(makeConfig({ clientDir: path.join(directory, 'absent') }).resourcePackDir, null);
});

test('compiled-only server starts, serves discovery and accepts native login without source, dependencies or sibling caches', t => {
  const directory = fixture(t), standalone = path.join(directory, 'server'); fs.mkdirSync(standalone);
  // This is the production artifact layout, not a source checkout. It must run
  // on Node alone after the compiler and tsx development dependencies are gone.
  for (const name of ['dist', 'protocol', 'resources']) fs.cpSync(path.join(root, name), path.join(standalone, name), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(standalone, 'package.json'));
  const script = `
    import assert from 'node:assert/strict';
    import {createWorldsAwayServer} from './dist/src/server.js';
    import {frame,asciiField} from './dist/src/protocol.js';
    const server=createWorldsAwayServer({httpPort:0,worldPort:0,rpcPort:0});
    try {
      await server.start();
      const health=await (await fetch(server.baseUrl+'/health')).json();
      assert.equal(health.application,'WorldsAway.app'); assert.equal(health.resources.magResources,1637);
      const directory=await (await fetch(server.baseUrl+'/worlds3.php')).text(); assert.match(directory,/^WorldsAway.app\\|/);
      assert.equal(server.runtime.coverage.summary.classes,58);
      const output=[],session=server.createWorldSession(bytes=>output.push(Buffer.from(bytes)));
      const account=server.store.account('demo'),token=server.store.issueToken(account);
      const login=Buffer.alloc(282);asciiField('demo',256).copy(login);asciiField(token,16).copy(login,256);
      await session.feed(frame(10,11,login));assert.equal(session.account.name,'demo');
      const enter=Buffer.alloc(70);asciiField('Demo',32).copy(enter);enter.writeUInt32BE(1,32);
      await session.feed(frame(10,13,enter));assert.equal(session.regionId,1);assert(session.view.size>0);
      assert.equal(server.worldStore.snapshot().contentMigrations['worldsaway-districts-1'].id,'worldsaway-districts-1');
      console.log(JSON.stringify({application:health.application,classes:58,connected:true}));
    } finally { await server.close(); }
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: standalone, encoding: 'utf8', timeout: 30000 });
  assert.deepEqual(JSON.parse(output), { application: 'WorldsAway.app', classes: 58, connected: true });
  const accountData = JSON.parse(fs.readFileSync(path.join(standalone, 'data/accounts.json')));
  assert.equal(accountData.accounts[0].name, 'demo');
  assert(!JSON.stringify(accountData).includes('onetimepass'));
  assert.equal(fs.existsSync(path.join(standalone, 'src')), false);
  assert.equal(fs.existsSync(path.join(standalone, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(standalone, 'dist/data')), false, 'Compiled paths must keep durable state outside dist');
});
