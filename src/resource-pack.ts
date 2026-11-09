/** Portable, data-only resource snapshots. Account files and executable payloads are never imported. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ResourceStore, CacheFormatError, cacheChecksum } from './resources.js';
import type { ResourceRecord, FileInfo, ResourceProvider, ResourceSummary } from './resources.js';
import type { ServerConfig } from './types.js';

interface PackExtent { offset: number; length: number; sha256: string; }
interface PackResource extends PackExtent { id: number; version: number; }
interface PackFile extends PackExtent { name: string; version: number; checksum: number; }
interface ResourcePackManifest {
  format: string; resourceProfile: string; resourceCursor: number; summary: ResourceSummary;
  payload: { filename: string; length: number; sha256: string }; records: PackResource[]; files: PackFile[];
}


const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const MAX_PACK_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const safeName = (name: unknown): name is string => typeof name === 'string' && /^[\x20-\x7e]{1,63}$/.test(name)
  && !/[\\/:]/.test(name) && name !== '.' && name !== '..';

function boundedRead(filename: string, maximum: number): Buffer {
  const info = fs.statSync(filename);
  if (!info.isFile() || info.size > maximum) throw new CacheFormatError('Resource pack file exceeds bounds');
  const bytes = fs.readFileSync(filename);
  if (bytes.length !== info.size) throw new CacheFormatError('Resource pack changed while reading');
  return bytes;
}

export function exportResourcePack(resources: ResourceProvider, directory: string) {
  const destination = path.resolve(directory);
  // Never replace an installed pack; upgrades are staged into a new directory.
  fs.mkdirSync(destination, { recursive: false });
  const chunks: Buffer[] = [], records: PackResource[] = [], files: PackFile[] = [];
  let offset = 0;
  const append = <T extends { version: number }>(data: Buffer, metadata: T, list: (T & PackExtent)[]): void => {
    if (!Buffer.isBuffer(data) || offset + data.length > MAX_PACK_BYTES) throw new CacheFormatError('Resource pack exceeds bounds');
    list.push({ ...metadata, offset, length: data.length, sha256: digest(data) });
    chunks.push(data); offset += data.length;
  };
  try {
    for (const resource of resources.bootstrapResources()) append(resource.data, { id: resource.id, version: resource.version }, records);
    for (const name of resources.listFileNames()) {
      if (!safeName(name)) throw new CacheFormatError('Invalid resource filename');
      const item = resources.getFileInfo(name);
      if (!item) throw new CacheFormatError(`Resource disappeared during export: ${name}`);
      append(item.data, { name, version: item.version, checksum: item.checksum }, files);
    }
    const payload = Buffer.concat(chunks);
    const manifest: ResourcePackManifest = { format: 'worldsaway-resource-pack-1', resourceProfile: resources.resourceProfile,
      resourceCursor: resources.resourceCursor, summary: resources.summary,
      payload: { filename: 'payload.bin', length: payload.length, sha256: digest(payload) }, records, files };
    const json = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(json) > MAX_MANIFEST_BYTES) throw new CacheFormatError('Resource manifest exceeds bounds');
    fs.writeFileSync(path.join(destination, 'payload.bin'), payload, { flag: 'wx' });
    fs.writeFileSync(path.join(destination, 'manifest.json'), json, { flag: 'wx' });
    return { resourceProfile: manifest.resourceProfile, magResources: records.length, fileAssets: files.length, bytes: payload.length };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Verifies the complete contiguous payload before exposing any of its records to the runtime. */
