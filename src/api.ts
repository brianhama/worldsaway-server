import type { NativeFields } from './types.js';

import { SchemaError } from './classes.js';
import { WorldStoreError } from './world-store.js';
import { ProtocolError } from './protocol.js';
import { configureBusRoute, AutomationError } from './automation.js';
import type { CompatibilityServer } from './server.js';
import type { WorldStore } from './world-store.js';
import type { AccountRecord } from './types.js';

export class WorldApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const copy = <T>(value: T): T => structuredClone(value);
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const lifecycleClasses = new Set([0, 1, 2, 3, 4, 10, 11, 20, 21, 22]);
const protectedNativeFields = new Set(['classNumber', 'basesvr_pad1', 'noid', 'container_noid']);
const patchKeys = new Set(['fields', 'properties', 'description', 'capacity', 'portable', 'locked', 'open', 'cashReserve']);
function plainObject(value: unknown, label: string): NativeFields {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new WorldApiError(400, `${label} must be a JSON object`);
  return value as NativeFields;
}
function checkedJson(value: unknown, depth = 0) {
  if (depth > 40) throw new WorldApiError(400, 'JSON configuration is nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') throw new WorldApiError(400, 'Configuration must contain JSON values');
  if (!Array.isArray(value)) plainObject(value, 'Configuration');
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new WorldApiError(400, 'Reserved configuration property');
    checkedJson(item, depth + 1);
  }
}
function json(params: URLSearchParams, key: string, fallback: NativeFields = {}): NativeFields {
  try {
    const value = params.has(key) ? JSON.parse(params.get(key)!) : fallback;
    const object = plainObject(value, key); checkedJson(object);
    return object;
  } catch (error) { if (error instanceof WorldApiError) throw error; throw new WorldApiError(400, `${key} must be a JSON object`); }
}
function number(params: URLSearchParams, key: string) {
  const raw = params.get(key), value = Number(raw);
  if (!/^\d+$/.test(raw ?? '') || !Number.isSafeInteger(value) || value < 1) throw new WorldApiError(400, `${key} must be a positive integer`);
  return value;
}

function nativeFields(server: CompatibilityServer, classNumber: number, input: NativeFields, existing: NativeFields = {}) {
  // JSON configuration is not a route around native identity, field-width or
  // resource admission checks. The same registry validates native and HTTP edits.
  plainObject(input, 'fields');
  if (Object.keys(input).some(key => protectedNativeFields.has(key))) throw new WorldApiError(400, 'Native identity fields cannot be patched');
  const registry = server.runtime!.registry, definition = registry.get(classNumber)!;
  const allowed = new Set(definition.fields.filter(field => field.scope === 'b' || field.scope === 's').map(field => field.name));
  if (Object.keys(input).some(key => !allowed.has(key))) throw new WorldApiError(400, 'Unknown or client-only native field; use properties for configuration metadata');
  const result = { ...registry.defaults(classNumber), ...copy(existing), ...copy(input) };
  for (const key of ['name', 'imageURL', 'URLlabel']) {
    const field = definition.fields.find(item => item.name === key && item.type === 'c' && typeof item.count === 'number');
    if (field && typeof field.count === 'number' && (typeof result[key] !== 'string' || result[key].length >= field.count)) throw new WorldApiError(400, `${key} must fit ${field.count - 1} terminated native characters`);
  }
  if (result.imageURL && !server.resources.getFileInfo(result.imageURL)) throw new WorldApiError(400, 'Image is not in the admitted cache');
  registry.validateObject({ classNumber, fields: result }, { includeServer: true });
  return result;
}

function guardedDelete(store: WorldStore, objectId: number | null, recursive: boolean) {
  const state = store.snapshot(), removed = new Set<number | null | undefined>([objectId]);
  if (recursive) for (let changed = true; changed;) {
    changed = false;
    for (const item of Object.values(state.objects)) if (removed.has(item.containerId) && !removed.has(item.id)) { removed.add(item.id); changed = true; }
  }
  if (Object.values(state.mail).some(message => [message.objectId, message.parcelObjectId, message.attachmentObjectId].some(id => removed.has(id)))
      || Object.values(state.objects).some(item => removed.has(item.archivedIn) || (removed.has(item.id) && item.archivedIn))
      || Object.values(state.documents).some(document => !removed.has(document.objectId) && document.entries?.some(id => removed.has(id)))) {
    throw new WorldApiError(409, 'Use the parcel or binder lifecycle before deleting referenced objects');
  }
}

