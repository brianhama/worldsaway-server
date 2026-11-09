import type { ResourceProvider } from './resources.js';

/** Clean WSRES image-cache updates for the original AltAway launcher.
 *
 * ZIP uses its standard CRC-32. WSRES uses the separately recovered native
 * cache checksum; these are deliberately different functions and constants.
 */
const UINT32_MAX = 0xffffffff;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

const ZIP_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

const CACHE_CHECKSUM_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte >>> 2;
  for (const shift of [24, 23, 22, 20, 19, 17, 16, 14, 13, 12, 8, 2, 1]) value ^= byte << shift;
  if (byte & 1) value ^= 0x76dc4190;
  if (byte & 2) value ^= 0xede88320;
  return value >>> 0;
});

/** ZIP CRC-32/ISO-HDLC, including initial and final complements. */
export function crc32(data: Uint8Array): number {
  let value = UINT32_MAX;
  for (const byte of data) value = (value >>> 8) ^ ZIP_CRC_TABLE[(value ^ byte) & 255];
  return (value ^ UINT32_MAX) >>> 0;
}

/** Recovered WSRES recurrence. This is not the ZIP checksum. */
export function nativeCacheChecksum(data: Uint8Array): number {
  let value = 0;
  for (const byte of data) value = (value >>> 8) ^ CACHE_CHECKSUM_TABLE[(value ^ byte) & 255];
  return value >>> 0;
}

function uint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) throw new Error(`${label} must be an unsigned 32-bit integer`);
  return value;
}

function checkedWorldName(worldName: string): string {
  if (typeof worldName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,62}$/.test(worldName) || /[. ]$/.test(worldName)) {
    throw new Error('World name must be a safe ASCII cache basename of 1..63 bytes');
  }
  return worldName;
}

function checkedFileName(name: string): string {
  if (typeof name !== 'string' || !name.length || name.length > 63 || /[^\x20-\x7e]/.test(name) || /[<>:"/\\|?*]/.test(name)
      || name === '.' || name === '..' || /[. ]$/.test(name)) {
    throw new Error('Invalid filename in image cache');
  }
  return name;
}

/** Build header-committed index/data pairs from admitted assets only.
 *
 * The builder intentionally recreates tables and data ranges. It does not copy
 * stale slots, opaque spare allocation bytes, uncommitted rows or missing data.
 */
export function buildImageCache(resources: Pick<ResourceProvider, 'listFileNames' | 'getFileInfo'>, { maxBytes = DEFAULT_MAX_BYTES }: { maxBytes?: number } = {}): { index: Buffer; data: Buffer; count: number } {
  if (!resources || typeof resources.listFileNames !== 'function' || typeof resources.getFileInfo !== 'function') {
    throw new Error('An admitted filename resource store is required');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 28 || maxBytes > UINT32_MAX) throw new Error('Invalid archive size limit');
  const filenames = resources.listFileNames();
  if (!Array.isArray(filenames) || filenames.length > 1_000_000) throw new Error('Invalid image filename inventory');
  const names = filenames.map(checkedFileName).sort();
  const unique = new Set<string>();
  const entries: { name: string; nameBytes: Buffer; version: number; data: Buffer; checksum: number }[] = [];
  let namesBytes = 0;
  let dataBytes = 4;
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (unique.has(normalized)) throw new Error('Duplicate image cache filename');
    unique.add(normalized);
    const info = resources.getFileInfo(name);
    if (!info || !Buffer.isBuffer(info.data)) throw new Error(`Image payload unavailable: ${name}`);
    const version = uint32(info.version ?? 0, 'Image version');
    const data = info.data;
    const checksum = nativeCacheChecksum(data);
    if (info.checksum !== undefined && uint32(info.checksum, 'Image checksum') !== checksum) throw new Error(`Image checksum changed: ${name}`);
    const nameBytes = Buffer.from(name + '\0', 'ascii');
    namesBytes += nameBytes.length;
    dataBytes += data.length;
    const indexBytes = 24 + names.length * 28 + namesBytes;
    if (indexBytes + dataBytes > maxBytes || dataBytes > UINT32_MAX || indexBytes > UINT32_MAX) throw new Error('Image cache exceeds archive size limit');
    entries.push({ name, nameBytes, version, data, checksum });
  }
  const tableBytes = entries.length * 28;
  const index = Buffer.alloc(24 + tableBytes + namesBytes);
  index.writeUInt32LE(0x50424958, 0);
  index.writeUInt32LE(entries.length, 4);
  index.writeUInt32LE(24, 8);
  index.writeUInt32LE(tableBytes, 12);
  index.writeUInt32LE(24 + tableBytes, 16);
  index.writeUInt32LE(namesBytes, 20);
  const dataParts: Buffer[] = [Buffer.from([0x46, 0x44, 0x42, 0x50])];
  let dataOffset = 4;
  let nameOffset = 24 + tableBytes;
  entries.forEach((entry, indexNumber) => {
    const row = 24 + indexNumber * 28;
    index.writeUInt32LE(entry.checksum, row);
    index.writeUInt32LE(entry.version, row + 4);
    index.writeUInt32LE(dataOffset, row + 8);
    // row+12 is an opaque persisted word; fresh records initialize it to zero.
    index.writeUInt32LE(entry.data.length, row + 16);
    index.writeUInt32LE(2, row + 20);
    entry.nameBytes.copy(index, nameOffset);
    nameOffset += entry.nameBytes.length;
    dataParts.push(entry.data);
    dataOffset += entry.data.length;
  });
  return { index, data: Buffer.concat(dataParts, dataBytes), count: entries.length };
}

/** Deterministic ZIP32 archive containing only store-method ASCII entries. */
function storeZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  if (entries.length > 0xffff) throw new Error('ZIP entry limit exceeded');
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  let centralBytes = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'ascii');
    const size = uint32(entry.data.length, 'ZIP entry size');
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    // No encryption, data descriptor or compression; 1980-01-01 DOS date.
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, name, entry.data);
    centralParts.push(central, name);
    localOffset += local.length + name.length + size;
    centralBytes += central.length + name.length;
    if (localOffset + centralBytes + 22 > UINT32_MAX) throw new Error('ZIP32 size limit exceeded');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end], localOffset + centralBytes + end.length);
}

/** Return the archive consumed by AltAwayLogin's Update Images action. */
export function buildImageArchive(resources: Pick<ResourceProvider, 'listFileNames' | 'getFileInfo'>, worldName: string, options?: { maxBytes?: number }): Buffer {
  const name = checkedWorldName(worldName);
  const cache = buildImageCache(resources, options);
  return storeZip([{ name: `${name}.idx`, data: cache.index }, { name: `${name}.dat`, data: cache.data }]);
}
