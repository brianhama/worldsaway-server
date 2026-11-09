import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImageArchive, buildImageCache, crc32, nativeCacheChecksum } from '../dist/src/archives.js';

function bitwiseZipCrc(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

// Independent local-header/central-directory reader, without the production
// cache or ZIP parsing paths. No compression/data descriptor is permitted.
function readZip(zip) {
  const entries = [];
  let position = 0;
  while (zip.readUInt32LE(position) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(position + 6), 0);
    assert.equal(zip.readUInt16LE(position + 8), 0);
    const stored = zip.readUInt32LE(position + 18);
    assert.equal(stored, zip.readUInt32LE(position + 22));
    const nameLength = zip.readUInt16LE(position + 26);
    const extraLength = zip.readUInt16LE(position + 28);
    const name = zip.subarray(position + 30, position + 30 + nameLength).toString('ascii');
    const dataStart = position + 30 + nameLength + extraLength;
    const data = zip.subarray(dataStart, dataStart + stored);
    assert.equal(data.length, stored);
    assert.equal(bitwiseZipCrc(data), zip.readUInt32LE(position + 14));
    entries.push({ name, data, position });
    position = dataStart + stored;
  }
  const directoryOffset = position;
  for (const entry of entries) {
    assert.equal(zip.readUInt32LE(position), 0x02014b50);
    const nameLength = zip.readUInt16LE(position + 28);
    assert.equal(zip.subarray(position + 46, position + 46 + nameLength).toString('ascii'), entry.name);
    assert.equal(zip.readUInt32LE(position + 42), entry.position);
    assert.equal(zip.readUInt32LE(position + 24), entry.data.length);
    position += 46 + nameLength;
  }
  assert.equal(zip.readUInt32LE(position), 0x06054b50);
  assert.equal(zip.readUInt16LE(position + 8), entries.length);
  assert.equal(zip.readUInt16LE(position + 10), entries.length);
  assert.equal(zip.readUInt32LE(position + 12), position - directoryOffset);
  assert.equal(zip.readUInt32LE(position + 16), directoryOffset);
  assert.equal(position + 22, zip.length);
  return new Map(entries.map(entry => [entry.name, entry.data]));
}

function fixture() {
  const files = new Map([
    ['o.zed.img', { data: Buffer.from('123456789'), version: 77, checksum: 0xfc7d2128 }],
    ['o.alpha.img', { data: Buffer.from('abc'), version: 123, checksum: 0xca6598d0 }],
  ]);
  return { listFileNames: () => [...files.keys()], getFileInfo: name => files.get(name) ?? null, files };
}

test('ZIP CRC and native checksum have independently known, different vectors', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(nativeCacheChecksum(Buffer.from('123456789')), 0xfc7d2128);
  assert.equal(nativeCacheChecksum(Buffer.from('abc')), 0xca6598d0);
  assert.equal(nativeCacheChecksum(Buffer.from(Array.from({ length: 256 }, (_, n) => n))), 0x69305348);
});

test('image ZIP contains a compact committed WSRES pair and every original payload', () => {
  const store = fixture();
  const archive = buildImageArchive(store, 'Local WA');
  assert.deepEqual(archive, buildImageArchive(store, 'Local WA'), 'archive is reproducible');
  const zip = readZip(archive);
  assert.deepEqual([...zip.keys()], ['Local WA.idx', 'Local WA.dat']);
  const index = zip.get('Local WA.idx');
  const data = zip.get('Local WA.dat');
  assert.equal(index.readUInt32LE(0), 0x50424958);
  assert.equal(data.readUInt32LE(0), 0x50424446);
  const count = index.readUInt32LE(4);
  assert.equal(count, 2);
  assert.equal(index.readUInt32LE(8), 24);
  assert.equal(index.readUInt32LE(12), count * 28);
  const poolStart = index.readUInt32LE(16);
  const poolBytes = index.readUInt32LE(20);
  assert.equal(poolStart, 24 + count * 28);
  assert.equal(index.length, poolStart + poolBytes);
  const names = index.subarray(poolStart, -1).toString('ascii').split('\0');
  assert.deepEqual(names, ['o.alpha.img', 'o.zed.img']);
  let expectedOffset = 4;
  for (let number = 0; number < count; number++) {
    const expected = store.files.get(names[number]);
    const row = 24 + number * 28;
    assert.equal(index.readUInt32LE(row), expected.checksum);
    assert.equal(index.readUInt32LE(row + 4), expected.version);
    assert.equal(index.readUInt32LE(row + 8), expectedOffset);
    assert.equal(index.readUInt32LE(row + 12), 0);
    assert.equal(index.readUInt32LE(row + 16), expected.data.length);
    assert.equal(index.readUInt32LE(row + 20), 2);
    assert.equal(index.readUInt32LE(row + 24), 0);
    assert.deepEqual(data.subarray(expectedOffset, expectedOffset + expected.data.length), expected.data);
    expectedOffset += expected.data.length;
  }
  assert.equal(data.length, expectedOffset, 'no uncommitted tail or spare payload bytes');
});

test('empty filename inventories produce a valid empty cache', () => {
  const files = readZip(buildImageArchive({ listFileNames: () => [], getFileInfo() {} }, 'Empty'));
  assert.equal(files.get('Empty.idx').length, 24);
  assert.equal(files.get('Empty.dat').length, 4);
});

test('archive rejects unsafe names, stale payload checksums and resource limits', () => {
  for (const world of ['../escape', 'C:escape', 'dot.', 'space ', 'bad|name', '', 'a'.repeat(64)]) {
    assert.throws(() => buildImageArchive(fixture(), world), /World name/);
  }
  for (const filename of ['../escape.img', 'C:\\escape.img', 'bad\0.img', 'x'.repeat(64)]) {
    assert.throws(() => buildImageCache({ listFileNames: () => [filename], getFileInfo: () => ({ data: Buffer.from('x'), version: 0 }) }), /filename/);
  }
  const store = fixture();
  store.files.get('o.alpha.img').data = Buffer.from('changed');
  assert.throws(() => buildImageArchive(store, 'Local'), /checksum changed/);
  assert.throws(() => buildImageArchive(fixture(), 'Local', { maxBytes: 50 }), /size limit/);
  assert.throws(() => buildImageCache({ listFileNames: () => ['a.img', 'A.img'], getFileInfo: () => ({ data: Buffer.alloc(0), version: 0 }) }), /Duplicate/);
});
