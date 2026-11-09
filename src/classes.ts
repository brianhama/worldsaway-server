import type { DynamicFields } from './types.js';
import type { ResourceProvider, ResourceRecord } from './resources.js';

export type FieldScope = 'b' | 'c' | 's';
export type FieldType = 'u' | 'i' | 'c' | 's' | 'b';
export interface CodecField {
  name: string; scope: FieldScope; filter: FieldScope; type: FieldType; width: number;
  count: number | string | null; min: number; max: number; wire: boolean; descriptor: string;
}
export interface CodecLimits { maxPayloadBytes: number; maxStringBytes: number; maxArrayElements: number; maxFields: number; }
export interface CodecOptions extends Partial<CodecLimits> {
  scopes?: FieldScope[]; allowTrailingZeroBytes?: number; charArrays?: 'buffer' | 'string';
}
export interface DecodedFields extends DynamicFields {
  readonly bytesRead: number; readonly rawCharFields: Readonly<Record<string, Buffer>>;
}
export interface LiteralRequest {
  id: number; messageId: number; target: string; replyId: number | null; line: number;
  fields: readonly string[]; argumentText: string; lexical: boolean;
}
export interface MethodDefinition {
  id: number; resourceId: number; version: number; msg_num: number; messageId: number; methodType: number;
  source: string; requests: readonly Readonly<LiteralRequest>[];
}
export interface MessageDefinition { id: number; messageId: number; resourceId: number; version: number; schema: string; fields: readonly CodecField[]; }
export interface ClassDefinition {
  classNumber: number; id: number; resourceId: number; version: number; name: string; capacity: number; reserved: number;
  avatarSlot: number; pickFrom: number; contentVersion: number; instanceSize: number; instanceCount: number;
  memoryFlags: number; methodOffset: number; resourceIds: readonly number[]; missingResourceIds: readonly number[];
  schema: string; fields: readonly CodecField[]; methods: Map<number, Readonly<MethodDefinition>>;
  methodVariants: Map<number, readonly Readonly<MethodDefinition>[]>;
}
export interface ClassSummary { classes: number; messages: number; methods: number; classWireFields: number; limitations: readonly string[]; }
export interface ValidateObjectOptions extends CodecOptions { includeServer?: boolean; strictFields?: boolean; }
type Schema = string | readonly CodecField[];
// Array leaves share the runtime schema boundary with DynamicFields. Their
// actual scalar type, count and numeric range are checked before codec I/O.
type CodecArray = ArrayLike<any> & Iterable<any>;

/** Generic codecs for every class/message descriptor in the admitted WA cache.
 *
 * CUTESI mode 3 (world wire data) selects `b` fields. `c` and `s` fields are
 * client-only and server-only state, respectively; neither is a wire pointer.
 * Recovered Tcl is retained as contract metadata and is never executed here.
 */
export class SchemaError extends Error {
  constructor(message: string) { super(message); this.name = 'SchemaError'; }
}

const LIMITS = Object.freeze({ maxPayloadBytes: 1024 * 1024, maxStringBytes: 262144,
  maxArrayElements: 1048576, maxFields: 2048 });
const cp1252 = ['€', '\u0081', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u008d', 'Ž', '\u008f',
  '\u0090', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u009d', 'ž', 'Ÿ'];
const cp1252Reverse = new Map(cp1252.map((char, index) => [char, 128 + index]));

export function encodeClientString(value: string): Buffer {
  if (typeof value !== 'string') throw new SchemaError('Expected a client text string');
  const bytes = [];
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0) throw new SchemaError('Client text cannot contain NUL');
    const mapped = cp1252Reverse.get(char);
    if (mapped !== undefined) bytes.push(mapped);
    else if (code < 128 || code >= 160 && code <= 255) bytes.push(code);
    else throw new SchemaError('Text contains a character outside Windows-1252');
  }
  return Buffer.from(bytes);
}

export function decodeClientString(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte >= 128 && byte < 160 ? cp1252[byte - 128] : String.fromCharCode(byte);
  return result;
}

