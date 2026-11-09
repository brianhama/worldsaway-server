import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ResourceStore, cacheChecksum, CacheFormatError } from '../dist/src/resources.js';
import { rawCacheAvailable, rawCacheSkipReason } from './helpers/fixtures.mjs';

function fixture(t, { checksum = 0x8d41097c, assetOffset = 4, status = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wa-js-resource-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'mag'));
  mkdirSync(join(root, 'wsres'));
  const payload = Buffer.from('sample\0');
  const mag = Buffer.alloc(1032 + payload.length + 4);
  mag.writeUInt16BE(0x644d, 0); mag.writeUInt16BE(19, 2); mag.writeUInt16BE(7, 4); mag.writeUInt16BE(1, 6);
  for (let slot = 0; slot < 64; slot++) mag.writeUInt32BE(0xffffffff, 8 + slot * 16);
  mag.writeUInt32BE(0x00050001, 8); mag.writeUInt32BE(7, 12); mag.writeUInt32BE(1032, 16); mag.writeUInt32BE(payload.length, 20);
  mag.write('sM', 1032); payload.copy(mag, 1034); mag.write('eM', 1034 + payload.length);
  writeFileSync(join(root, 'mag/cd050000.dat'), mag);
  const index = Buffer.alloc(2056);
  index.writeUInt16BE(0x694d, 0); index.writeUInt16BE(19, 2); index.writeUInt16BE(1, 4);
  for (let slot = 0; slot < 256; slot++) index.writeUInt16BE(0x3fff, 8 + slot * 8);
  index.writeUInt16BE(0, 16); index.writeUInt16BE(0, 18); index.writeUInt32BE(7, 20);
  // A stale slot refers to the same physical record with a different ID.
  index.writeUInt16BE(0, 24); index.writeUInt16BE(0, 26); index.writeUInt32BE(6, 28);
  writeFileSync(join(root, 'mag/widx0500.idx'), index);
  if (status) {
    const cursor = Buffer.alloc(12);
    cursor.writeUInt16BE(0x734d, 0); cursor.writeUInt16BE(19, 2); cursor.writeUInt16BE(1, 4); cursor.writeUInt32BE(12345, 8);
    writeFileSync(join(root, 'mag/w_status.dat'), cursor);
  }
  const name = Buffer.from('fixture.img\0');
  const wsIndex = Buffer.alloc(24 + 28 + name.length);
  wsIndex.writeUInt32LE(0x50424958, 0); wsIndex.writeUInt32LE(1, 4); wsIndex.writeUInt32LE(24, 8);
  wsIndex.writeUInt32LE(28, 12); wsIndex.writeUInt32LE(52, 16); wsIndex.writeUInt32LE(name.length, 20);
  wsIndex.writeUInt32LE(checksum, 24); wsIndex.writeUInt32LE(100, 28); wsIndex.writeUInt32LE(assetOffset, 32);
  wsIndex.writeUInt32LE(9, 40); wsIndex.writeUInt32LE(2, 44); name.copy(wsIndex, 52);
  const wsData = Buffer.alloc(13); wsData.writeUInt32LE(0x50424446); Buffer.from('fixture\0\xff', 'latin1').copy(wsData, 4);
  writeFileSync(join(root, 'wsres/test.idx'), wsIndex); writeFileSync(join(root, 'wsres/test.dat'), wsData);
  return { root, index, mag, wsIndex, wsData };
}

test('native checksum vectors retain the nonstandard initial/final convention', () => {
  assert.equal(cacheChecksum(Buffer.alloc(0)), 0);
  assert.equal(cacheChecksum(Buffer.from('123456789')), 0xfc7d2128);
  assert.equal(cacheChecksum(Buffer.from('fixture\0\xff', 'latin1')), 0x8d41097c);
  assert.equal(cacheChecksum(Buffer.from(Array.from({ length: 256 }, (_, i) => i))), 0x69305348);
});

