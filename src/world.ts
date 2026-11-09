import type { DynamicFields } from './types.js';
import type { NativeFrame } from './protocol.js';

export type WorldProfile = 'region' | 'empty';
export interface WorldSceneOptions { worldName?: string; avatarName?: string; profile?: WorldProfile; }
export interface RegionHereIsOptions {
  helper?: string; guide?: string; wizard?: string; actorNoid?: number; actorFlags?: number;
  permissionLevel?: number; paletteId?: number; permissionFlags?: number; objects?: readonly Uint8Array[];
}

/**
 * A small authored Region/Ghost scene for the recovered WA client.
 *
 * Class schemas are copied from raw class resources 00010014/00010016. Only
 * `b` fields travel on this server-to-client wire; `c` fields are client-only.
 * No original Tcl is evaluated here and no authoritative gameplay is implied.
 */
export const REGION_SCHEMA = 'bu2classNumber;bu2basesvr_pad1;bcname,32;cu4object_info;cu4callbacks;cu4sync_flags;cu2balloonColor;cu2graphicState;cu2activeChore;cu2choreFlags;bu4common_flags;bu2noid;bu2container_noid;bi2position,3;bu2orientation;bu2mood;bu2charges;bcimageURL,32;bu4imageTextid;bu4imageVersion;bu2imageDefault;bu1colorMap,16;bu2salePrice;bu2choreIndex;bu2choreState;bcURLlabel,32;bu2validExits,4;bu2horizon;bu4region_flags;bu4max_avatars;bu4max_ghosts;bu2areaCode;bu2restrictWithinRegion;cu1colorsUsed,34;;';
export const GHOST_SCHEMA = 'bu2classNumber;bu2basesvr_pad1;bcname,32;cu4object_info;cu4callbacks;cu4sync_flags;cu2balloonColor;cu2graphicState;cu2activeChore;cu2choreFlags;bu4common_flags;bu2noid;bu2container_noid;bi2position,3;bu2orientation;bu2mood;bu2charges;bcimageURL,32;bu4imageTextid;bu4imageVersion;bu2imageDefault;bu1colorMap,16;bu2salePrice;bu2choreIndex;bu2choreState;bcURLlabel,32;bu2entrySound;bu2exitSound;bu2ghostSound;bu2deghostSound;bu2statusSound;;';

export const WORLD_PROFILES = Object.freeze(['region', 'empty']);
const MAX_EXPANDED_CV = 16 * 1024 * 1024;

