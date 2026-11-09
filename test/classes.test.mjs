import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ClassRegistry, SchemaError, parseSchema, encodeFields, decodeFields,
  encodeClientString, decodeClientString } from '../dist/src/classes.js';
import { ResourceStore } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let registry;
function originalRegistry(t) {
  registry ??= new ClassRegistry(new ResourceStore({ clientDir: path.join(root, 'wa') }));
  return registry;
}

test('mode-3 wire fields exclude client/server storage and encode signed integers and bools exactly', () => {
  const schema = 'bu2id;cu4pointer;su2serverOnly;bi2position,3;bbflag;bu4number;;';
  const bytes = encodeFields(schema, { id: 15, pointer: 0xffffffff, serverOnly: 42,
    position: [-1, -32768, 32767], flag: true, number: 0x12345678 });
  assert.equal(bytes.toString('hex'), '000fffff80007fff0112345678');
  assert.equal(bytes.length, 13);
  assert.deepEqual(decodeFields(schema, bytes), { id: 15, position: [-1, -32768, 32767], flag: true, number: 0x12345678 });
  assert.equal(encodeFields(schema, {}, { scopes: ['b', 's'] }).length, 15);
  assert.throws(() => encodeFields(schema, { flag: 2 }), /Boolean/);
  assert.throws(() => encodeFields(schema, { position: [0, 0, 32768] }), /range/);
});

test('CUTESI strings use Windows-1252 and reject NUL/unrepresentable characters', () => {
  assert.equal(encodeClientString('Renée € “yes”').toString('hex'), '52656ee9652080209379657394');
  assert.equal(decodeClientString(Buffer.from([0x80, 0xe9, 0x93, 0x94])), '€é“”');
  const bytes = encodeFields('bsname;bsmessage;;', { name: 'Alice', message: 'Hello €' });
  assert.equal(bytes.toString('hex'), '416c6963650048656c6c6f208000');
  assert.deepEqual(decodeFields('bsname;bsmessage;;', bytes), { name: 'Alice', message: 'Hello €' });
  assert.throws(() => encodeClientString('bad\0text'), /NUL/);
  assert.throws(() => encodeClientString('😀'), /Windows-1252/);
  assert.throws(() => decodeFields('bsmessage;;', Buffer.from('missing terminal zero')), /Unterminated/);
});

test('dynamic byte/number arrays infer counts, preserve bytes and reject inconsistent bounds', () => {
  const schema = 'bu4cvsize;bu1contentsVector,cvsize;bu2success;;';
  const bytes = encodeFields(schema, { contentsVector: Buffer.from([0, 255, 1]), success: 1 });
  assert.equal(bytes.toString('hex'), '0000000300ff010001');
  const parsed = decodeFields(schema, bytes);
  assert.equal(parsed.cvsize, 3); assert.deepEqual(parsed.contentsVector, Buffer.from([0, 255, 1]));
  assert.equal(parsed.success, 1);
  assert.throws(() => encodeFields(schema, { cvsize: 2, contentsVector: Buffer.alloc(3) }), /differs/);
  assert.throws(() => decodeFields('bu4size;bu1data,size;;', Buffer.from('ffffffff', 'hex')), /bounds/);
  assert.throws(() => parseSchema('bu1data,size;bu4size;;'), /earlier/);
  assert.throws(() => decodeFields(schema, bytes.subarray(0, -1)), /Truncated/);
  assert.throws(() => decodeFields('bu1x;;', Buffer.from([1, 2])), /trailing/);
  const numbers = encodeFields('bu4count;bu4ids,count;;', { ids: [1, 0x12345678] });
  assert.equal(numbers.toString('hex'), '000000020000000112345678');
});

test('fixed character arrays support packed binary tables and retain raw bytes', () => {
  const table = Buffer.from([65, 0, 66, 0, 255, 0]);
  const bytes = encodeFields('bcnames,6;;', { names: table });
  assert.deepEqual(bytes, table);
  const asText = decodeFields('bcnames,6;;', bytes);
  assert.equal(asText.names, 'A'); assert.deepEqual(asText.rawCharFields.names, table);
  assert.deepEqual(decodeFields('bcnames,6;;', bytes, { charArrays: 'buffer' }).names, table);
  assert.throws(() => encodeFields('bcname,4;;', { name: 'Fives' }), /fit/);
  assert.equal(encodeFields('bcmid,4;;', { mid: 'Four' }).toString('hex'), '466f7572');
  assert.equal(encodeFields('bcname,4;;', { name: 'Bob' }).toString('hex'), '426f6200');
});