function scopes(options: CodecOptions = {}): Set<FieldScope> {
  const selection: FieldScope[] = options.scopes ?? ['b'];
  if (!Array.isArray(selection) || selection.some(value => !['b', 'c', 's'].includes(value))) throw new SchemaError('Invalid CUTESI scope selection');
  return new Set(selection);
}

/** Parse the complete fixed/dynamic subset used by all 58 classes/710 messages. */
export function parseSchema(input: string): readonly CodecField[] {
  if (typeof input !== 'string') throw new SchemaError('Descriptor must be text');
  const schema = input.replace(/\0+$/, '').trim();
  if (!schema.endsWith(';;')) throw new SchemaError('Descriptor needs a terminal double semicolon');
  const entries = schema.slice(0, -2).split(';').filter(Boolean);
  if (entries.length > LIMITS.maxFields) throw new SchemaError('Descriptor has too many fields');
  const fields: CodecField[] = [], names = new Set<string>();
  for (const text of entries) {
    const match = /^\s*([bcs])([uicsb])([124]?)([A-Za-z_][A-Za-z_0-9]*)(?:\s*,\s*([A-Za-z_][A-Za-z_0-9]*|\d+))?\s*$/.exec(text);
    if (!match) throw new SchemaError(`Unsupported CUTESI field: ${text}`);
    const [, scope, type, suffix, name, countText] = match;
    if (names.has(name)) throw new SchemaError(`Duplicate CUTESI field: ${name}`);
    if ((type === 'u' || type === 'i') && !suffix) throw new SchemaError(`Integer width missing: ${name}`);
    if (!['u', 'i'].includes(type) && suffix) throw new SchemaError(`Unexpected width suffix: ${name}`);
    const width = ['u', 'i'].includes(type) ? Number(suffix) : 1;
    const count = countText === undefined ? null : /^\d+$/.test(countText) ? Number(countText) : countText;
    if (typeof count === 'number' && (!Number.isSafeInteger(count) || count < 0 || count > LIMITS.maxArrayElements)) throw new SchemaError(`Invalid field count: ${name}`);
    if (typeof count === 'string') {
      const target = fields.find(field => field.name === count);
      if (!target || !['u', 'i'].includes(target.type) || target.count !== null) throw new SchemaError(`Array count must name an earlier scalar integer: ${name}`);
    }
    const minimum = type === 'i' ? -(2 ** (width * 8 - 1)) : 0;
    const maximum = type === 'i' ? 2 ** (width * 8 - 1) - 1 : type === 'b' ? 1 : 2 ** (width * 8) - 1;
    fields.push(Object.freeze({ name, scope: scope as FieldScope, filter: scope as FieldScope, type: type as FieldType, width, count,
      min: minimum, max: maximum, wire: scope === 'b', descriptor: text }));
    names.add(name);
  }
  return Object.freeze(fields);
}

function countFor(field: CodecField, values: DynamicFields, limits: CodecLimits): number {
  const count = field.count === null ? 1 : typeof field.count === 'number' ? field.count : values[field.count] ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count > limits.maxArrayElements) throw new SchemaError(`Array count out of bounds: ${field.name}`);
  return count;
}

function fieldsFor(schema: Schema): readonly CodecField[] { return Array.isArray(schema) ? schema as readonly CodecField[] : parseSchema(schema as string); }
function arrayValue(value: unknown): value is CodecArray { return Array.isArray(value) || Buffer.isBuffer(value) || ArrayBuffer.isView(value); }

function normalizedValues(fields: readonly CodecField[], input: DynamicFields, selected: ReadonlySet<FieldScope>): DynamicFields {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SchemaError('Field values must be an object');
  const values = { ...input };
  for (const field of fields) {
    if (!selected.has(field.scope) || typeof field.count !== 'string' || values[field.name] === undefined) continue;
    const value = values[field.name];
    const count = field.type === 'c' && typeof value === 'string' ? encodeClientString(value).length : value?.length;
    if (!Number.isSafeInteger(count)) throw new SchemaError(`Array value missing a length: ${field.name}`);
    if (values[field.count] === undefined) values[field.count] = count;
    else if (values[field.count] !== count) throw new SchemaError(`Array length differs from ${field.count}: ${field.name}`);
  }
  return values;
}