test('MAG records require a matching ID/version index; WSRES bytes are exact', t => {
  const { root } = fixture(t, { status: true });
  const store = new ResourceStore({ clientDir: root });
  assert.equal(store.resourceCursor, 12345);
  assert.equal(store.summary.magResources, 1);
  assert.equal(store.summary.magIndexEntries, 2);
  assert.equal(store.summary.magIndexRejected, 1);
  assert.equal(store.getResource(0x00050002), null);
  assert.deepEqual(store.getResource(0x00050001), { id: 0x00050001, version: 7, data: Buffer.from('sample\0') });
  assert.deepEqual(store.getFile('fixture.img'), Buffer.from('fixture\0\xff', 'latin1'));
  assert.equal(store.getFileInfo('fixture.img').version, 100);
  assert.deepEqual(store.listFileNames(), ['fixture.img']);
  assert.match(store.resourceProfile, /^[a-f\d]{64}$/);
  assert.equal(store.resourceProfile, new ResourceStore({ clientDir: root }).resourceProfile);
  for (const bad of ['../fixture.img', '..\\fixture.img', '/fixture.img', 'C:fixture.img', 'fixture.img\0extra', 'Fixture.img']) {
    assert.equal(store.getFile(bad), null);
  }
  const changed = store.getResource(0x00050001); changed.data.fill(0);
  assert.equal(store.getResource(0x00050001).data.toString(), 'sample\0');
  store.getFile('fixture.img').fill(0);
  assert.deepEqual(store.getFile('fixture.img'), Buffer.from('fixture\0\xff', 'latin1'));
});

test('checksum-invalid and out-of-bounds filename rows are not published', t => {
  const first = fixture(t, { checksum: 0 });
  const corrupted = new ResourceStore({ clientDir: first.root });
  assert.equal(corrupted.getFile('fixture.img'), null);
  assert.equal(corrupted.summary.fileRejected, 1);
  const second = fixture(t, { assetOffset: 13 });
  assert.equal(new ResourceStore({ clientDir: second.root }).getFile('fixture.img'), null);
});

test('corrupt cache tables fail without accessing unrelated client files', t => {
  const { root, wsIndex } = fixture(t);
  writeFileSync(join(root, 'worlddb.idx'), Buffer.from('private remembered state'));
  wsIndex.writeUInt32LE(0xffffffff, 16);
  writeFileSync(join(root, 'wsres/test.idx'), wsIndex);
  assert.throws(() => new ResourceStore({ clientDir: root }), CacheFormatError);
});

test('MAG bounds/markers cannot turn an invalid record into a served resource', t => {
  const { root, mag } = fixture(t);
  mag.writeUInt32BE(0xffffffff, 20);
  writeFileSync(join(root, 'mag/cd050000.dat'), mag);
  assert.throws(() => new ResourceStore({ clientDir: root }), /No valid MAG resources/);
});

const originalClientDir = fileURLToPath(new URL('../../wa', import.meta.url));
test('supplied WA cache matches independent recovered inventories and schema ordering', {
  skip: rawCacheAvailable ? false : rawCacheSkipReason,
}, () => {
  const clientDir = originalClientDir;
  const store = new ResourceStore({ clientDir });
  assert.equal(store.summary.magResources, 1637);
  assert.equal(store.summary.magPayloadBytes, 3197919);
  assert.equal(store.summary.magIndexRejected, 4);
  assert.equal(store.summary.fileAssets, 3517);
  assert.equal(store.summary.filePayloadBytes, 47362045);
  assert.equal(store.summary.fileRejected, 0);
  assert.equal(store.summary.fileUncommittedNameBytes, 0);
  assert.equal(store.resourceCursor, 1788898711);
  const all = store.bootstrapResources();
  assert.equal(all.length, 1637);
  assert.ok(all.slice(0, 10).every(resource => resource.id >>> 16 === 10));
  assert.ok(all.slice(10).every(resource => resource.id >>> 16 !== 10));
  assert.equal(store.getResource(0x00050001).data.length, 23875);
  assert.equal(store.getResource(0x00010014).data.length, 720);
  assert.match(store.getClassSchema(20), /horizon/);
  assert.match(store.getClassSchema(22), /noid/);
  assert.equal(store.getFile('o.wwatm.img').length, 3281, 'latest cache commits the formerly incomplete ATM image');
  assert.equal(createHash('sha256').update(store.getFile('o.wwatm.img')).digest('hex'),
    'eb788b1e9abbe28c834be9d25aad8734965f9541cf5671a2fc86ea168952374e');
  assert.equal(store.getFile('o.skynew.img').length, 2916);
});

