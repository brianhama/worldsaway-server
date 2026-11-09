import type { AvatarIdentity, AvatarProfile, Clock, DynamicFields, EntityMap, GameObject, OwnershipOptions, Position, RegionRecord, Role, TransactionOptions, WorldState } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_AVATAR_COLORS, isLegacyAvatarColorMap } from './avatar-defaults.js';

export class WorldStoreError extends Error {}
export const WORLD_FORMAT = 1;
export const MAX_BALANCE = Number.MAX_SAFE_INTEGER;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const DIRECTIONS = ['north', 'east', 'south', 'west'];
const ROLES = ['player', 'builder', 'admin'];
const OUTSIDE_THE_ROSE_SOURCE_SCENE = 'scene-45e1e82adac0f4bb54e3ebe2';
const clone = <T>(value: T): T => structuredClone(value);
const own = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);

function id(value: number | null | undefined, label = 'ID'): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) throw new WorldStoreError(`${label} must be a positive safe integer`);
  return value as number;
}
function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new WorldStoreError(`Invalid ${label}`);
  return value;
}
function text(value: string, limit: number, label: string, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value.length) || /\0/.test(value)) throw new WorldStoreError(`Invalid ${label}`);
  return value;
}
function jsonValue(value: unknown, depth = 0): void {
  if (depth > 40) throw new WorldStoreError('World data is nested too deeply');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new WorldStoreError('World numbers must be finite'); return; }
  if (typeof value === 'string') { if (value.length > 1024 * 1024) throw new WorldStoreError('World string exceeds size limit'); return; }
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new WorldStoreError('World fields must contain plain JSON data');
  if (Array.isArray(value)) { if (value.length > 100_000) throw new WorldStoreError('World array exceeds size limit'); for (const item of value) jsonValue(item, depth + 1); return; }
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new WorldStoreError('Reserved world property');
    jsonValue(item, depth + 1);
  }
}
function required<T>(map: EntityMap<T>, key: number | null | undefined, label: string): T {
  const result = map[id(key, label)];
  if (!result) throw new WorldStoreError(`${label} does not exist`);
  return result;
}
function canonicalJSON<T>(value: T, depth = 0): T {
  if (depth > 40) throw new WorldStoreError('World data is nested too deeply');
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] as T;
    return Array.from(value as unknown as Uint8Array) as T;
  }
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)] as T;
  if (Array.isArray(value)) return value.map(item => canonicalJSON(item, depth + 1)) as T;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new WorldStoreError('Reserved world property');
      result[key] = canonicalJSON(item, depth + 1);
    }
    return result as T;
  }
  return value;
}
function profileId(value: number | AvatarIdentity): number { return typeof value === 'object' && value !== null ? value.id : value; }
function audit(draft: WorldState, time: number, action: string, actorId: number | null | undefined, details: DynamicFields = {}) {
  draft.audit.push({ revision: draft.revision + 1, at: time, action, actorId: actorId ?? null, details });
  if (draft.audit.length > 5000) draft.audit.splice(0, draft.audit.length - 5000);
}
function checkOwner(draft: WorldState, object: GameObject, { actorId = null, admin = false, allowUnowned = false }: OwnershipOptions = {}) {
  if (admin) return;
  required(draft.avatars, actorId, 'Acting avatar');
  if (object.ownerId !== actorId && !(object.ownerId === null && allowUnowned)) throw new WorldStoreError('Avatar does not own this object');
}

/**
 * World state is separate from accounts.json. The server's AccountStore lock
 * owns the containing directory; this store deliberately takes no second lock.
 */
export class WorldStore {
  readonly dataDir: string;
  readonly clock: Clock;
  readonly filename: string;
  readonly backupFilename: string;
  closed: boolean;
  // Loading assigns directly; first-time initialization assigns through #persist.
  #state!: WorldState;
  #transaction = false;