/** Encode packed CUTESI fields. The default scope is b-only network data. */
export function encodeFields(schema: Schema, input: DynamicFields = {}, options: CodecOptions = {}): Buffer {
  const fields = fieldsFor(schema), selected = scopes(options), limits = { ...LIMITS, ...options };
  const values = normalizedValues(fields, input, selected), chunks: Buffer[] = [];
  let total = 0;
  const push = (data: Buffer): void => {
    total += data.length;
    if (total > limits.maxPayloadBytes) throw new SchemaError('Encoded payload exceeds its limit');
    chunks.push(data);
  };
  for (const field of fields) {
    if (!selected.has(field.scope)) continue;
    const count = countFor(field, values, limits), value = values[field.name];
    if (field.type === 'c' && field.count !== null) {
      // A native fixed character field can also be a packed binary table. Keep
      // bytes intact; UTF-8 encoding or automatic NUL trimming would corrupt it.
      let bytes;
      if (value === undefined) bytes = Buffer.alloc(count);
      else if (typeof value === 'string') {
        bytes = encodeClientString(value);
        if (bytes.length > count) throw new SchemaError(`Text does not fit its fixed-width field: ${field.name}`);
      } else if (arrayValue(value)) bytes = Buffer.from(value);
      else throw new SchemaError(`Invalid character array: ${field.name}`);
      if (bytes.length > count || typeof field.count === 'string' && bytes.length !== count) throw new SchemaError(`Wrong character-array length: ${field.name}`);
      const padded = Buffer.alloc(count); bytes.copy(padded); push(padded); continue;
    }
    const list = field.count === null ? [value] : value === undefined ? Array(count).fill(undefined) : value;
    if (!arrayValue(list) || list.length !== count) throw new SchemaError(`Wrong array length: ${field.name}`);
    if (field.type === 's') {
      for (const entry of list) {
        const text = entry === undefined || entry === null ? '' : entry;
        const bytes = encodeClientString(text);
        if (bytes.length > limits.maxStringBytes) throw new SchemaError(`String exceeds its limit: ${field.name}`);
        push(Buffer.concat([bytes, Buffer.alloc(1)]));
      }
      continue;
    }
    if (count * field.width > limits.maxPayloadBytes - total) throw new SchemaError(`Array exceeds payload limit: ${field.name}`);
    const data = Buffer.alloc(count * field.width);
    for (let index = 0; index < count; index++) {
      let entry = list[index] ?? 0;
      if (field.type === 'b') {
        if (![true, false, 0, 1].includes(entry)) throw new SchemaError(`Boolean must be true/false or 0/1: ${field.name}`);
        entry = entry ? 1 : 0;
      } else if (field.type === 'c' && typeof entry === 'string') {
        const bytes = encodeClientString(entry);
        if (bytes.length !== 1) throw new SchemaError(`Character must be one byte: ${field.name}`);
        entry = bytes[0];
      }
      if (!Number.isSafeInteger(entry) || entry < field.min || entry > field.max) throw new SchemaError(`Integer out of range: ${field.name}`);
      if (field.type === 'i') data.writeIntBE(entry, index * field.width, field.width);
      else data.writeUIntBE(entry, index * field.width, field.width);
    }
    push(data);
  }
  return Buffer.concat(chunks, total);
}