test('duplicate committed filenames are not exposed as unambiguous assets', t => {
  const { root, wsIndex } = fixture(t);
  const name = Buffer.from('fixture.img\0fixture.img\0');
  const duplicate = Buffer.alloc(24 + 56 + name.length);
  wsIndex.copy(duplicate, 0, 0, 24);
  duplicate.writeUInt32LE(2, 4); duplicate.writeUInt32LE(56, 12);
  duplicate.writeUInt32LE(80, 16); duplicate.writeUInt32LE(name.length, 20);
  wsIndex.copy(duplicate, 24, 24, 52); wsIndex.copy(duplicate, 52, 24, 52); name.copy(duplicate, 80);
  writeFileSync(join(root, 'wsres/test.idx'), duplicate);
  const store = new ResourceStore({ clientDir: root });
  assert.equal(store.getFile('fixture.img'), null);
  assert.equal(store.summary.fileAmbiguous, 1);
});

test('resource profile changes when resource bytes change under the same ID/version', t => {
  const { root, mag } = fixture(t);
  const original = new ResourceStore({ clientDir: root }).resourceProfile;
  mag[1034] ^= 1;
  writeFileSync(join(root, 'mag/cd050000.dat'), mag);
  assert.notEqual(new ResourceStore({ clientDir: root }).resourceProfile, original);
});

test('optional Ghost scene profile removes exactly its missing eager reference and preserves schema', {
  skip: rawCacheAvailable ? false : rawCacheSkipReason,
}, () => {
  const original = new ResourceStore({ clientDir: originalClientDir });
  const scene = new ResourceStore({ clientDir: originalClientDir, filterClassDependencies: [22] });
  const source = original.getResource(0x00010016);
  const served = scene.getResource(0x00010016);
  const sourceCount = source.data.readUInt16BE(48);
  const servedCount = served.data.readUInt16BE(48);
  assert.equal(servedCount, sourceCount - 1);
  assert.equal(served.version, source.version + 1);
  assert.equal(served.data.length, source.data.length - 4);
  assert.deepEqual(served.data.subarray(0, 48), source.data.subarray(0, 48));
  assert.deepEqual(served.data.subarray(50, 56), source.data.subarray(50, 56));
  assert.deepEqual(served.data.subarray(56 + servedCount * 4), source.data.subarray(56 + sourceCount * 4));
  const dependencies = Array.from({ length: servedCount }, (_, index) => served.data.readUInt32BE(56 + index * 4));
  assert.ok(!dependencies.includes(0x0005077f));
  assert.ok(dependencies.every(id => scene.getResource(id)));
  assert.equal(scene.getClassSchema(22), original.getClassSchema(22));
  assert.deepEqual(scene.getResource(0x00010015), original.getResource(0x00010015), 'Avatar class is unmodified');
  assert.deepEqual(scene.getResource(0x00010014), original.getResource(0x00010014), 'Region class is unmodified');
  assert.deepEqual(original.summary.sceneOverrides, []);
  assert.notEqual(scene.resourceProfile, original.resourceProfile);
  assert.equal(scene.summary.sceneOverrides.length, 1);
  const override = scene.summary.sceneOverrides[0];
  assert.equal(override.classNumber, 22);
  assert.equal(override.id, 0x00010016);
  assert.deepEqual(override.removed, [0x0005077f]);
  assert.equal(override.sourceHash, createHash('sha256').update(source.data).digest('hex'));
  assert.equal(override.servedHash, createHash('sha256').update(served.data).digest('hex'));
  assert.equal(scene.summary.magPayloadBytes, original.summary.magPayloadBytes - 4);
  assert.equal(scene.summary.sourceMagPayloadBytes, original.summary.magPayloadBytes);
  assert.deepEqual(original.getResource(0x00010016), source, 'Original store keeps its original bytes');
});