function integer(value: number, bits: number, signed: boolean, label: string): number {
  const minimum = signed ? -(2 ** (bits - 1)) : 0;
  const maximum = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a ${signed ? 'signed' : 'unsigned'} ${bits}-bit integer`);
  }
  return value;
}

function stringField(value: string, size: number, label: string): Buffer {
  if (typeof value !== 'string' || value.includes('\0') ||
      [...value].some(char => char.codePointAt(0)! > 255) || value.length >= size) {
    throw new RangeError(`${label} must fit ${size - 1} non-NUL single-byte characters`);
  }
  const output = Buffer.alloc(size);
  output.write(value, 0, size, 'latin1');
  return output;
}

/** Encode the fixed-width subset used by the two recovered instance schemas. */
export function encodeInstance(schema: string, fields: DynamicFields = {}): Buffer {
  if (typeof schema !== 'string' || !schema.endsWith(';;')) throw new Error('invalid instance schema');
  const chunks: Buffer[] = [];
  for (const descriptor of schema.split(';')) {
    if (!descriptor) continue;
    const match = /^([bc])([ui])(1|2|4)([A-Za-z_][A-Za-z_0-9]*)(?:,(\d+))?$/.exec(descriptor)
      ?? /^([bc])(c)()([A-Za-z_][A-Za-z_0-9]*)(?:,(\d+))$/.exec(descriptor);
    if (!match) throw new Error(`unsupported fixed instance field: ${descriptor}`);
    const [, filter, type, widthText, name, countText] = match;
    if (filter === 'c') continue;
    const count = countText === undefined ? 1 : Number(countText);
    if (!Number.isInteger(count) || count < 1 || count > 65535) throw new RangeError('invalid instance array size');
    if (type === 'c') {
      chunks.push(stringField(fields[name] ?? '', count, name));
      continue;
    }
    const width = Number(widthText);
    const values = count === 1 ? [fields[name] ?? 0] : fields[name] ?? Array(count).fill(0);
    if ((!Array.isArray(values) && !Buffer.isBuffer(values) && !ArrayBuffer.isView(values)) || (values as ArrayLike<unknown>).length !== count) {
      throw new RangeError(`${name} needs exactly ${count} values`);
    }
    const output = Buffer.alloc(width * count);
    for (let index = 0; index < count; index++) {
      const value = integer((values as ArrayLike<number>)[index], width * 8, type === 'i', `${name}[${index}]`);
      if (type === 'i') output.writeIntBE(value, index * width, width);
      else output.writeUIntBE(value, index * width, width);
    }
    chunks.push(output);
  }
  return Buffer.concat(chunks);
}

export function encodeRegion(fields: DynamicFields = {}): Buffer {
  return encodeInstance(REGION_SCHEMA, {
    classNumber: 20, name: 'WorldsAway.app Lobby', noid: 0, container_noid: 0,
    position: [0, 0, 0], colorMap: [...Array(16).keys()],
    horizon: 70, max_avatars: 32, max_ghosts: 32, ...fields,
  });
}

export function encodeGhost(fields: DynamicFields = {}): Buffer {
  return encodeInstance(GHOST_SCHEMA, {
    classNumber: 22, name: 'Demo', noid: 15, container_noid: 0,
    position: [256, 220, 0], colorMap: [...Array(16).keys()],
    imageURL: 'o.ghost.img', imageVersion: 0, ...fields,
  });
}

/** Four-byte expanded size followed by literals, FF FF, or FF <zero-count>. */
export function encodeZeroRle(input: Uint8Array): Buffer {
  const data = Buffer.from(input);
  if (data.length > MAX_EXPANDED_CV) throw new RangeError('contents vector is too large');
  const encoded: number[] = [];
  for (let offset = 0; offset < data.length;) {
    const value = data[offset];
    if (value === 0) {
      let end = offset + 1;
      while (end < data.length && data[end] === 0 && end - offset < 254) end++;
      const run = end - offset;
      if (run > 2) encoded.push(255, run);
      else for (let index = 0; index < run; index++) encoded.push(0);
      offset = end;
    } else if (value === 255) {
      encoded.push(255, 255);
      offset++;
    } else {
      encoded.push(value);
      offset++;
    }
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  return Buffer.concat([size, Buffer.from(encoded)]);
}

export function decodeZeroRle(input: Uint8Array, maxExpandedSize = MAX_EXPANDED_CV): Buffer {
  const data = Buffer.from(input);
  if (data.length < 4) throw new Error('missing expanded contents-vector size');
  const size = data.readUInt32BE(0);
  if (!Number.isSafeInteger(maxExpandedSize) || maxExpandedSize < 0 || size > maxExpandedSize) {
    throw new RangeError('expanded contents vector is too large');
  }
  const result = Buffer.alloc(size);
  let write = 0;
  for (let offset = 4; offset < data.length; offset++) {
    let value = data[offset];
    let count = 1;
    if (value === 255) {
      if (++offset >= data.length) throw new Error('truncated contents-vector escape');
      count = data[offset];
      if (count === 255) count = 1;
      else value = 0;
    }
    if (write + count > size) throw new Error('contents vector exceeds expanded size');
    result.fill(value, write, write + count);
    write += count;
  }
  if (write !== size) throw new Error('contents vector does not match expanded size');
  return result;
}

export function encodeContentsVector(objects: readonly Uint8Array[] = []): Buffer {
  const records: Buffer[] = [];
  let size = 0;
  for (const value of objects) {
    const object = Buffer.from(value);
    if (object.length < 2 || object.length > 65535) throw new RangeError('invalid contents-vector object length');
    size += 2 + object.length;
    if (size > MAX_EXPANDED_CV) throw new RangeError('contents vector is too large');
    const prefix = Buffer.alloc(2);
    // Each CV length excludes its own two-byte prefix; including it shifts every
    // later object and makes the native client decode arbitrary class numbers.
    prefix.writeUInt16BE(object.length);
    records.push(prefix, object);
  }
  return encodeZeroRle(Buffer.concat(records));
}

export function decodeContentsVector(input: Uint8Array): Buffer[] {
  const data = decodeZeroRle(input);
  const objects: Buffer[] = [];
  for (let offset = 0; offset < data.length;) {
    if (offset + 2 > data.length) throw new Error('truncated contents-vector object size');
    const size = data.readUInt16BE(offset);
    offset += 2;
    if (size < 2 || offset + size > data.length) throw new Error('invalid contents-vector object');
    objects.push(Buffer.from(data.subarray(offset, offset + size)));
    offset += size;
  }
  return objects;
}

export function buildRegionHereIs({
  helper = '', guide = '', wizard = '', actorNoid = 0xffff, actorFlags = 0,
  permissionLevel = 0, paletteId = 0, permissionFlags = 0, objects = [],
}: RegionHereIsOptions = {}): Buffer {
  const cv = encodeContentsVector(objects);
  const prefix = Buffer.alloc(112);
  stringField(helper, 32, 'helper').copy(prefix, 0);
  stringField(guide, 32, 'guide').copy(prefix, 32);
  stringField(wizard, 32, 'wizard').copy(prefix, 64);
  prefix.writeUInt16BE(integer(actorNoid, 16, false, 'actorNoid'), 96);
  prefix.writeUInt16BE(integer(actorFlags, 16, false, 'actorFlags'), 98);
  prefix.writeUInt16BE(integer(permissionLevel, 16, false, 'permissionLevel'), 100);
  prefix.writeUInt16BE(integer(paletteId, 16, false, 'paletteId'), 102);
  prefix.writeUInt32BE(integer(permissionFlags, 32, false, 'permissionFlags'), 104);
  prefix.writeUInt32BE(cv.length, 108);
  return Buffer.concat([prefix, cv]);
}

export function createWorldState({ worldName = 'WorldsAway.app', avatarName = 'Demo', profile = 'region' }: WorldSceneOptions = {}) {
  if (!WORLD_PROFILES.includes(profile)) throw new Error(`unknown world profile: ${profile}`);
  if (typeof worldName !== 'string') throw new TypeError('worldName must be a string');
  stringField(avatarName, 32, 'avatarName');
  const name = `${worldName} Lobby`.slice(0, 31);
  stringField(name, 32, 'region name');
  const objects = profile === 'empty' ? [] : [
    encodeRegion({ name }), encodeGhost({ name: avatarName }),
  ];
  return { profile, worldName, avatarName, regionNoid: 0, actorNoid: profile === 'empty' ? 0xffff : 15, objects };
}

/** Message bodies only: the parent transport supplies the eight-byte header. */
export function buildWorldEntry(options: WorldSceneOptions = {}): NativeFrame[] {
  const state = createWorldState(options);
  const hereIs = { noid: 0, id: 101, payload: buildRegionHereIs({ actorNoid: state.actorNoid, objects: state.objects }) };
  return state.profile === 'empty' ? [hereIs] : [
    { noid: 0, id: 145, payload: Buffer.from([0, 1]) }, hereIs,
  ];
}
