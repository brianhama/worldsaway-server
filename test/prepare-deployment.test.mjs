import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareDeploymentContext } from '../dist/scripts/prepare-deployment.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worldsaway-deployment-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'checkout'), destination = path.join(directory, 'output/context');
  const write = (relative, bytes) => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  };
  for (const name of ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json']) write(name, '{}\n');
  write('src/server.ts', 'export const server = true;\n');
  write('scripts/build.ts', 'export const build = true;\n');
  write('protocol/browser-requests.json', '{}\n');
  write('content/altaway-regions-2026-11-08.json', JSON.stringify({ schemaVersion: 1, regions: [{ id: 'example' }], schemaCatalog: {} }));
  const payload = Buffer.from('synthetic resource'), header = Buffer.alloc(12);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header.writeUInt32BE(payload.length, 8);
  const profile = createHash('sha256').update('wa-resource-profile-v1\0').update(header).update(createHash('sha256').update(payload).digest()).digest('hex');
  write('resources/payload.bin', payload);
  write('resources/manifest.json', JSON.stringify({ format: 'worldsaway-resource-pack-1', resourceProfile: profile,
    resourceCursor: 1, summary: {}, payload: { filename: 'payload.bin', length: payload.length, sha256: sha(payload) },
    records: [{ id: 1, version: 1, offset: 0, length: payload.length, sha256: sha(payload) }], files: [] }));
  return { root, directory, destination, write };
}

test('prepared context includes verified build inputs and assets while omitting private files', t => {
  const { root, destination, write } = fixture(t);
  const privateFiles = ['data/accounts.json', '.git/config', '.env', 'node_modules/secret.ts', 'docs/private.json',
    'src/.env', 'src/notes.txt', 'scripts/session.iv', 'protocol/.env', 'resources/accounts.json', 'content/private.json'];
  for (const filename of privateFiles) write(filename, 'PRIVATE SENTINEL');
  write('src/nested/module.ts', 'export const nested = 1;\n');
  const result = prepareDeploymentContext(destination, root);
  assert.equal(result.contextDirectory, destination);
  assert.equal(result.manifestFile, `${destination}.manifest.json`);
  assert.equal(result.surveyRegions, 1, 'preparation accepts a valid survey without hardcoding the current region count');
  assert.deepEqual(result.files.map(file => file.path), [
    '.dockerignore', 'Dockerfile', 'content/altaway-regions-2026-11-08.json', 'package-lock.json', 'package.json',
    'protocol/browser-requests.json', 'resources/manifest.json', 'resources/payload.bin', 'scripts/build.ts',
    'src/nested/module.ts', 'src/server.ts', 'tsconfig.json',
  ]);
  for (const filename of privateFiles) assert.equal(fs.existsSync(path.join(destination, filename)), false, filename);
  assert.equal(result.bytes, result.files.reduce((total, file) => total + file.bytes, 0));
  for (const file of result.files) {
    const copied = fs.readFileSync(path.join(destination, file.path));
    assert.deepEqual(copied, fs.readFileSync(path.join(root, file.path)));
    assert.equal(file.bytes, copied.length);
    assert.equal(file.sha256, sha(copied));
  }
  const manifest = JSON.parse(fs.readFileSync(result.manifestFile));
  assert.deepEqual(manifest.files, result.files);
  assert.equal(fs.readdirSync(destination).some(name => name.includes('manifest')), false, 'deployment inventory stays outside the upload');
});

test('missing required assets fail with an actionable message before creating output', t => {
  const { root, destination } = fixture(t);
  fs.unlinkSync(path.join(root, 'content/altaway-regions-2026-11-08.json'));
  assert.throws(() => prepareDeploymentContext(destination, root), /Missing deployment input: content\/.*Restore the local survey/);
  assert.equal(fs.existsSync(path.dirname(destination)), false);
});

test('existing destinations and destinations inside the checkout are refused without overwriting', t => {
  const { root, destination, write } = fixture(t);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'retained'), 'keep');
  assert.throws(() => prepareDeploymentContext(destination, root), /fresh destination/);
  assert.equal(fs.readFileSync(path.join(destination, 'retained'), 'utf8'), 'keep');
  assert.throws(() => prepareDeploymentContext(path.join(root, 'deployment'), root), /outside the repository/);
  write('unchanged', 'keep');
  assert.equal(fs.existsSync(path.join(root, 'deployment')), false);
});

test('invalid resource packs and survey documents fail before creating output', t => {
  const { root, destination, write } = fixture(t);
  const payload = fs.readFileSync(path.join(root, 'resources/payload.bin'));
  write('resources/payload.bin', Buffer.alloc(payload.length));
  assert.throws(() => prepareDeploymentContext(destination, root), /Invalid deployment resource pack:.*hash mismatch/);
  assert.equal(fs.existsSync(destination), false);
  write('resources/payload.bin', payload);
  write('content/altaway-regions-2026-11-08.json', '{"schemaVersion":1,"regions":[]}');
  assert.throws(() => prepareDeploymentContext(destination, root), /Invalid deployment survey/);
  assert.equal(fs.existsSync(destination), false);
});

test('symlinks cannot introduce outside files through source directories or required assets', t => {
  const { root, directory, destination } = fixture(t);
  const secret = path.join(directory, 'private.ts');
  fs.writeFileSync(secret, 'PRIVATE SENTINEL');
  fs.symlinkSync(secret, path.join(root, 'src/linked.ts'));
  assert.throws(() => prepareDeploymentContext(destination, root), /Symlinks are not allowed/);
  assert.equal(fs.existsSync(destination), false);
  fs.unlinkSync(path.join(root, 'src/linked.ts'));
  fs.unlinkSync(path.join(root, 'resources/payload.bin'));
  fs.symlinkSync(secret, path.join(root, 'resources/payload.bin'));
  assert.throws(() => prepareDeploymentContext(destination, root), /regular file, without symlinks/);
  assert.equal(fs.existsSync(destination), false);
});