export class PackedResourceStore implements ResourceProvider {
  #resources = new Map<number, ResourceRecord>();
  #files = new Map<string, FileInfo>();
  directory: string;
  resourceProfile: string;
  resourceCursor: number;
  maxResourceVersion: number;
  summary: Readonly<ResourceSummary>;
  constructor(directory: string, { maxFileBytes = 16 * 1024 * 1024 }: { maxFileBytes?: number } = {}) {
    this.directory = path.resolve(directory);
    let manifest: ResourcePackManifest;
    try { manifest = JSON.parse(boundedRead(path.join(this.directory, 'manifest.json'), MAX_MANIFEST_BYTES).toString('utf8')) as ResourcePackManifest; }
    catch (error) { throw new CacheFormatError(`Invalid resource manifest: ${error instanceof Error ? error.message : String(error)}`); }
    if (manifest.format !== 'worldsaway-resource-pack-1' || manifest.payload?.filename !== 'payload.bin'
        || !Array.isArray(manifest.records) || !Array.isArray(manifest.files)
        || manifest.records.length > 65536 || manifest.files.length > 65536) throw new CacheFormatError('Invalid resource pack format');
    const payload = boundedRead(path.join(this.directory, 'payload.bin'), MAX_PACK_BYTES);
    if (payload.length !== manifest.payload.length || digest(payload) !== manifest.payload.sha256) throw new CacheFormatError('Resource pack payload hash mismatch');
    let expectedOffset = 0;
    // Offset equality rejects overlaps, gaps, aliases and trailing data, not just out-of-range reads.
    const bytes = (record: PackExtent & { version: number }, limit: number): Buffer => {
      if (!Number.isSafeInteger(record.offset) || record.offset !== expectedOffset || !Number.isSafeInteger(record.length)
          || record.length < 0 || record.length > limit || record.offset + record.length > payload.length) throw new CacheFormatError('Invalid resource pack record extent');
      expectedOffset += record.length;
      const data = payload.subarray(record.offset, expectedOffset);
      if (digest(data) !== record.sha256 || !Number.isInteger(record.version) || record.version < 0 || record.version > 0xffffffff) throw new CacheFormatError('Resource pack record hash/version mismatch');
      return data;
    };
    for (const record of manifest.records) {
      if (!Number.isInteger(record.id) || record.id < 0 || record.id > 0x7fffffff || this.#resources.has(record.id)) throw new CacheFormatError('Invalid resource pack identity');
      this.#resources.set(record.id, { id: record.id, version: record.version, data: bytes(record, 16 * 1024 * 1024) });
    }
    for (const file of manifest.files) {
      if (!safeName(file.name) || this.#files.has(file.name)) throw new CacheFormatError('Invalid resource pack filename');
      const data = bytes(file, maxFileBytes);
      if (cacheChecksum(data) !== file.checksum) throw new CacheFormatError('Resource pack native checksum mismatch');
      this.#files.set(file.name, { version: file.version, checksum: file.checksum, data });
    }
    if (expectedOffset !== payload.length || !this.#resources.size) throw new CacheFormatError('Resource pack has trailing or missing data');
    const profile = createHash('sha256').update('wa-resource-profile-v1\0');
    for (const entry of [...this.#resources.values()].sort((a, b) => a.id - b.id)) {
      const header = Buffer.alloc(12); header.writeUInt32BE(entry.id); header.writeUInt32BE(entry.version, 4); header.writeUInt32BE(entry.data.length, 8);
      profile.update(header).update(createHash('sha256').update(entry.data).digest());
    }
    this.resourceProfile = profile.digest('hex');
    // Profile identity is recomputed from admitted records rather than trusted
    // from JSON, keeping browser/native bootstrap generations deterministic.
    if (this.resourceProfile !== manifest.resourceProfile) throw new CacheFormatError('Resource profile mismatch');
    if (!Number.isInteger(manifest.resourceCursor) || manifest.resourceCursor < 0 || manifest.resourceCursor > 0xffffffff) throw new CacheFormatError('Invalid resource cursor');
    this.resourceCursor = manifest.resourceCursor;
    this.maxResourceVersion = Math.max(...[...this.#resources.values()].map(item => item.version));
    this.summary = Object.freeze({ ...manifest.summary, magResources: this.#resources.size, fileAssets: this.#files.size,
      magPayloadBytes: [...this.#resources.values()].reduce((n, x) => n + x.data.length, 0),
      filePayloadBytes: [...this.#files.values()].reduce((n, x) => n + x.data.length, 0), resourceProfile: this.resourceProfile });
  }
  getResource(id: number): ResourceRecord | null { const item = this.#resources.get(id); return item ? { ...item, data: Buffer.from(item.data) } : null; }
  bootstrapResources(): ResourceRecord[] {
    return [...this.#resources.keys()].sort((a, b) => ((a >>> 16) === 10) !== ((b >>> 16) === 10)
      ? ((a >>> 16) === 10 ? -1 : 1) : a - b).map(id => this.getResource(id)!);
  }
  getFileInfo(name: string): FileInfo | null { const item = this.#files.get(name); return item ? { ...item, data: Buffer.from(item.data) } : null; }
  getFile(name: string): Buffer | null { return this.getFileInfo(name)?.data ?? null; }
  listFileNames(): string[] { return [...this.#files.keys()].sort(); }
  getClassSchema(number: number): string | null {
    const data = this.getResource(0x10000 + number)?.data;
    if (!data) return null;
    if (data.length < 56 || data.readUInt16BE(0) !== number) throw new CacheFormatError('Invalid packed class');
    const start = 56 + data.readUInt16BE(48) * 4;
    if (start + data.readUInt32BE(52) !== data.length) throw new CacheFormatError('Invalid packed class extent');
    return data.subarray(start).toString('latin1').replace(/\0+$/, '');
  }
}

export function loadServerResources(config: Pick<ServerConfig, 'resourcePackDir' | 'maxFileBytes' | 'clientDir' | 'worldProfile'>): ResourceProvider {
  if (config.resourcePackDir && fs.existsSync(path.join(config.resourcePackDir, 'manifest.json'))) {
    return new PackedResourceStore(config.resourcePackDir, { maxFileBytes: config.maxFileBytes });
  }
  return new ResourceStore({ clientDir: config.clientDir, maxFileBytes: config.maxFileBytes,
    filterClassDependencies: config.worldProfile === 'region' ? 'all' : [] });
}
