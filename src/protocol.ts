import type { ResourceRecord } from './resources.js';

/** A complete native packet after its big-endian eight-byte envelope is removed. */
export interface NativeFrame { noid: number; id: number; payload: Buffer; }
/** Runtime-facing name for the same native world envelope. */
export type WorldFrame = NativeFrame;
export interface NativeLogin { account: string; token: string; resourceCursor: number; locale: number; architecture: number; version: number; }
export interface AvatarSelection { name: string; region: number; }
interface ListedAvatar { id: number; name: string; }

export class ProtocolError extends Error {}

export function asciiField(value: string, width: number): Buffer {
  if (typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value) || value.length >= width) {
    throw new ProtocolError(`String must fit ${width - 1} printable ASCII bytes`);
  }
  const result = Buffer.alloc(width);
  result.write(value, 'ascii');
  return result;
}

export function readCString(bytes: Buffer, { requireNul = true }: { requireNul?: boolean } = {}): string {
  const end = bytes.indexOf(0);
  if (requireNul && end < 0) throw new ProtocolError('Unterminated native string');
  const value = bytes.subarray(0, end < 0 ? bytes.length : end);
  if ([...value].some(byte => byte < 32 || byte > 126)) throw new ProtocolError('Native identifier must be printable ASCII');
  return value.toString('ascii');
}

export function frame(noid: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  // The envelope is always big-endian, including its byte count. Do not let the
  // host architecture or the little-endian on-disk cache formats leak onto TCP.
  const header = Buffer.alloc(8);
  header.writeUInt16BE(noid, 0); header.writeUInt16BE(id, 2); header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** Retains fragmented tails and emits only complete frames; socket chunks are not packet boundaries. */
export class FrameDecoder {
  maxFrameBytes: number;
  maxBufferedBytes: number;
  buffer: Buffer;
  constructor(maxFrameBytes = 1024 * 1024, maxBufferedBytes = 2 * 1024 * 1024) {
    this.maxFrameBytes = maxFrameBytes; this.maxBufferedBytes = maxBufferedBytes;
    this.buffer = Buffer.alloc(0);
  }
  feed(chunk: Buffer | Uint8Array): NativeFrame[] {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (this.buffer.length + chunk.length > this.maxBufferedBytes) throw new ProtocolError('World input buffer limit exceeded');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const result: NativeFrame[] = [];
    while (this.buffer.length >= 8) {
      const size = this.buffer.readUInt32BE(4);
      if (size > this.maxFrameBytes) throw new ProtocolError('World frame limit exceeded');
      if (this.buffer.length < 8 + size) break;
      result.push({ noid: this.buffer.readUInt16BE(0), id: this.buffer.readUInt16BE(2), payload: this.buffer.subarray(8, 8 + size) });
      this.buffer = this.buffer.subarray(8 + size);
    }
    return result;
  }
}

export function parseLogin(body: Buffer): NativeLogin {
  // The message-11 schema contains 282 bytes. The native wa32 builder
  // appends its 288-byte C buffer, including six bytes of trailing padding.
  if (body.length !== 282 && body.length !== 288) {
    throw new ProtocolError(`Expected a 282- or 288-byte login; received ${body.length} bytes`);
  }
  return { account: readCString(body.subarray(0, 256)), token: readCString(body.subarray(256, 272)),
    resourceCursor: body.readUInt32BE(272), locale: body.readUInt16BE(276),
    architecture: body.readUInt16BE(278), version: body.readUInt16BE(280) };
}

export function parseAvatarEntry(body: Buffer): AvatarSelection {
  // The descriptor has 70 bytes; the native builder appends 72 bytes.
  if (body.length !== 70 && body.length !== 72) {
    throw new ProtocolError(`Expected a 70- or 72-byte avatar selection; received ${body.length} bytes`);
  }
  return { name: readCString(body.subarray(0, 32)), region: body.readUInt32BE(32) };
}

export function configuration(seconds: number): Buffer {
  const data = Buffer.alloc(16); data.writeUInt32BE(seconds, 0);
  // Remaining words are inactivityDefault/Min/Max. Zero leaves client policy alone.
  return frame(10, 10, data);
}

export function avatarList(avatars: readonly ListedAvatar[], capacity: number, busy: ReadonlySet<number> = new Set()): Buffer {
  if (avatars.length > capacity || capacity > 8 || capacity < 1) throw new ProtocolError('Native avatar capacity is 1..8');
  const data = Buffer.alloc(276);
  data.writeUInt16BE(avatars.length < capacity ? 1 : 0, 2);
  data.writeUInt32BE(avatars.length, 4);
  data.writeUInt32BE(capacity, 8);
  let busyMask = 0;
  for (const [index, avatar] of avatars.entries()) {
    asciiField(avatar.name, 32).copy(data, 18 + index * 32);
    if (busy.has(avatar.id)) busyMask |= 1 << index;
  }
  data.writeUInt32BE(busyMask, 12);
  return frame(10, 12, data);
}

export function loginError(message: unknown): Buffer {
  return frame(10, 15, Buffer.from(String(message).replace(/[^\x20-\x7e]/g, '?').slice(0, 255) + '\0', 'ascii'));
}

export function* resourcePackets(resources: readonly ResourceRecord[], chunkSize = 8192): Generator<Buffer> {
  const start = Buffer.alloc(8);
  start.writeUInt32BE(resources.length, 0);
  start.writeUInt32BE(resources.reduce((n, resource) => n + resource.data.length, 0), 4);
  yield frame(10, 16, start);
  for (const resource of resources) {
    if (!resource.data.length) throw new ProtocolError('Empty resource payload is unsupported');
    for (let position = 0; position < resource.data.length; position += chunkSize) {
      const chunk = resource.data.subarray(position, position + chunkSize);
      // The first chunk declares total size; middle chunks use the continuation
      // sentinel and the last continuation uses zero. This is not a stream offset.
      const fullSize = position === 0 ? resource.data.length : position + chunk.length === resource.data.length ? 0 : 0xffffffff;
      const prefix = Buffer.alloc(16);
      prefix.writeUInt32BE(resource.id >>> 0, 0); prefix.writeUInt32BE(resource.version >>> 0, 4);
      prefix.writeUInt32BE(fullSize, 8); prefix.writeUInt32BE(chunk.length, 12);
      yield frame(10, 17, Buffer.concat([prefix, chunk]));
    }
  }
  // The original descriptor declares one unused byte; match it even though the
  // current native completion handler does not inspect that field.
  yield frame(10, 18, Buffer.alloc(1));
}

export function fileReply(name: string, data: Buffer | null = null, version = 0): Buffer {
  const prefix = Buffer.alloc(76);
  prefix.writeUInt32BE(data === null ? 1 : 0, 0);
  asciiField(name, 64).copy(prefix, 4);
  prefix.writeUInt32BE(data?.length ?? 0, 68);
  prefix.writeUInt32BE(version >>> 0, 72);
  return data === null ? prefix : Buffer.concat([prefix, data]);
}