  constructor(dataDir: string, { clock = () => Date.now(), seed = true, startRegionName = 'WorldsAway.app Lobby' }: { clock?: Clock; seed?: boolean; startRegionName?: string } = {}) {
    this.dataDir = path.resolve(dataDir); this.clock = clock; this.closed = false;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.filename = path.join(this.dataDir, 'world.json');
    this.backupFilename = this.filename + '.bak';
    if (fs.existsSync(this.filename)) {
      if (fs.statSync(this.filename).size > MAX_FILE_BYTES) throw new WorldStoreError('World file exceeds size limit');
      try { this.#state = JSON.parse(fs.readFileSync(this.filename, 'utf8')); }
      catch (error: unknown) { throw new WorldStoreError(`World file is unreadable; preserve it and recover from world.json.bak if appropriate: ${error instanceof Error ? error.message : String(error)}`); }
      this.#validate(this.#state);
    } else {
      const now = this.#now();
      const fresh: WorldState = { format: WORLD_FORMAT, revision: 0, createdAt: now, updatedAt: now,
        next: { object: 1, region: 1, message: 1, transaction: 1, timer: 1, regionGroup: 1, action: 1 },
        startRegionId: null, regions: {}, objects: {}, avatars: {}, documents: {}, mail: {}, timers: {}, regionGroups: {}, actions: {}, ledger: [], audit: [] };
      if (seed) this.#seed(fresh, startRegionName);
      this.#validate(fresh); this.#persist(fresh, false);
    }
  }

  #now() { return integer(this.clock(), 0, Number.MAX_SAFE_INTEGER, 'clock value'); }

  #seed(draft: WorldState, startName: string) {
    const regions = [text(startName, 63, 'region name', false), 'Garden', 'Library'];
    for (const name of regions) {
      const regionId = draft.next.region++, objectId = draft.next.object++;
      draft.regions[regionId] = { id: regionId, name, objectId, exits: {}, properties: {} };
      draft.objects[objectId] = { id: objectId, classNumber: 20, regionId, containerId: null, ownerId: null,
        capacity: 0, portable: false, locked: false, fields: { name: name.slice(0, 31), position: [0, 0, 0], horizon: 70,
          max_avatars: 32, max_ghosts: 32, colorMap: [...Array(16).keys()] } };
    }
    draft.startRegionId = 1;
    draft.regions[1].exits = { north: 2, east: 3 };
    draft.regions[2].exits = { south: 1, east: 3 };
    draft.regions[3].exits = { west: 1, north: 2 };
    const add = (classNumber: number, regionId: number, name: string, imageURL: string, position: Position, extra: Partial<GameObject> = {}) => {
      const objectId = draft.next.object++;
      draft.objects[objectId] = { id: objectId, classNumber, regionId, containerId: null, ownerId: null,
        capacity: 0, portable: true, locked: false, fields: { name, imageURL, imageVersion: 0, position, colorMap: [...Array(16).keys()] }, ...extra };
      return objectId;
    };
    add(36, 1, 'Community chest', 'o.chest5.img', [100, 220, 0], { capacity: 10, portable: false, shared: true });
    add(50, 1, 'Postbox', 'o.aa.mcp.postbox.img', [400, 220, 0], { portable: false });
    add(53, 2, 'Garden bench', 'o.bench1.img', [220, 220, 0], { capacity: 10, portable: false });
    const documentId = add(37, 3, 'Welcome book', 'o.bookopen.img', [180, 220, 0]);
    draft.documents[documentId] = { objectId: documentId, title: 'Welcome', text: 'Welcome to the local world. Regions, objects, possessions, mail and balances are saved on this server.', updatedAt: this.#now() };
    add(36, 3, 'Book bag', 'o.bag01.img', [340, 220, 0], { capacity: 10 });
  }

  #validate(state: WorldState) {
    jsonValue(state);
    if (!state || state.format !== WORLD_FORMAT) throw new WorldStoreError('Unsupported world format; no automatic destructive migration is performed');
    integer(state.revision, 0, Number.MAX_SAFE_INTEGER, 'world revision');
    for (const key of ['regions', 'objects', 'avatars', 'documents', 'mail', 'timers'] as const) {
      if (!state[key] || Array.isArray(state[key]) || typeof state[key] !== 'object') throw new WorldStoreError(`Missing world map ${key}`);
    }
    state.regionGroups ??= {}; state.actions ??= {};
    for (const counter of ['object', 'region', 'message', 'transaction', 'timer', 'regionGroup', 'action'] as const) id(state.next?.[counter], `Next ${counter}`);
    if (!Array.isArray(state.ledger) || !Array.isArray(state.audit)) throw new WorldStoreError('Missing world history');
    if (state.startRegionId !== null && !state.regions[state.startRegionId]) throw new WorldStoreError('Start region does not exist');
    const childCounts = new Map();
    for (const [key, object] of Object.entries(state.objects)) {
      if (String(id(object.id, 'Object ID')) !== key) throw new WorldStoreError('Object ID/key mismatch');
      integer(object.classNumber, 0, 65535, 'class number');
      required(state.regions, object.regionId, 'Object region');
      object.containerId ??= null; object.ownerId ??= null; object.fields ??= {};
      object.capacity ??= 0; object.portable ??= true; object.locked ??= false;
      integer(object.capacity, 0, 65535, 'object capacity');
      if (typeof object.portable !== 'boolean' || typeof object.locked !== 'boolean') throw new WorldStoreError('Invalid object flags');
      if (!object.fields || Array.isArray(object.fields) || typeof object.fields !== 'object') throw new WorldStoreError('Invalid object fields');
      if (object.ownerId !== null) required(state.avatars, object.ownerId, 'Object owner');
      if (object.containerId !== null) {
        const parent = required(state.objects, object.containerId, 'Object container');
        if (parent.id === object.id || parent.regionId !== object.regionId) throw new WorldStoreError('Object container is invalid or in another region');
        childCounts.set(parent.id, (childCounts.get(parent.id) ?? 0) + 1);
      }
      const seen = new Set([object.id]); let ancestor = object;
      while (ancestor.containerId !== null && ancestor.containerId !== undefined) {
        ancestor = required(state.objects, ancestor.containerId, 'Object ancestor');
        if (seen.has(ancestor.id)) throw new WorldStoreError('Inventory containment cycle');
        seen.add(ancestor.id);
      }
    }
    for (const [objectId, count] of childCounts) if (count > state.objects[objectId].capacity) throw new WorldStoreError('Container capacity exceeded');
    for (const [key, region] of Object.entries(state.regions)) {
      if (String(id(region.id, 'Region ID')) !== key) throw new WorldStoreError('Region ID/key mismatch');
      text(region.name, 63, 'region name', false); region.exits ??= {}; region.properties ??= {};
      const object = required(state.objects, region.objectId, 'Region root');
      if (object.classNumber !== 20 || object.regionId !== region.id || object.containerId !== null) throw new WorldStoreError('Region root is invalid');
      for (const target of Object.values(region.exits)) if (target !== null) required(state.regions, target, 'Exit region');
    }
    for (const [key, avatar] of Object.entries(state.avatars)) {
      if (String(id(avatar.id, 'Avatar ID')) !== key) throw new WorldStoreError('Avatar ID/key mismatch');
      id(avatar.accountId, 'Avatar account'); text(avatar.name, 29, 'avatar name', false);
      const object = required(state.objects, avatar.objectId, 'Avatar object');
      if (object.ownerId !== avatar.id || object.regionId !== avatar.regionId) throw new WorldStoreError('Avatar/object ownership or region mismatch');
      integer(avatar.balance, 0, MAX_BALANCE, 'avatar balance');
      avatar.preferences ??= {}; avatar.friends ??= []; avatar.ignored ??= []; avatar.mailbox ??= []; avatar.role ??= 'player';
      if (!ROLES.includes(avatar.role) || !Array.isArray(avatar.friends) || !Array.isArray(avatar.ignored) || !Array.isArray(avatar.mailbox)) throw new WorldStoreError('Invalid avatar profile');
      for (const friend of [...avatar.friends, ...avatar.ignored]) required(state.avatars, friend, 'Related avatar');
      if (new Set(avatar.friends).size !== avatar.friends.length || new Set(avatar.ignored).size !== avatar.ignored.length) throw new WorldStoreError('Duplicate avatar relationship');
      for (const mailId of avatar.mailbox) if (required(state.mail, mailId, 'Mailbox message').toId !== avatar.id) throw new WorldStoreError('Mailbox ownership mismatch');
    }
    for (const [key, document] of Object.entries(state.documents)) {
      if (String(id(document.objectId, 'Document object ID')) !== key) throw new WorldStoreError('Document ID/key mismatch');
      required(state.objects, document.objectId, 'Document object');
      text(document.title, 255, 'document title'); text(document.text, 65535, 'document text');
    }
    for (const [key, message] of Object.entries(state.mail)) {
      if (String(id(message.id, 'Mail ID')) !== key) throw new WorldStoreError('Mail ID/key mismatch');
      required(state.avatars, message.fromId, 'Mail sender'); required(state.avatars, message.toId, 'Mail recipient');
      text(message.subject, 255, 'mail subject'); text(message.body, 65535, 'mail body');
      if (!state.avatars[message.toId].mailbox.includes(message.id)) throw new WorldStoreError('Mail is missing from recipient mailbox');
    }
    for (const timer of Object.values(state.timers)) {
      id(timer.id, 'Timer ID'); if (timer.objectId !== null) required(state.objects, timer.objectId, 'Timer object');
      integer(timer.dueAt, 0, Number.MAX_SAFE_INTEGER, 'timer due time'); text(timer.kind, 100, 'timer kind', false);
    }
    for (const [counter, mapName] of [['object', 'objects'], ['region', 'regions'], ['message', 'mail'], ['timer', 'timers']] as const) {
      for (const value of Object.values(state[mapName])) if (state.next[counter] <= value.id) throw new WorldStoreError(`Invalid next ${counter} counter`);
    }
  }