/** Decode fields without treating cooked client pointers as transmitted data. */
export function decodeFields(schema: Schema, input: Uint8Array, options: CodecOptions = {}): DecodedFields {
  const fields = fieldsFor(schema), selected = scopes(options), limits = { ...LIMITS, ...options };
  const data = Buffer.from(input);
  if (data.length > limits.maxPayloadBytes) throw new SchemaError('Payload exceeds its limit');
  const values: DynamicFields = {}, rawChars: Record<string, Buffer> = {};
  let offset = 0;
  const take = (size: number): Buffer => {
    if (!Number.isSafeInteger(size) || size < 0 || size > data.length - offset) throw new SchemaError('Truncated CUTESI payload');
    const bytes = data.subarray(offset, offset + size); offset += size; return bytes;
  };
  for (const field of fields) {
    if (!selected.has(field.scope)) continue;
    const count = countFor(field, values, limits);
    if (field.type === 'c' && field.count !== null) {
      const bytes = take(count);
      rawChars[field.name] = Buffer.from(bytes);
      if (typeof field.count === 'string' || options.charArrays === 'buffer') values[field.name] = Buffer.from(bytes);
      else {
        const end = bytes.indexOf(0);
        values[field.name] = decodeClientString(bytes.subarray(0, end < 0 ? bytes.length : end));
      }
      continue;
    }
    const entries: (string | number | boolean)[] = [];
    if (field.type === 's') {
      for (let index = 0; index < count; index++) {
        const end = data.indexOf(0, offset);
        if (end < 0 || end - offset > limits.maxStringBytes) throw new SchemaError(`Unterminated or oversized string: ${field.name}`);
        entries.push(decodeClientString(take(end - offset))); take(1);
      }
    } else {
      const bytes = take(count * field.width);
      for (let index = 0; index < count; index++) {
        const value = field.type === 'i' ? bytes.readIntBE(index * field.width, field.width) : bytes.readUIntBE(index * field.width, field.width);
        if (field.type === 'b' && value > 1) throw new SchemaError(`Noncanonical boolean: ${field.name}`);
        entries.push(field.type === 'b' ? Boolean(value) : value);
      }
    }
    values[field.name] = field.count === null ? entries[0] : field.type === 'u' && field.width === 1 && typeof field.count === 'string' ? Buffer.from(entries as number[]) : entries;
  }
  const trailing = data.length - offset;
  const permitted = options.allowTrailingZeroBytes ?? 0;
  // Only known native struct-padding lengths are admitted by the caller. Extra
  // bytes are never silently ignored, even when every extra byte happens to be zero.
  if (trailing && (trailing !== permitted || data.subarray(offset).some(byte => byte !== 0))) throw new SchemaError('Unexpected trailing CUTESI bytes');
  Object.defineProperty(values, 'bytesRead', { value: offset, enumerable: false });
  Object.defineProperty(values, 'rawCharFields', { value: Object.freeze(rawChars), enumerable: false });
  return values as DecodedFields;
}

function readString(data: Buffer): string { const end = data.indexOf(0); return decodeClientString(data.subarray(0, end < 0 ? data.length : end)); }
function idNumber(id: number | string, type: number): number {
  if (typeof id === 'string' && /^0x[0-9a-f]+$/i.test(id)) id = Number.parseInt(id, 16);
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new SchemaError('Invalid resource/message number');
  if (id > 65535) { if (id >>> 16 !== type) throw new SchemaError('Wrong resource type'); return id & 65535; }
  return id;
}

function literalRequests(source: string): readonly Readonly<LiteralRequest>[] {
  const requests: Readonly<LiteralRequest>[] = [];
  const pattern = /\brequest\s+(\[[^\]]*\]|[^\s{}]+)\s+(\d+)\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let cursor = start, depth = 1;
    for (; cursor < source.length && depth; cursor++) {
      if (source[cursor] === '\\') { cursor++; continue; }
      if (source[cursor] === '{') depth++;
      else if (source[cursor] === '}') depth--;
    }
    if (depth) continue;
    const body = source.slice(start, cursor - 1), tail = source.slice(cursor);
    const reply = /^\s+(\d+)\b/.exec(tail);
    requests.push(Object.freeze({ id: Number(match[2]), messageId: Number(match[2]), target: match[1],
      replyId: reply ? Number(reply[1]) : null, line: source.slice(0, match.index).split('\n').length,
      fields: Object.freeze([...body.matchAll(/^\s*([A-Za-z_][A-Za-z_0-9]*)\s+[^\n]+/gm)].map(field => field[1])),
      argumentText: body.trim(), lexical: true }));
  }
  return requests;
}

