import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ResourceStore, originalClientDir } from './helpers/fixtures.mjs';
import {
  REGION_SCHEMA, GHOST_SCHEMA, encodeInstance, encodeRegion, encodeGhost,
  encodeZeroRle, decodeZeroRle, encodeContentsVector, decodeContentsVector,
  buildRegionHereIs, buildWorldEntry, createWorldState,
} from '../dist/src/world.js';

test('instance descriptors match the recovered native class schemas from raw cache or bundled pack', async t => {
  let classes;
  try { classes = JSON.parse(await readFile(new URL('../../wa-analysis/resources/extracted/classes.json', import.meta.url))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const resources = new ResourceStore({ clientDir: originalClientDir });
    classes = [20, 22].map(class_number => ({ class_number, instance_schema: resources.getClassSchema(class_number) }));
  }
  assert.equal(REGION_SCHEMA, classes.find(item => item.class_number === 20).instance_schema);
  assert.equal(GHOST_SCHEMA, classes.find(item => item.class_number === 22).instance_schema);
});

test('Region instance has the independently calculated packed wire offsets', () => {
  const object = encodeRegion({ name: 'Lobby', horizon: 75, region_flags: 0x12345678,
    max_avatars: 9, max_ghosts: 12, areaCode: 7, validExits: [11, 12, 13, 14], position: [-500, 123, 4] });
  assert.equal(object.length, 178);
  assert.equal(object.readUInt16BE(0), 20);
  assert.equal(object.subarray(4, 36).toString('latin1').split('\0')[0], 'Lobby');
  assert.equal(object.readUInt16BE(40), 0);
  assert.equal(object.readInt16BE(44), -500);
  assert.equal(object.readInt16BE(46), 123);
  assert.equal(object.readInt16BE(48), 4);
  assert.deepEqual([...object.subarray(98, 114)], [...Array(16).keys()]);
  assert.equal(object.readUInt16BE(152), 11);
  assert.equal(object.readUInt16BE(158), 14);
  assert.equal(object.readUInt16BE(160), 75);
  assert.equal(object.readUInt32BE(162), 0x12345678);
  assert.equal(object.readUInt32BE(166), 9);
  assert.equal(object.readUInt32BE(170), 12);
  assert.equal(object.readUInt16BE(174), 7);
  assert.equal(object.readUInt16BE(176), 0);
});

test('client-only fields do not consume wire bytes and numeric ranges are checked', () => {
  assert.deepEqual(encodeInstance('bu2a;cu4local;bu1b;;', { a: 0x1234, local: 123, b: 0x56 }), Buffer.from('123456', 'hex'));
  for (const fields of [{ noid: -1 }, { horizon: 65536 }, { position: [0, 0, 32768] }, { colorMap: [1] }, { name: 'a'.repeat(32) }]) {
    assert.throws(() => encodeRegion(fields));
  }
  assert.throws(() => encodeInstance('bu2field', {}));
  assert.throws(() => encodeInstance('bsfield;;', {}));
});

test('Ghost actor wire layout uses an available cached ghost filename', () => {
  const object = encodeGhost({ name: 'Guest' });
  assert.equal(object.length, 162);
  assert.equal(object.readUInt16BE(0), 22);
  assert.equal(object.readUInt16BE(40), 15);
  assert.equal(object.readUInt16BE(42), 0);
  assert.equal(object.subarray(56, 88).toString('ascii').split('\0')[0], 'o.ghost.img');
  assert.equal(object.readUInt32BE(92), 0);
  assert.deepEqual(object.subarray(152), Buffer.alloc(10));
});

test('zero-RLE agrees with native literal/escape/run vectors and validates bounds', () => {
  assert.deepEqual(decodeZeroRle(Buffer.from('0000000601ff0302ffff', 'hex')), Buffer.from([1, 0, 0, 0, 2, 255]));
  assert.deepEqual(encodeZeroRle(Buffer.from([1, 0, 0, 0, 2, 255])), Buffer.from('0000000601ff0302ffff', 'hex'));
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(2), Buffer.alloc(254), Buffer.alloc(255), Buffer.from([255,255,0,0,0,255])]) {
    assert.deepEqual(decodeZeroRle(encodeZeroRle(bytes)), bytes);
  }
  for (const hex of ['00', '00000001ff', '00000001ff02', '0000000201']) {
    assert.throws(() => decodeZeroRle(Buffer.from(hex, 'hex')));
  }
  assert.throws(() => decodeZeroRle(Buffer.from('00000010', 'hex'), 4));
});

test('CV lengths exclude the two-byte length prefix and preserve complete class bodies', () => {
  const object = Buffer.from([0, 20, 1, 2, 3]);
  const expanded = decodeZeroRle(encodeContentsVector([object]));
  assert.equal(expanded.readUInt16BE(0), 5);
  assert.deepEqual(expanded.subarray(2), object);
  assert.deepEqual(decodeContentsVector(encodeContentsVector([object])), [object]);
  assert.throws(() => decodeContentsVector(encodeZeroRle(Buffer.from([0, 5, 0, 20]))));
});

test('default world transition provides a valid actor object and original Region class', () => {
  const frames = buildWorldEntry({ worldName: 'Test', avatarName: 'Alice' });
  assert.deepEqual(frames.map(frame => [frame.noid, frame.id]), [[0,145],[0,101]]);
  assert.deepEqual(frames[0].payload, Buffer.from([0,1]));
  const body = frames[1].payload;
  assert.equal(body.readUInt16BE(96), 15);
  assert.equal(body.readUInt32BE(108), body.length - 112);
  const cv = decodeZeroRle(body.subarray(112));
  assert.equal(cv.length, 2 + 178 + 2 + 162);
  assert.equal(cv.readUInt16BE(0), 178);
  assert.equal(cv.readUInt16BE(2), 20);
  assert.equal(cv.readUInt16BE(180), 162);
  assert.equal(cv.readUInt16BE(182), 22);
  assert.equal(cv.readUInt16BE(222), 15);
  assert.equal(cv.subarray(186, 218).toString('ascii').split('\0')[0], 'Alice');
});

test('empty profile is explicit and retains the previous diagnostic body', () => {
  const frames = buildWorldEntry({ profile: 'empty' });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 101);
  assert.equal(frames[0].payload.length, 116);
  assert.equal(frames[0].payload.readUInt16BE(96), 0xffff);
  assert.deepEqual(decodeContentsVector(frames[0].payload.subarray(112)), []);
  assert.throws(() => createWorldState({ profile: 'unknown' }));
  assert.throws(() => buildRegionHereIs({ helper: 'bad\0name' }));
});