test('all 58 original class schemas encode and decode their default wire state', t => {
  const r = originalRegistry(t); if (!r) return;
  assert.equal(r.list().length, 58); assert.equal(r.summary.classes, 58);
  const names = new Set();
  for (const definition of r.list()) {
    names.add(definition.name);
    const fields = r.defaults(definition.classNumber);
    assert.equal(r.validateObject({ classNumber: definition.classNumber, fields }), true);
    const bytes = r.encodeObject({ classNumber: definition.classNumber, fields });
    assert.equal(bytes.readUInt16BE(0), definition.classNumber);
    const decoded = r.decodeInstance(definition.classNumber, bytes);
    assert.equal(decoded.classNumber, definition.classNumber);
    assert.deepEqual(r.encodeObject(decoded), bytes, `class ${definition.classNumber}: ${definition.name}`);
    for (const field of definition.fields.filter(field => field.scope !== 'b')) assert.ok(!(field.name in decoded));
  }
  for (const name of ['Region', 'Avatar', 'Ghost', 'Container', 'Document', 'Door', 'ATM', 'Builder', 'NPC', 'Pet', 'Clothing', 'Portkey', 'slotMachine']) assert.ok(names.has(name));
  assert.equal(r.encodeObject(r.defaults(20)).length, 178);
  assert.equal(r.encodeObject(r.defaults(22)).length, 162);
  const invalid = r.encodeObject(r.defaults(22)); invalid.writeUInt16BE(20);
  assert.throws(() => r.decodeInstance(22, invalid), /class number/);
});

test('all 710 original message schemas are handled, with independent known vectors', t => {
  const r = originalRegistry(t); if (!r) return;
  assert.equal(r.messages.size, 710);
  for (const definition of r.messages.values()) {
    const bytes = r.encodeMessage(definition.messageId);
    const decoded = r.decodeMessage(definition.messageId, bytes, { charArrays: 'buffer' });
    assert.deepEqual(r.encodeMessage(definition.messageId, decoded), bytes, `message ${definition.messageId}`);
  }
  assert.equal(r.encodeMessage(50, { coords: [1, 255, 65535] }).toString('hex'), '000100ffffff');
  assert.equal(r.encodeMessage(26, { newName: 'Alice' }).toString('hex'), '416c69636500');
  const content = Buffer.from('00000000', 'hex');
  const here = r.encodeMessage(101, { actor_noid: 15, contentsVector: content });
  assert.equal(here.length, 116); assert.equal(here.readUInt16BE(96), 15);
  assert.equal(here.readUInt32BE(108), 4); assert.deepEqual(here.subarray(112), content);
  assert.equal(r.getMessage(0x40065).messageId, 101);
  const login = Buffer.concat([r.encodeMessage(11), Buffer.alloc(6)]);
  assert.equal(login.length, 288); assert.equal(r.decodeMessage(11, login).arch, 0);
  login[287] = 1; assert.throws(() => r.decodeMessage(11, login), /trailing/);
});

test('registry retains all original methods and server-only values without executing Tcl', t => {
  const r = originalRegistry(t); if (!r) return;
  assert.equal(r.methods.size, 469);
  const method = r.methods.get(0x50050);
  assert.equal(method.msg_num, 25); assert.match(method.source, /request\s+\$self\s+26/);
  assert.ok(method.requests.some(request => request.id === 26));
  assert.equal(method.requests.find(request => request.id === 26).replyId, 70);
  assert.deepEqual(method.requests.find(request => request.id === 26).fields, ['newName']);
  const portkey = r.defaults(209);
  assert.ok('destination' in portkey); assert.ok('areaCode' in portkey);
  portkey.destination = 'OtherRegion'; portkey.areaCode = 42;
  assert.equal(r.validateObject(portkey), true);
  const wire = r.decodeInstance(209, r.encodeObject(portkey));
  assert.ok(!('destination' in wire)); assert.ok(!('areaCode' in wire));
  assert.throws(() => r.validateObject({ ...portkey, object_info: 42 }, { strictFields: true }), /client-only/);
  assert.ok(r.get(59).methodVariants.get(64).length > 1);
  assert.throws(() => r.encodeObject({ classNumber: 65535 }), SchemaError);
});