/** Credential-authenticated operator/own-profile API, separate from native IDs. */
export async function handleWorldApi(server: CompatibilityServer, account: AccountRecord, params: URLSearchParams, pathname: string) {
  const runtime = server.runtime;
  if (!runtime) throw new WorldApiError(409, 'World features require the region profile');
  const requested = params.get('avatar');
  const selected = requested ? server.store.findAvatar(account, requested) : server.store.listAvatars(account)[0];
  if (!selected) throw new WorldApiError(403, 'Select an owned avatar');
  try { runtime.assertLogin({ account, avatar: selected }); }
  catch (error) { if (error instanceof ProtocolError) throw new WorldApiError(403, error.message); throw error; }
  const store = runtime.worldStore, existingProfile = store.getAvatar(selected.id);
  if (existingProfile && existingProfile.accountId !== account.id) throw new WorldApiError(403, 'World avatar ownership does not match account');
  if (pathname === '/api/world' && !['builder', 'admin'].includes(existingProfile?.role ?? 'player')) throw new WorldApiError(403, 'A persisted builder or admin role is required');
  const profile = existingProfile ?? store.ensureAvatar(selected);
  const action = params.get('action') ?? 'get';
  if (pathname === '/api/profile') {
    if (action === 'get') return { profile: store.getAvatar(selected.id), object: store.getObject(profile.objectId) };
    if (action === 'preferences') {
      const raw = params.get('flags'), flags = Number(raw);
      const userMask = 32 | 64 | 512 | 4096 | 32768;
      if (!/^\d+$/.test(raw ?? '') || !Number.isInteger(flags) || flags < 0 || flags > 0xffff || (flags & ~userMask)) throw new WorldApiError(400, 'Only personal messaging/display flags may be changed');
      store.transaction(draft => { const pref = draft.avatars[selected.id].preferences; pref.flags = ((pref.flags ?? 0) & ~userMask) | flags; }, { actorId: selected.id, action: 'profile-preferences' });
    } else if (['friend', 'unfriend', 'ignore', 'unignore'].includes(action)) {
      const target = Object.values(store.snapshot().avatars).find(item => item.name.toLowerCase() === String(params.get('name') ?? '').toLowerCase());
      if (!target) throw new WorldApiError(404, 'Avatar has not entered this world');
      try { store.setRelationship(selected.id, target.id, action.includes('friend') ? 'friends' : 'ignored', !action.startsWith('un')); }
      catch (error) { if (error instanceof WorldStoreError) throw new WorldApiError(400, error.message); throw error; }
    } else throw new WorldApiError(400, 'Unknown profile action');
    return { profile: store.getAvatar(selected.id) };
  }
  if (!['builder', 'admin'].includes(profile.role)) throw new WorldApiError(403, 'A persisted builder or admin role is required');
  if (action === 'get') {
    const state = store.snapshot();
    return profile.role === 'admin' ? state : { revision: state.revision, regions: state.regions, objects: state.objects, regionGroups: state.regionGroups, busRoutes: state.busRoutes ?? {} };
  }
  if (action === 'configure-bus') {
    try {
      const data = json(params, 'data');
      const result = store.transaction(draft => configureBusRoute(draft, { ...data,
        id: data.id, vehicleObjectId: data.vehicleObjectId, stopObjectIds: data.stopObjectIds,
        startAt: data.startAt ?? runtime.now() + (data.intervalSeconds ?? 30) * 1000 }),
      { actorId: selected.id, action: 'api-configure-bus', details: { routeId: data.id } });
      const state = store.snapshot();
      for (const regionId of new Set(result.stopObjectIds.map(id => state.objects[id].regionId))) await runtime.refreshRegion(regionId);
      return { result, revision: state.revision };
    } catch (error) { if (error instanceof AutomationError || error instanceof WorldStoreError) throw new WorldApiError(400, error.message); throw error; }
  }
  if (action === 'create-region') {
    try {
      const name = params.get('name') ?? 'New region', fields = json(params, 'fields');
      if (Object.hasOwn(fields, 'name')) throw new WorldApiError(400, 'Use the region name parameter for its native name');
      const native = nativeFields(server, 20, { ...fields, name: name.slice(0, 31) });
      const region = store.createRegion({ name, fields: native, properties: json(params, 'properties') });
      return { region, revision: store.snapshot().revision };
    } catch (error) { if (error instanceof SchemaError || error instanceof WorldStoreError) throw new WorldApiError(400, error.message); throw error; }
  }
  const objectId = action === 'create-object' ? null : number(params, 'id');
  const existing = objectId === null ? null : store.getObject(objectId);
  if (objectId !== null && !existing) throw new WorldApiError(404, 'Object does not exist');
  const classNumber = action === 'create-object' ? number(params, 'classNumber') : existing!.classNumber;
  const definition = runtime.registry.get(classNumber);
  if (!definition || lifecycleClasses.has(classNumber) || !definition.fields.some(field => field.name === 'noid')) throw new WorldApiError(400, 'This class has a dedicated server lifecycle');
  const regionId = action === 'create-object' ? number(params, 'regionId') : existing!.regionId;
  let result;
  try {
    if (action === 'create-object' || action === 'update-object') {
      const patch = json(params, 'data');
      if (Object.keys(patch).some(key => !patchKeys.has(key))) throw new WorldApiError(400, 'Only fields, properties, description, capacity, portable, locked, open and admin cashReserve may be patched');
      if (Object.hasOwn(patch, 'fields')) plainObject(patch.fields, 'fields');
      if (Object.hasOwn(patch, 'properties')) plainObject(patch.properties, 'properties');
      if (Object.hasOwn(patch, 'description') && (typeof patch.description !== 'string' || patch.description.length > 65535 || patch.description.includes('\0'))) throw new WorldApiError(400, 'Invalid object description');
      for (const key of ['portable', 'locked', 'open']) if (Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean') throw new WorldApiError(400, `${key} must be boolean`);
      if (Object.hasOwn(patch, 'cashReserve') && (profile.role !== 'admin' || !Number.isSafeInteger(patch.cashReserve) || patch.cashReserve < 0 || patch.cashReserve > 0x7fffffff)) throw new WorldApiError(400, 'Only admin may set a bounded device cash reserve');
      const fields = nativeFields(server, classNumber, patch.fields ?? {}, existing?.fields);
      if ('reducedCapacity' in fields && !Object.hasOwn(patch.fields ?? {}, 'reducedCapacity') && !existing) fields.reducedCapacity = definition.capacity;
      const capacity = Object.hasOwn(patch, 'capacity') ? patch.capacity : existing?.capacity ?? definition.capacity;
      if (!Number.isInteger(capacity) || capacity < 0 || capacity > definition.capacity) throw new WorldApiError(400, 'Capacity exceeds the native class layout');
      if (Number.isInteger(fields.reducedCapacity) && fields.reducedCapacity > capacity) throw new WorldApiError(400, 'Usable slots exceed object capacity');
      runtime.registry.validateObject({ classNumber, fields }, { includeServer: true });
      result = store.transaction(draft => {
        if (!draft.regions[regionId]) throw new WorldApiError(404, 'Region does not exist');
        const id = existing?.id ?? draft.next.object++;
        draft.objects[id] = { ...(existing ?? { id, classNumber, regionId, ownerId: null, containerId: null, portable: true, locked: false }), ...copy(patch), capacity, fields };
        return copy(draft.objects[id]);
      }, { actorId: selected.id, action: `api-${action}`, details: { classNumber, keys: Object.keys(patch), ...(Object.hasOwn(patch, 'cashReserve') ? { cashReserve: patch.cashReserve } : {}) } });
    } else if (action === 'delete-object') {
      guardedDelete(store, objectId, params.get('recursive') === 'true');
      store.deleteObject(objectId!, { actorId: selected.id, admin: true, recursive: params.get('recursive') === 'true' });
      result = { deleted: objectId };
    } else throw new WorldApiError(400, 'Unknown world action');
  } catch (error) {
    if (error instanceof SchemaError || error instanceof WorldStoreError) throw new WorldApiError(400, error.message);
    throw error;
  }
  await runtime.refreshRegion(regionId);
  return { result, revision: store.snapshot().revision };
}
