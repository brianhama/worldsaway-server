/** The same gameplay suite runs against the emitted JavaScript with either a
 * raw local cache or the bundled data-only pack. Tests do not load TypeScript
 * sources or a development transpiler. Synthetic parser fixtures remain raw. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResourceStore as RawResourceStore } from '../../dist/src/resources.js';
import { PackedResourceStore } from '../../dist/src/resource-pack.js';
import { createCompatibilityServer as createServer } from '../../dist/src/server.js';
export { sendToSocket } from '../../dist/src/server.js';

export const originalClientDir = fileURLToPath(new URL('../../../wa/', import.meta.url));
export const resourcePackDir = fileURLToPath(new URL('../../resources/', import.meta.url));
export const rawCachePresent = fs.existsSync(path.join(originalClientDir, 'mag'));
const packAvailable = fs.existsSync(path.join(resourcePackDir, 'manifest.json'));
const pinnedManifest = packAvailable ? JSON.parse(fs.readFileSync(path.join(resourcePackDir, 'manifest.json'), 'utf8')) : null;

/** A desktop client can update its caches while this suite is running. Only
 * use the optional raw corpus when it is still the generation these recovered
 * inventory assertions describe; gameplay always has the immutable pack. */
function rawGeneration() {
  if (!rawCachePresent) return { matches: false, reason: 'Original WA cache is not bundled with the server source' };
  if (!pinnedManifest) return { matches: true, reason: false };
  try {
    const current = new RawResourceStore({ clientDir: originalClientDir, filterClassDependencies: 'all' });
    const expected = pinnedManifest.summary;
    const inventoryKeys = ['magResources', 'fileAssets', 'filePayloadBytes', 'fileCommittedEntries', 'fileRejected', 'fileUncommittedNameBytes'];
    if (current.resourceProfile !== pinnedManifest.resourceProfile || inventoryKeys.some(key => current.summary[key] !== expected[key])) {
      return { matches: false, reason: 'Original WA cache generation changed; optional historical corpus assertions are skipped and gameplay uses the pinned resource pack' };
    }
    // MAG has its own aggregate profile. Filename assets use native versions and
    // checksums, so compare those identities separately from the MAG digest.
    for (const file of pinnedManifest.files) {
      const actual = current.getFileInfo(file.name);
      if (!actual || actual.version !== file.version || actual.checksum !== file.checksum || actual.data.length !== file.length) {
        return { matches: false, reason: 'Original WA filename asset generation changed; gameplay uses the pinned resource pack' };
      }
    }
    return { matches: true, reason: false };
  } catch (error) {
    return { matches: false, reason: `Original WA cache is unavailable or being updated: ${error.message}; gameplay uses the pinned resource pack` };
  }
}
const generation = rawGeneration();
export const rawCacheAvailable = generation.matches;
export const rawCacheSkipReason = generation.reason;
export const resourceFixtureAvailable = rawCacheAvailable || packAvailable;

function usePack(clientDir) {
  return clientDir !== undefined && path.resolve(clientDir) === path.resolve(originalClientDir)
    && packAvailable && !rawCacheAvailable;
}
export class ResourceStore extends RawResourceStore {
  constructor(options = {}) {
    if (usePack(options.clientDir)) return new PackedResourceStore(resourcePackDir, options);
    super(options);
  }
}
export function createCompatibilityServer(options = {}) {
  return createServer(usePack(options.clientDir) ? { ...options, resourcePackDir: options.resourcePackDir ?? resourcePackDir } : options);
}