function methodMetadata(resource: ResourceRecord): Readonly<MethodDefinition> {
  const data = resource.data;
  if (data.length < 8 || data.readUInt16BE(6) !== data.length - 8) throw new SchemaError(`Invalid method resource ${resource.id}`);
  const source = readString(data.subarray(8));
  const requests = literalRequests(source);
  return Object.freeze({ id: resource.id, resourceId: resource.id, version: resource.version,
    msg_num: data.readUInt32BE(0), messageId: data.readUInt32BE(0), methodType: data.readUInt16BE(4),
    source, requests: Object.freeze(requests) });
}

/** Typed catalog over runtime descriptors; native field contents remain dynamically validated by encode/decode. */
export class ClassRegistry {
  classes: Map<number, Readonly<ClassDefinition>>;
  messages: Map<number, Readonly<MessageDefinition>>;
  methods: Map<number, Readonly<MethodDefinition>>;
  summary: Readonly<ClassSummary>;
  constructor(resources: Pick<ResourceProvider, 'bootstrapResources'>) {
    if (!resources || typeof resources.bootstrapResources !== 'function') throw new SchemaError('An admitted resource store is required');
    this.classes = new Map(); this.messages = new Map(); this.methods = new Map();
    const entries = resources.bootstrapResources();
    const byId = new Map(entries.map(resource => [resource.id, resource]));
    for (const resource of entries) {
      if (resource.id >>> 16 === 5) this.methods.set(resource.id, methodMetadata(resource));
      if (resource.id >>> 16 !== 4) continue;
      const schema = readString(resource.data).trim();
      const messageId = resource.id & 65535;
      this.messages.set(messageId, Object.freeze({ id: messageId, messageId, resourceId: resource.id,
        version: resource.version, schema, fields: parseSchema(schema) }));
    }
    for (const resource of entries) {
      if (resource.id >>> 16 !== 1) continue;
      const data = resource.data;
      if (data.length < 56) throw new SchemaError('Truncated class header');
      const classNumber = data.readUInt16BE(0), count = data.readUInt16BE(48), schemaSize = data.readUInt32BE(52);
      if (resource.id !== 0x10000 + classNumber || 56 + count * 4 + schemaSize !== data.length) throw new SchemaError(`Invalid class layout: ${classNumber}`);
      const resourceIds = Array.from({ length: count }, (_, index) => data.readUInt32BE(56 + index * 4));
      const schema = readString(data.subarray(56 + count * 4));
      const methods = new Map<number, Readonly<MethodDefinition>>(), methodVariants = new Map<number, readonly Readonly<MethodDefinition>[]>();
      for (const id of resourceIds) {
        const method = this.methods.get(id); if (!method) continue;
        methods.set(method.messageId, method);
        methodVariants.set(method.messageId, Object.freeze([...(methodVariants.get(method.messageId) ?? []), method]));
      }
      this.classes.set(classNumber, Object.freeze({ classNumber, id: classNumber, resourceId: resource.id,
        version: resource.version, name: readString(data.subarray(8, 40)), capacity: data[2], reserved: data[3],
        avatarSlot: data[40], pickFrom: data[41], contentVersion: data.readUInt32BE(4),
        instanceSize: data.readUInt16BE(42), instanceCount: data.readUInt16BE(44),
        memoryFlags: data.readUInt16BE(46), methodOffset: data.readUInt16BE(50),
        resourceIds: Object.freeze(resourceIds), missingResourceIds: Object.freeze(resourceIds.filter(id => !byId.has(id))),
        schema, fields: parseSchema(schema), methods, methodVariants }));
    }
    this.summary = Object.freeze({ classes: this.classes.size, messages: this.messages.size, methods: this.methods.size,
      classWireFields: [...this.classes.values()].reduce((n, item) => n + item.fields.filter(field => field.wire).length, 0),
      limitations: Object.freeze(['Structural schema coverage does not establish complete authoritative gameplay behavior',
        'Lexical Tcl request candidates are metadata, not evaluated control flow',
        'Duplicate method-number variants are retained; methods Map exposes the last declared candidate']) });
  }
  get(number: number | string): Readonly<ClassDefinition> | null { return this.classes.get(idNumber(number, 1)) ?? null; }
  getMessage(number: number | string): Readonly<MessageDefinition> | null { return this.messages.get(idNumber(number, 4)) ?? null; }
  list() { return [...this.classes.values()].sort((left, right) => left.classNumber - right.classNumber); }
  defaults(number: number | string, { scope = 'server' }: { scope?: 'server' | 'wire' } = {}): DynamicFields {
    const definition = this.get(number); if (!definition) throw new SchemaError(`Unknown class ${number}`);
    const result: DynamicFields = {};
    for (const field of definition.fields) {
      if (field.scope === 'c' || scope === 'wire' && field.scope !== 'b') continue;
      const count = typeof field.count === 'number' ? field.count : field.count === null ? null : 0;
      result[field.name] = field.type === 's' ? count === null ? '' : Array(count).fill('')
        : field.type === 'c' && count !== null ? '' : count === null ? field.type === 'b' ? false : 0 : Array(count).fill(0);
    }
    result.classNumber = definition.classNumber;
    return result;
  }
  encodeObject(object: DynamicFields, options: CodecOptions = {}): Buffer {
    const fields = { ...(object?.fields ?? object) };
    const number = object?.classNumber ?? fields.classNumber;
    const definition = this.get(number); if (!definition) throw new SchemaError(`Unknown class ${number}`);
    fields.classNumber = definition.classNumber;
    return encodeFields(definition.fields, fields, options);
  }
  decodeInstance(number: number | string, data: Uint8Array, options: CodecOptions = {}): DecodedFields {
    const definition = this.get(number); if (!definition) throw new SchemaError(`Unknown class ${number}`);
    const values = decodeFields(definition.fields, data, options);
    if (values.classNumber !== definition.classNumber) throw new SchemaError('Encoded class number does not match selected schema');
    return values;
  }
  validateObject(object: DynamicFields, { includeServer = true, strictFields = false, ...options }: ValidateObjectOptions = {}): true {
    const fields = { ...(object?.fields ?? object) };
    const definition = this.get(object?.classNumber ?? fields.classNumber);
    if (!definition) throw new SchemaError('Unknown class');
    fields.classNumber = definition.classNumber;
    if (strictFields) {
      const allowed = new Set(definition.fields.filter(field => field.scope === 'b' || includeServer && field.scope === 's').map(field => field.name));
      for (const name of Object.keys(fields)) if (!allowed.has(name)) throw new SchemaError(`Unknown or client-only object field: ${name}`);
    }
    encodeFields(definition.fields, fields, { ...options, scopes: includeServer ? ['b', 's'] : ['b'] });
    return true;
  }
  encodeMessage(number: number | string, fields: DynamicFields = {}, options: CodecOptions = {}): Buffer {
    const definition = this.getMessage(number); if (!definition) throw new SchemaError(`No message schema for ${number}`);
    return encodeFields(definition.fields, fields, options);
  }
  decodeMessage(number: number | string, data: Uint8Array, options: CodecOptions = {}): DecodedFields {
    const definition = this.getMessage(number); if (!definition) throw new SchemaError(`No message schema for ${number}`);
    const allowTrailingZeroBytes = options.allowTrailingZeroBytes ?? (definition.messageId === 11 ? 6 : definition.messageId === 13 ? 2 : 0);
    return decodeFields(definition.fields, data, { ...options, allowTrailingZeroBytes });
  }
  methodContract(classNumber: number | string, messageId: number): Readonly<MethodDefinition> | null { return this.get(classNumber)?.methods.get(messageId) ?? null; }
  requestContracts(classNumber: number | string): (Readonly<LiteralRequest> & { classNumber: number; methodMessageId: number; methodResourceId: number })[] {
    // These are observations for menus and coverage, not authority grants. The
    // gameplay handlers still validate receiver identity, ownership and role.
    const definition = this.get(classNumber); if (!definition) return [];
    return definition.resourceIds.flatMap(id => {
      const method = this.methods.get(id); if (!method) return [];
      return method.requests.map(request => ({ ...request, classNumber: definition.classNumber,
        methodMessageId: method.messageId, methodResourceId: method.resourceId }));
    });
  }
}