  /** Keep the previous complete revision before replacing the live JSON file. */
  #persist(candidate: WorldState, backup = true) {
    const serialized = JSON.stringify(candidate, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new WorldStoreError('World file exceeds size limit');
    const suffix = '.' + randomBytes(6).toString('hex') + '.tmp';
    const temporary = this.filename + suffix; const backupTemp = this.backupFilename + suffix;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      if (backup && fs.existsSync(this.filename)) {
        fs.copyFileSync(this.filename, backupTemp, fs.constants.COPYFILE_EXCL);
        const backupFd = fs.openSync(backupTemp, 'r');
        try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
        fs.renameSync(backupTemp, this.backupFilename);
      }
      fs.renameSync(temporary, this.filename);
      // Directory syncing is supported on Unix and may be unavailable on Windows.
      try { const directory = fs.openSync(this.dataDir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } } catch {}
      this.#state = JSON.parse(serialized);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      for (const filename of [temporary, backupTemp]) try { fs.unlinkSync(filename); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  get state() { return this.snapshot(); }
  snapshot() { if (this.closed) throw new WorldStoreError('World store is closed'); return clone(this.#state); }
  /**
   * Changes stay isolated in a clone until validation and the final rename
   * succeed. No success reply may be sent from inside this synchronous callback.
   */
  transaction<T>(fn: (draft: WorldState) => T, { actorId = null, action = 'transaction', details = {}, authorize }: TransactionOptions = {}): T {
    if (this.closed) throw new WorldStoreError('World store is closed');
    if (this.#transaction) throw new WorldStoreError('Nested world transactions are not allowed');
    if (typeof fn !== 'function') throw new WorldStoreError('Transaction requires a function');
    this.#transaction = true;
    try {
      if (authorize && authorize(this.snapshot()) !== true) throw new WorldStoreError('World transaction is not authorized');
      const draft = clone(this.#state), result = fn(draft);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new WorldStoreError('World transactions must be synchronous');
      const now = this.#now(); audit(draft, now, action, actorId, details);
      draft.revision = this.#state.revision + 1; draft.updatedAt = now;
      const candidate = canonicalJSON(draft);
      this.#validate(candidate); this.#persist(candidate); return result;
    } finally { this.#transaction = false; }
  }

  getRegion(regionId: number | null | undefined): RegionRecord | null { return clone((regionId == null ? null : this.#state.regions[regionId]) ?? null); }
  getObject(objectId: number | null | undefined): GameObject | null { return clone((objectId == null ? null : this.#state.objects[objectId]) ?? null); }
  getAvatar(avatarId: number | AvatarIdentity): AvatarProfile | null { return clone(this.#state.avatars[profileId(avatarId)] ?? null); }
  listRegions() { return clone(Object.values(this.#state.regions)); }
  listObjects(filters: Partial<GameObject> = {}): GameObject[] {
    return clone(Object.values(this.#state.objects).filter(object => Object.entries(filters).every(([key, value]) => object[key] === value)));
  }

  /** Resolve the imported arrival region without changing the world's recovery
   * region or moving existing avatars. Explicit spawn choices still win. */
  defaultAvatarRegionId(): number | null {
    const regions = Object.values(this.#state.regions).filter(region => !region.properties?.pendingDeletion);
    const rose = regions.find(region => region.properties?.surveyImport?.sourceSceneId === OUTSIDE_THE_ROSE_SOURCE_SCENE)
      ?? regions.find(region => region.name.trim().toLowerCase() === 'outside the rose');
    return rose?.id ?? this.#state.startRegionId;
  }

  ensureAvatar(accountAvatar: AvatarIdentity, { regionId = this.defaultAvatarRegionId(), classNumber = 22, role = 'player', balance = 1000 }: { regionId?: number | null; classNumber?: number; role?: Role; balance?: number } = {}): AvatarProfile {
    const avatarId = id(accountAvatar?.id, 'Account avatar ID');
    const existing = this.#state.avatars[avatarId];
    if (existing) {
      if (existing.accountId !== accountAvatar.accountId) throw new WorldStoreError('Avatar account identity changed');
      // Repair the old placeholder palette only; keep every chosen palette and
      // the avatar's saved location. Repeated logins then need no transaction.
      const defaults = Object.values(this.#state.objects).filter(object =>
        (object.id === existing.objectId || object.classNumber === 24 && object.containerId === existing.objectId)
        && isLegacyAvatarColorMap(object.fields.colorMap));
      if (defaults.length) this.transaction(draft => {
        for (const object of defaults) draft.objects[object.id].fields.colorMap = [...DEFAULT_AVATAR_COLORS];
      }, { actorId: avatarId, action: 'avatar-default-colors' });
      return clone(existing);
    }
    return this.transaction(draft => {
      const spawnRegionId = required(draft.regions, regionId, 'Spawn region').id;
      id(accountAvatar.accountId, 'Avatar account'); text(accountAvatar.name, 29, 'avatar name', false);
      if (!ROLES.includes(role)) throw new WorldStoreError('Invalid avatar role'); integer(balance, 0, MAX_BALANCE, 'opening balance');
      const objectId = draft.next.object++;
      draft.objects[objectId] = { id: objectId, classNumber, regionId: spawnRegionId, containerId: null, ownerId: avatarId,
        capacity: classNumber === 21 ? 10 : 0, portable: false, locked: false,
        fields: { name: accountAvatar.name, position: [256, 220, 0], imageURL: classNumber === 22 ? 'o.ghost.img' : 'o.bodyma.img', imageVersion: 0, colorMap: [...DEFAULT_AVATAR_COLORS] } };
      draft.avatars[avatarId] = { id: avatarId, accountId: accountAvatar.accountId, name: accountAvatar.name,
        objectId, regionId: spawnRegionId, balance, ghost: classNumber === 22, role, preferences: {}, friends: [], ignored: [], mailbox: [] };
      if (balance) draft.ledger.push({ id: draft.next.transaction++, kind: 'opening-balance', fromId: null, toId: avatarId, amount: balance, at: this.#now() });
      return clone(draft.avatars[avatarId]);
    }, { actorId: avatarId, action: 'avatar-created' });
  }

  createRegion({ name, exits = {}, properties = {}, fields = {} }: { name: string; exits?: Record<string, number | null>; properties?: DynamicFields; fields?: DynamicFields }): RegionRecord {
    return this.transaction(draft => {
      const regionId = draft.next.region++, objectId = draft.next.object++;
      draft.regions[regionId] = { id: regionId, name, objectId, exits: clone(exits), properties: clone(properties) };
      draft.objects[objectId] = { id: objectId, classNumber: 20, regionId, containerId: null, ownerId: null,
        fields: { name: name.slice(0, 31), position: [0, 0, 0], horizon: 70, ...clone(fields) }, capacity: 0, portable: false, locked: false };
      if (draft.startRegionId === null) draft.startRegionId = regionId;
      return clone(draft.regions[regionId]);
    }, { action: 'region-created' });
  }

  createObject(input: Pick<GameObject, 'classNumber' | 'regionId'> & Partial<GameObject>, options: OwnershipOptions = {}): GameObject {
    return this.transaction(draft => {
      const objectId = draft.next.object++;
      const object = { id: objectId, classNumber: input.classNumber, regionId: input.regionId,
        containerId: input.containerId ?? null, ownerId: input.ownerId ?? options.actorId ?? null,
        fields: clone(input.fields ?? {}), capacity: input.capacity ?? 0, portable: input.portable ?? true,
        locked: input.locked ?? false };
      draft.objects[objectId] = object;
      return clone(object);
    }, { actorId: options.actorId, action: 'object-created' });
  }

  updateObject(objectId: number, patch: Partial<GameObject>, options: OwnershipOptions = {}): GameObject {
    return this.transaction(draft => {
      const object = required(draft.objects, objectId, 'Object');
      checkOwner(draft, object, options);
      if (['id', 'regionId', 'containerId', 'ownerId'].some(key => own(patch, key))) throw new WorldStoreError('Use move/ownership operations for object identity or containment');
      if (patch.fields) object.fields = { ...object.fields, ...clone(patch.fields) };
      for (const key of ['classNumber', 'capacity', 'portable', 'locked']) if (own(patch, key)) object[key] = patch[key];
      return clone(object);
    }, { actorId: options.actorId, action: 'object-updated', details: { objectId } });
  }

  moveObject(objectId: number, target: { containerId?: number | null; regionId?: number; position?: Position }, options: OwnershipOptions = {}): GameObject {
    return this.transaction(draft => {
      const object = required(draft.objects, objectId, 'Object'); checkOwner(draft, object, options);
      if (!object.portable && !options.admin) throw new WorldStoreError('Object is not portable');
      if (Object.values(draft.regions).some(region => region.objectId === object.id)) throw new WorldStoreError('A region root cannot be moved');
      const containerId = target.containerId ?? null;
      const destination = containerId === null ? null : required(draft.objects, containerId, 'Destination container');
      if (destination?.locked && !options.admin) throw new WorldStoreError('Destination is locked');
      if (destination && destination.ownerId !== null && destination.ownerId !== options.actorId && !options.admin && !destination.shared) throw new WorldStoreError('Destination is owned by another avatar');
      const regionId = target.regionId ?? destination?.regionId ?? object.regionId;
      required(draft.regions, regionId, 'Destination region');
      if (destination && destination.regionId !== regionId) throw new WorldStoreError('Destination region/container mismatch');
      object.containerId = containerId;
      const moveTree = (current: GameObject): void => {
        current.regionId = regionId;
        for (const child of Object.values(draft.objects)) if (child.containerId === current.id) moveTree(child);
      };
      // Check cycles before recursive movement; validation checks them again.
      for (let current = destination; current; current = current.containerId === null ? null : draft.objects[current.containerId]) if (current.id === objectId) throw new WorldStoreError('Inventory containment cycle');
      moveTree(object);
      if (target.position !== undefined) {
        if (!Array.isArray(target.position) || target.position.length !== 3) throw new WorldStoreError('Position needs three signed coordinates');
        object.fields.position = target.position.map(value => integer(value, -32768, 32767, 'position coordinate'));
      }
      const avatar = Object.values(draft.avatars).find(value => value.objectId === object.id);
      if (avatar) avatar.regionId = regionId;
      return clone(object);
    }, { actorId: options.actorId, action: 'object-moved', details: { objectId } });
  }

  deleteObject(objectId: number, { recursive = false, ...options }: OwnershipOptions & { recursive?: boolean } = {}): number[] {
    return this.transaction(draft => {
      const object = required(draft.objects, objectId, 'Object'); checkOwner(draft, object, options);
      if (Object.values(draft.regions).some(region => region.objectId === objectId) || Object.values(draft.avatars).some(avatar => avatar.objectId === objectId)) throw new WorldStoreError('Use an explicit region/avatar lifecycle operation for this object');
      const descendants = new Set([objectId]);
      for (let changed = true; changed;) { changed = false; for (const child of Object.values(draft.objects)) if (descendants.has(child.containerId as number) && !descendants.has(child.id)) { descendants.add(child.id); changed = true; } }
      if (!recursive && descendants.size > 1) throw new WorldStoreError('Container is not empty');
      for (const removed of descendants) { delete draft.objects[removed]; delete draft.documents[removed]; }
      for (const [key, timer] of Object.entries(draft.timers)) if (descendants.has(timer.objectId as number)) delete draft.timers[key];
      return [...descendants];
    }, { actorId: options.actorId, action: 'object-deleted', details: { objectId } });
  }

  transferFunds(fromId: number, toId: number, amount: number, { reason = 'transfer' }: { reason?: string } = {}) {
    return this.transaction(draft => {
      const from = required(draft.avatars, fromId, 'Sending avatar'), to = required(draft.avatars, toId, 'Receiving avatar');
      integer(amount, 1, MAX_BALANCE, 'transfer amount');
      if (from.balance < amount) throw new WorldStoreError('Insufficient balance');
      if (fromId === toId) return { fromBalance: from.balance, toBalance: to.balance };
      integer(to.balance + amount, 0, MAX_BALANCE, 'resulting balance');
      from.balance -= amount; to.balance += amount;
      const entry = { id: draft.next.transaction++, kind: 'transfer', fromId, toId, amount, reason: text(reason, 255, 'transfer reason'), at: this.#now() };
      draft.ledger.push(entry); return { ...entry, fromBalance: from.balance, toBalance: to.balance };
    }, { actorId: fromId, action: 'funds-transferred', details: { toId, amount } });
  }

  updatePreferences(avatarId: number, patch: DynamicFields) {
    return this.transaction(draft => { const avatar = required(draft.avatars, avatarId, 'Avatar'); avatar.preferences = { ...avatar.preferences, ...clone(patch) }; return clone(avatar.preferences); }, { actorId: avatarId, action: 'preferences-updated' });
  }
  setRelationship(avatarId: number, otherId: number, kind: 'friends' | 'ignored', enabled = true) {
    if (!['friends', 'ignored'].includes(kind)) throw new WorldStoreError('Unknown relationship');
    return this.transaction(draft => {
      const avatar = required(draft.avatars, avatarId, 'Avatar'); required(draft.avatars, otherId, 'Related avatar');
      if (avatarId === otherId) throw new WorldStoreError('Cannot add yourself');
      avatar[kind] = avatar[kind].filter(value => value !== otherId); if (enabled) avatar[kind].push(otherId);
      return clone(avatar[kind]);
    }, { actorId: avatarId, action: `${kind}-updated`, details: { otherId, enabled } });
  }
  getDocument(objectId: number) { return clone(this.#state.documents[objectId] ?? null); }
  writeDocument(objectId: number, { title = '', text: contents = '' }: { title?: string; text?: string }, options: OwnershipOptions = {}) {
    return this.transaction(draft => {
      const object = required(draft.objects, objectId, 'Document object'); checkOwner(draft, object, options);
      const document = { objectId, title: text(title, 255, 'document title'), text: text(contents, 65535, 'document text'), updatedAt: this.#now() };
      draft.documents[objectId] = document; return clone(document);
    }, { actorId: options.actorId, action: 'document-written', details: { objectId } });
  }
  sendMail(fromId: number, toId: number, { subject = '', body = '' }: { subject?: string; body?: string } = {}) {
    return this.transaction(draft => {
      const from = required(draft.avatars, fromId, 'Mail sender'), to = required(draft.avatars, toId, 'Mail recipient');
      if (to.ignored.includes(fromId)) throw new WorldStoreError('Recipient is ignoring sender');
      if (to.mailbox.length >= 1000) throw new WorldStoreError('Recipient mailbox is full');
      const messageId = draft.next.message++;
      const message = { id: messageId, fromId, toId, fromName: from.name, subject: text(subject, 255, 'mail subject'), body: text(body, 65535, 'mail body'), createdAt: this.#now(), readAt: null };
      draft.mail[messageId] = message; to.mailbox.push(messageId); return clone(message);
    }, { actorId: fromId, action: 'mail-sent', details: { toId } });
  }
  listMail(avatarId: number) { const avatar = required(this.#state.avatars, avatarId, 'Avatar'); return clone(avatar.mailbox.map(messageId => this.#state.mail[messageId])); }
  readMail(avatarId: number, messageId: number) {
    return this.transaction(draft => { const message = required(draft.mail, messageId, 'Message'); if (message.toId !== avatarId) throw new WorldStoreError('Message is private'); message.readAt ??= this.#now(); return clone(message); }, { actorId: avatarId, action: 'mail-read', details: { messageId } });
  }
  deleteMail(avatarId: number, messageId: number) {
    return this.transaction(draft => { const avatar = required(draft.avatars, avatarId, 'Avatar'), message = required(draft.mail, messageId, 'Message'); if (message.toId !== avatarId) throw new WorldStoreError('Message is private'); delete draft.mail[messageId]; avatar.mailbox = avatar.mailbox.filter(value => value !== messageId); return true; }, { actorId: avatarId, action: 'mail-deleted', details: { messageId } });
  }
  dueTimers(now = this.#now()) { return clone(Object.values(this.#state.timers).filter(timer => timer.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)); }
  scheduleTimer(objectId: number | null, kind: string, dueAt: number, payload: DynamicFields = {}) {
    return this.transaction(draft => {
      if (objectId !== null) required(draft.objects, objectId, 'Timer object');
      const timerId = draft.next.timer++;
      const timer = { id: timerId, objectId, kind: text(kind, 100, 'timer kind', false),
        dueAt: integer(dueAt, 0, Number.MAX_SAFE_INTEGER, 'timer due time'), payload: clone(payload) };
      draft.timers[timerId] = timer; return clone(timer);
    }, { action: 'timer-scheduled', details: { objectId, kind } });
  }
  cancelTimer(timerId: number, options: OwnershipOptions = {}) {
    return this.transaction(draft => {
      const timer = required(draft.timers, timerId, 'Timer');
      if (timer.objectId !== null) checkOwner(draft, required(draft.objects, timer.objectId, 'Timer object'), options);
      else if (!options.admin) throw new WorldStoreError('Only server authority can cancel a world timer');
      delete draft.timers[timerId]; return clone(timer);
    }, { actorId: options.actorId, action: 'timer-cancelled', details: { timerId } });
  }
  consumeDueTimers(now = this.#now()) {
    integer(now, 0, Number.MAX_SAFE_INTEGER, 'timer cutoff');
    if (!this.dueTimers(now).length) return [];
    return this.transaction(draft => {
      const due = Object.values(draft.timers).filter(timer => timer.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
      for (const timer of due) delete draft.timers[timer.id];
      return clone(due);
    }, { action: 'timers-consumed' });
  }
  finalizePendingRegions(occupiedRegionIds: Iterable<number> = []) {
    const occupied = new Set([...occupiedRegionIds].map(value => id(value, 'Occupied region ID')));
    const pendingGroupRegions = new Set(Object.values(this.#state.regionGroups).filter(group => group.pendingDeletion === true).flatMap(group => group.regionIds ?? []));
    const deletedRegionIds = Object.values(this.#state.regions)
      .filter(region => region.id !== this.#state.startRegionId && !occupied.has(region.id)
        && (region.properties?.pendingDeletion === true || pendingGroupRegions.has(region.id)))
      .map(region => region.id).sort((a, b) => a - b);
    const deleting = new Set(deletedRegionIds);
    const emptyPendingGroups = Object.values(this.#state.regionGroups).filter(group => group.pendingDeletion === true
      && (group.regionIds ?? []).every(regionId => deleting.has(regionId)));
    if (!deletedRegionIds.length && !emptyPendingGroups.length) return { deletedRegionIds: [], relocatedAvatarIds: [] };
    const details: DynamicFields = {};
    return this.transaction(draft => {
      // A nonempty preservation/relocation loop below implies a deleted region,
      // so it always has a validated fallback; group-only cleanup needs none.
      const fallback = deletedRegionIds.length ? required(draft.regions, draft.startRegionId, 'Safe start region') : null;
      const regionRoots = new Set(deletedRegionIds.map(regionId => draft.regions[regionId].objectId));
      const candidates = Object.values(draft.objects).filter(object => deleting.has(object.regionId));
      const candidateIds = new Set(candidates.map(object => object.id));
      const avatarRoots = new Set(Object.values(draft.avatars).filter(avatar => deleting.has(avatar.regionId)).map(avatar => avatar.objectId));
      // Preserve players and all owned possessions, including items left on the
      // ground. Unowned children/archive members of a preserved item travel too.
      const preserved = new Set(candidates.filter(object => !regionRoots.has(object.id)
        && (avatarRoots.has(object.id) || object.ownerId !== null
          || (object.archivedIn && draft.objects[object.archivedIn] && !candidateIds.has(object.archivedIn))))
        .map(object => object.id));
      const archiveParents = new Map<number, number>();
      for (const document of Object.values(draft.documents)) for (const entry of document.entries ?? []) {
        if (candidateIds.has(entry) && !regionRoots.has(entry)) {
          archiveParents.set(entry, document.objectId);
          if (!candidateIds.has(document.objectId)) preserved.add(entry);
        }
      }
      for (let changed = true; changed;) {
        changed = false;
        for (const object of candidates) {
          if (regionRoots.has(object.id) || preserved.has(object.id)) continue;
          if (preserved.has(object.containerId as number) || preserved.has(object.archivedIn as number) || preserved.has(archiveParents.get(object.id) as number)) {
            preserved.add(object.id); changed = true;
          }
        }
      }
      const removedObjects = new Set(candidates.filter(object => !preserved.has(object.id)).map(object => object.id));
      const destinations = new Map<number, number>();
      const destinationFor = (objectId: number, visiting = new Set<number>()): number => {
        if (destinations.has(objectId)) return destinations.get(objectId)!;
        if (avatarRoots.has(objectId) || visiting.has(objectId)) return fallback!.id;
        const object = draft.objects[objectId];
        visiting.add(objectId);
        const parentId = preserved.has(object.containerId as number) ? object.containerId : object.archivedIn ?? archiveParents.get(objectId);
        const parent = parentId ? draft.objects[parentId] : null;
        const regionId = parent && !removedObjects.has(parentId as number)
          ? preserved.has(parentId as number) ? destinationFor(parentId as number, visiting) : parent.regionId : fallback!.id;
        destinations.set(objectId, regionId); return regionId;
      };
      for (const objectId of preserved) {
        const object = draft.objects[objectId];
        object.regionId = destinationFor(objectId);
        if (object.containerId !== null && removedObjects.has(object.containerId as number)) object.containerId = null;
        if (avatarRoots.has(objectId)) { object.containerId = null; object.fields.position = [256, 220, 0]; }
      }
      const relocatedAvatarIds: number[] = [];
      for (const avatar of Object.values(draft.avatars)) if (deleting.has(avatar.regionId)) {
        avatar.regionId = fallback!.id; avatar.position = [256, 220, 0];
        avatar.preferences.following = null;
        const actor = draft.objects[avatar.objectId]; actor.fields.following = 65535; actor.fields.webfollowing = 0;
        relocatedAvatarIds.push(avatar.id);
      }
      for (const objectId of removedObjects) { delete draft.objects[objectId]; delete draft.documents[objectId]; }
      for (const object of Object.values(draft.objects)) {
        if (removedObjects.has(object.containerId as number)) object.containerId = null;
        if (removedObjects.has(object.archivedIn as number)) {
          object.fields.common_flags = object.archivedFlags ?? ((object.fields.common_flags ?? 0) & ~1);
          delete object.archivedIn; delete object.archivedFlags;
        }
        if (removedObjects.has(object.fields.following)) object.fields.following = 65535;
        if (removedObjects.has(object.fields.webfollowing)) object.fields.webfollowing = 0;
      }
      for (const document of Object.values(draft.documents)) if (Array.isArray(document.entries)) document.entries = document.entries.filter(objectId => !removedObjects.has(objectId));
      for (const [timerId, timer] of Object.entries(draft.timers)) {
        if (removedObjects.has(timer.objectId as number) || deleting.has(timer.regionId) || deleting.has(timer.payload?.regionId)) delete draft.timers[timerId];
      }
      for (const regionId of deletedRegionIds) delete draft.regions[regionId];
      for (const region of Object.values(draft.regions)) for (const [direction, target] of Object.entries(region.exits)) if (deleting.has(target as number)) delete region.exits[direction];
      for (const [groupId, group] of Object.entries(draft.regionGroups)) {
        group.regionIds = (group.regionIds ?? []).filter(regionId => !deleting.has(regionId));
        if (!group.regionIds.includes(group.entryRegionId as number)) group.entryRegionId = group.regionIds[0] ?? null;
        if (group.pendingDeletion === true && !group.regionIds.length) delete draft.regionGroups[groupId];
      }
      relocatedAvatarIds.sort((a, b) => a - b);
      Object.assign(details, { deletedRegionIds, relocatedAvatarIds, removedObjectCount: removedObjects.size, preservedObjectCount: preserved.size });
      // Mail addresses stable avatar identities, not deleted region instances.
      // Keeping those identities means private mail and balances remain intact.
      return { deletedRegionIds, relocatedAvatarIds };
    }, { action: 'pending-regions-finalized', details });
  }
  close() { this.closed = true; }
}
