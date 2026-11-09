import type { DynamicFields, NativeFields, GameObject, AvatarProfile, RegionRecord, RegionGroupRecord, WorldState } from './types.js';
import type { ActionContext, ActionSession, NativeActionRequest, SchemaValue } from './action-types.js';
/**
 * Scene Builder contracts recovered from client Tcl, with local authoritative
 * editing rules. Scripts are stored as metadata; this server never evaluates
 * arbitrary source received through the action editor.
 */
import { encodeClientString } from './classes.js';

export const SUPPORTED_REQUESTS = Object.freeze(([
  [131, 'set home guest policy', 70, false], [137, 'remove home guests', 70, false],
  [139, 'remove named home guest', 70, false], [141, 'set owner-exit guest policy', 70, false],
  [143, 'toggle home guests', 70, false], [147, 'read home owners', 148, false],
  [150, 'read home access policy', 151, false], [161, 'read object URL', 162, false],
  [165, 'set object URL', 70, false], [186, 'set object glue state', 70, false], [194, 'set object description', 70, false],
  [200, 'create objects', 70], [201, 'duplicate object', 70], [202, 'delete object', 70],
  [203, 'read field', 204], [205, 'write field', 80], [206, 'list fields', 207],
  [208, 'read property', 209], [210, 'write property', 70], [211, 'read public property', 212, false],
  [220, 'create region', 70], [221, 'duplicate current region', 70], [222, 'mark region for deletion', 70],
  [223, 'current region details', 224], [225, 'modify region', 70], [226, 'list regions', 227],
  [230, 'create region group', 70], [231, 'duplicate current group', 70], [232, 'mark current group for deletion', 70],
  [233, 'current group details', 234], [235, 'modify group', 70], [236, 'add region to group', 70],
  [237, 'remove region from group', 70], [238, 'list groups', 239],
  [4001, 'read rental plan', 4002, false], [4005, 'rent home', 4006, false],
  [4009, 'pay home rent', 70, false], [4013, 'break home lease', 4014, false],
  [4016, 'quote home rent', 4017, false], [4020, 'read lease URL', 4021, false],
  [4024, 'add home co-owner', 70, false], [4028, 'change home address', 70, false],
  [3051, 'legacy fiddle create object', 70], [3053, 'legacy fiddle delete object', 70],
  [5302, 'builder rename', 70], [5306, 'builder description', 70],
  [5310, 'builder create object', 5311], [5314, 'builder duplicate object', 70],
  [5318, 'builder delete object', 70], [5322, 'builder update object', 5323],
  [5333, 'builder colors', 70],
  [30001, 'read action binding', 30002], [30003, 'write action binding', 70],
  [30004, 'read stored action', 30005], [30006, 'store action metadata', 70],
] as [number, string, number, boolean?][]).map(([id, name, replyId, admin = true]) => Object.freeze({ id, name, replyId, admin })));

const contracts = new Map(SUPPORTED_REQUESTS.map(contract => [contract.id, contract]));
const readOnly = new Set([137, 139, 147, 150, 161, 203, 206, 208, 211, 223, 226, 233, 238, 4001, 4016, 4020, 30001, 30004]);
const identityFields = new Set(['classNumber', 'noid', 'container_noid', 'owner', 'id', 'objectId', 'ownerId', 'accountId', 'role', 'permissions', 'permissionLevel', 'balance', 'following', 'webfollowing']);
const publicProperties = new Set(['URL', '.URL', 'help', '.help', 'description', '.description', '.popDests']);
const protectedClasses = new Set([0, 1, 2, 3, 4, 10, 11, 20, 21, 22]);
const own = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);
const copy = <T>(value: T): T => structuredClone(value);

interface RentalPlan {
  number: number; rent: number; available: number; periodMs: number;
  info: string; maxAdvance: number;
}
interface BuilderResult {
  replyId: number; reply: NativeFields; refresh: number[]; evict: number[];
  created: GameObject | null; updated: GameObject | null;
}

class BuilderError extends Error {
  readonly status: number;
  constructor(message: string, status = 5) { super(message); this.status = status; }
}

function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BuilderError(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function text(value: unknown, maximum: number, name: string, { empty = true, line = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > maximum || (!empty && !value.trim())
      || (line && /[\r\n]/.test(value))) {
    throw new BuilderError(`${name} must fit ${maximum} single-byte characters`);
  }
  try { if (encodeClientString(value).length > maximum) throw new Error(); }
  catch { throw new BuilderError(`${name} contains text outside the client character set`); }
  return value;
}

function propertyName(value: unknown): string {
  const checked = text(value, 64, 'Property name', { empty: false, line: true });
  if (!/^\.?[A-Za-z_][A-Za-z0-9_.-]*$/.test(checked) || /(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$)/.test(checked)
      || identityFields.has(checked.replace(/^\./, ''))) throw new BuilderError('That property is protected');
  return checked;
}

function tclWord(value: unknown) {
  const string = String(value);
  return string ? string.replace(/[\\\[\]{}$;\s]/g, char => char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : `\\${char}`) : '{}';
}

function addressOf(region: RegionRecord) { return region.properties?.address ?? String(region.id); }
function areaOf(region: RegionRecord) { return Number(region.properties?.areaCode ?? 0); }
function findRegion(draft: WorldState, address: string, areaCode: number) {
  return Object.values(draft.regions).find(region => addressOf(region).toLowerCase() === String(address).toLowerCase() && areaOf(region) === Number(areaCode));
}
function findGroup(draft: WorldState, address: string, areaCode: number) {
  return Object.values(draft.regionGroups ?? {}).find(group => group.address.toLowerCase() === String(address).toLowerCase() && group.areaCode === Number(areaCode));
}
function currentGroup(draft: WorldState, regionId: number) { return Object.values(draft.regionGroups ?? {}).find(group => group.regionIds.includes(regionId)); }

export class BuilderActions {
  readonly context: ActionContext;
  constructor(context: ActionContext) {
    if (!context?.worldStore || !context.registry || typeof context.reply !== 'function') throw new TypeError('BuilderActions requires a world store, registry and reply function');
    this.context = context;
  }

  profile(session: ActionSession, draft: WorldState) {
    const id = session.avatar?.id ?? session.avatarId;
    const profile = draft.avatars[id];
    if (!profile) throw new BuilderError('Avatar profile is unavailable', 16);
    return profile;
  }

  assertBuilder(profile: AvatarProfile) {
    if (!['admin', 'builder'].includes(profile.role)) throw new BuilderError('Builder permission is required', 16);
  }

  resolve(session: ActionSession, nativeNoid: number, draft: WorldState) {
    const resolved = this.context.resolveObject(session, nativeNoid);
    const id = typeof resolved === 'number' ? resolved : resolved?.id;
    if (!id || !draft.objects[id]) throw new BuilderError('That object is not accessible', 16);
    return draft.objects[id];
  }

  classInfo(classNumber: number) {
    const info = this.context.registry.get(integer(classNumber, 0, 65535, 'Class number'));
    if (!info) throw new BuilderError('Unknown class');
    return info;
  }

  validateObject(object: GameObject) {
    if (typeof this.context.registry.validateObject === 'function') this.context.registry.validateObject(object, { includeServer: true, strictFields: false });
    else this.context.registry.encodeObject(object);
    return object;
  }

  createObject(draft: WorldState, profile: AvatarProfile, classNumber: number, x: number, y: number, template?: GameObject) {
    const info = this.classInfo(classNumber);
    if (protectedClasses.has(info.classNumber) || !['noid', 'container_noid', 'name', 'position', 'common_flags'].every(name => info.fields?.some(field => field.name === name && field.scope === 'b'))) {
      throw new BuilderError('Only concrete world classes can be placed; actor and region records use dedicated lifecycle interfaces');
    }
    const fields: NativeFields = template ? copy(template.fields ?? {}) : this.context.registry.defaults(info.classNumber, { scope: 'server' });
    fields.classNumber = info.classNumber;
    fields.position = [integer(x, -32768, 32767, 'X coordinate'), integer(y, -32768, 32767, 'Y coordinate'), fields.position?.[2] ?? 0];
    if (!template) {
      fields.name = info.name.slice(0, 31);
      if (own(fields, 'colorMap')) fields.colorMap = Array.from({ length: 16 }, (_, index) => index);
      if (own(fields, 'reducedCapacity')) fields.reducedCapacity = info.capacity;
    }
    const object = { id: draft.next.object++, classNumber: info.classNumber, regionId: profile.regionId,
      containerId: null, ownerId: profile.id, fields, capacity: template?.capacity ?? info.capacity ?? 0,
      portable: template?.portable ?? true, locked: template?.locked ?? false,
      properties: template ? copy(template.properties ?? {}) : {} };
    this.validateObject(object); draft.objects[object.id] = object;
    return object;
  }

  createRegion(draft: WorldState, name: string, address: string, areaCode: number, flags = 0, requestedNumber = 0): RegionRecord {
    name = text(name, 31, 'Region name', { empty: false, line: true });
    address = text(address, 31, 'Region address', { empty: false, line: true });
    areaCode = integer(areaCode, 0, 65535, 'Area code');
    flags = integer(flags, 0, 0xffffffff, 'Region flags');
    if (findRegion(draft, address, areaCode)) throw new BuilderError('That region address is already in use');
    let id = requestedNumber ? integer(requestedNumber, 1, 0x7fffffff, 'Region number') : draft.next.region;
    if (draft.regions[id]) throw new BuilderError('That region number is already in use');
    draft.next.region = Math.max(draft.next.region, id + 1);
    const objectId = draft.next.object++;
    const fields = { ...this.context.registry.defaults(20, { scope: 'server' }), name, areaCode,
      horizon: 70, max_avatars: 32, max_ghosts: 32, region_flags: flags };
    const object = { id: objectId, classNumber: 20, regionId: id, containerId: null,
      ownerId: null, fields, capacity: 0, portable: false, locked: false, properties: {} };
    this.validateObject(object);
    draft.objects[objectId] = object;
    const region = { id, name, objectId, exits: {}, properties: { address, areaCode, regionFlags: flags, regionNum: id } };
    draft.regions[id] = region;
    return region;
  }

  cloneRegion(draft: WorldState, source: RegionRecord, address: string, areaCode: number) {
    const region = this.createRegion(draft, source.name, address, areaCode, source.properties?.regionFlags ?? 0);
    draft.objects[region.objectId].fields = copy(draft.objects[source.objectId].fields);
    draft.objects[region.objectId].fields.name = region.name;
    draft.objects[region.objectId].fields.areaCode = areaCode;
    const inActorInventory = (object: GameObject): boolean => {
      for (let parent = object.containerId === null ? null : draft.objects[object.containerId]; parent; parent = parent.containerId === null ? null : draft.objects[parent.containerId]) {
        if ([21, 22].includes(parent.classNumber)) return true;
      }
      return false;
    };
    const eligible = Object.values(draft.objects).filter(object => object.regionId === source.id && ![20, 21, 22].includes(object.classNumber) && !inActorInventory(object));
    const replacements = new Map();
    for (const old of eligible) {
      const object = { ...copy(old), id: draft.next.object++, regionId: region.id };
      replacements.set(old.id, object.id); draft.objects[object.id] = object;
      if (draft.documents?.[old.id]) draft.documents[object.id] = { ...copy(draft.documents[old.id]), objectId: object.id };
    }
    for (const old of eligible) {
      const object = draft.objects[replacements.get(old.id)];
      object.containerId = replacements.get(old.containerId) ?? null;
      this.validateObject(object);
    }
    return region;
  }

  fieldValue(object: GameObject, fieldName: string, input: SchemaValue) {
    // Editable values are interpreted through the recovered class descriptor.
    // Identity and authority fields are excluded even for cosmetic editor tools.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName) || identityFields.has(fieldName)) throw new BuilderError('That field is protected');
    const spec = this.classInfo(object.classNumber).fields.find(field => field.name === fieldName && field.scope !== 'c');
    if (!spec) throw new BuilderError('Unknown writable field');
    const number = (value: SchemaValue) => integer(value, spec.min ?? (spec.type === 'i' ? -(2 ** (spec.width * 8 - 1)) : 0), spec.max ?? (spec.type === 'i' ? 2 ** (spec.width * 8 - 1) - 1 : 2 ** (spec.width * 8) - 1), fieldName);
    let value;
    if (spec.type === 'c' || spec.type === 's') value = text(input, typeof spec.count === 'number' ? spec.count - 1 : 16384, fieldName);
    else if (spec.count !== null && spec.count !== undefined) {
      const list = Array.isArray(input) ? input : String(input).trim().split(/\s+/).filter(Boolean);
      const size = typeof spec.count === 'number' ? spec.count : object.fields[spec.count];
      if (list.length !== size) throw new BuilderError(`${fieldName} requires ${size} values`);
      value = list.map(number);
    } else value = number(input);
    if (fieldName === 'capacity' || fieldName === 'reducedCapacity') {
      const maximum = this.classInfo(object.classNumber).capacity ?? 0;
      object.capacity = integer(value, 0, maximum, 'Capacity');
    }
    return value;
  }

  propertyRead(object: GameObject, name: string, publicly = false) {
    name = propertyName(name);
    if (publicly && !publicProperties.has(name)) throw new BuilderError('That property is not public', 16);
    const value = object.properties?.[name] ?? object.properties?.[name.replace(/^\./, '')] ?? '';
    return typeof value === 'string' ? value : name === '.popDests' && Array.isArray(value) ? value.join('|') : JSON.stringify(value);
  }

  assertOwner(profile: AvatarProfile, object: GameObject, draft: WorldState) {
    const housing = draft.regions[object.regionId]?.properties?.housing;
    if (['admin', 'builder'].includes(profile.role) || object.ownerId === profile.id
      || housing?.ownerId === profile.id || housing?.coOwnerIds?.includes(profile.id)) return;
    throw new BuilderError('You do not control that object', 16);
  }

  homeControl(profile: AvatarProfile, region: RegionRecord, { primary = false } = {}) {
    const housing = region.properties?.housing;
    if (!housing || housing.endedAt !== undefined) throw new BuilderError('This region has no active home lease');
    if (profile.role !== 'admin' && housing.ownerId !== profile.id && (primary || !housing.coOwnerIds?.includes(profile.id))) throw new BuilderError('This lease belongs to another avatar', 16);
    return housing;
  }

  manager(session: ActionSession, request: NativeActionRequest, draft: WorldState) {
    const manager = this.resolve(session, request.noid, draft);
    if (manager.classNumber !== 46) throw new BuilderError('This request requires a rental manager');
    return manager;
  }

  rentalPlan(manager: GameObject, number: number) {
    number = integer(number, 0, 7, 'Plan');
    const configured = manager.properties?.plans?.[number] ?? {};
    return { number, rent: integer(configured.rent ?? manager.fields.rent?.[number] ?? 0, 0, 0x7fffffff, 'Plan rent'),
      available: integer(configured.available ?? manager.fields.num_available?.[number] ?? 0, 0, 32767, 'Available homes'),
      periodMs: integer(configured.periodMs ?? 7 * 24 * 60 * 60 * 1000, 60000, 366 * 24 * 60 * 60 * 1000, 'Rental period'),
      info: configured.info ?? '', maxAdvance: integer(configured.maxAdvance ?? 12, 1, 120, 'Advance period limit') };
  }

  setPlanAvailability(manager: GameObject, plan: RentalPlan, available: number) {
    manager.fields.num_available ??= Array(8).fill(0); manager.fields.num_available[plan.number] = available;
    if (manager.properties?.plans?.[plan.number]) manager.properties.plans[plan.number].available = available;
  }

  heldTokens(draft: WorldState, profile: AvatarProfile) {
    return Object.values(draft.objects).find(object => object.classNumber === 26 && object.containerId === profile.objectId
      && Number(object.slot ?? object.fields.position?.[0] ?? 0) === 0);
  }

  consumeHeldTokens(draft: WorldState, profile: AvatarProfile, amount: number, kind: string) {
    if (!amount) return;
    const tokens = this.heldTokens(draft, profile);
    if (!tokens || tokens.ownerId !== profile.id || tokens.fields.denom !== amount) throw new BuilderError(`Hold exactly ${amount} tokens to complete this transaction`, 6);
    if (Object.values(draft.objects).some(object => object.containerId === tokens.id)) throw new BuilderError('Invalid token contents');
    delete draft.objects[tokens.id];
    for (const [id, timer] of Object.entries(draft.timers ?? {})) if (timer.objectId === tokens.id) delete draft.timers[id];
    draft.ledger.push({ id: draft.next.transaction++, at: this.context.now?.() ?? Date.now(), avatarId: profile.id,
      kind, amount, objectId: tokens.id });
  }

  homeByAddress(draft: WorldState, address: string, managerId: number) {
    const candidates = Object.values(draft.regions).filter(region => addressOf(region).toLowerCase() === String(address).toLowerCase()
      && region.properties?.housing?.managerId === managerId && region.properties.housing.endedAt === undefined);
    if (candidates.length !== 1) throw new BuilderError('Home address was not found or is ambiguous');
    return candidates[0];
  }

  rentQuote(housing: DynamicFields) {
    const now = this.context.now?.() ?? Date.now();
    if (!housing.rent) return { rent: 0, rent_due: 0, max_rent: 0 };
    const overdue = Math.max(1, Math.floor((now - housing.paidUntil) / housing.periodMs) + 1);
    const prepaid = Math.max(0, Math.floor((housing.paidUntil - now) / housing.periodMs));
    return { rent: housing.rent, rent_due: Math.min(0x7fffffff, overdue * housing.rent),
      max_rent: Math.min(0x7fffffff, Math.max(0, housing.maxAdvance - prepaid + Math.max(0, overdue - 1)) * housing.rent) };
  }

  apply(draft: WorldState, session: ActionSession, request: NativeActionRequest): BuilderResult {
    // Client permission bits are presentation hints. Every privileged operation
    // rechecks the role stored in this transaction's current avatar profile.
    const f = request.fields ?? {};
    const profile = this.profile(session, draft);
    const contract = contracts.get(request.id)!;
    if (contract.admin) this.assertBuilder(profile);
    const result: BuilderResult = { replyId: contract.replyId, reply: { success: 0, fail_msg: '', fail_URL: '' }, refresh: [], evict: [], created: null, updated: null };
    const target = () => this.resolve(session, f.target ?? f.item ?? request.noid, draft);
    const current = draft.regions[profile.regionId];
    if (!current) throw new BuilderError('Current region is unavailable', 16);
    switch (request.id) {
      case 131: case 141: case 143: {
        const housing = this.homeControl(profile, current);
        if (request.id === 131) {
          housing.guestAllowed = !!integer(f.guestAllowed, 0, 1, 'Guest permission');
          housing.kickOutOnExit = !!integer(f.kickOutOnExit, 0, 1, 'Exit policy');
        } else if (request.id === 141) housing.kickOutOnExit = !!integer(f.kickout, 0, 1, 'Exit policy');
        else housing.guestAllowed = !housing.guestAllowed;
        result.reply.fail_msg = housing.guestAllowed ? 'Guests are allowed in this home.' : 'Guests are not allowed in this home.';
        result.refresh.push(current.id); break;
      }
      case 137: case 139: {
        const housing = this.homeControl(profile, current);
        const owners = new Set([housing.ownerId, ...(housing.coOwnerIds ?? [])]);
        const online = new Set([...(this.context.sessions ?? [])].map(other => other.avatar?.id ?? other.avatarId));
        const guests = Object.values(draft.avatars).filter(avatar => avatar.regionId === current.id && !owners.has(avatar.id)
          && online.has(avatar.id)
          && (request.id === 137 || avatar.name.toLowerCase() === String(f.guest_name).toLowerCase()));
        if (request.id === 139 && !guests.length) throw new BuilderError('That guest is not present');
        if (guests.length && typeof this.context.teleport !== 'function') throw new BuilderError('Guest relocation is unavailable');
        result.evict.push(...guests.map(avatar => avatar.id)); break;
      }
      case 147: {
        const housing = current.properties?.housing;
        const owners = housing?.endedAt === undefined && housing ? [housing.ownerId, ...(housing.coOwnerIds ?? [])] : [];
        const visible = owners.filter(id => id !== profile.id).map(id => draft.avatars[id]?.name).filter(Boolean);
        Object.assign(result.reply, { numCoOwners: visible.length, coOwnerNames: visible.join('\n') }); break;
      }
      case 150: {
        const housing = this.homeControl(profile, current);
        Object.assign(result.reply, { guestAllowed: housing.guestAllowed ? 1 : 0, kickOutOnExit: housing.kickOutOnExit ? 1 : 0 }); break;
      }
      case 161: {
        const object = target(); result.reply.URL = this.propertyRead(object, 'URL', true); break;
      }
      case 165: {
        const object = target(); this.assertOwner(profile, object, draft);
        const url = text(f.newURL, 2048, 'URL', { line: true });
        if (url && !/^https?:\/\//i.test(url)) throw new BuilderError('Use an HTTP or HTTPS URL');
        object.properties ??= {}; object.properties.URL = url;
        object.fields.URLlabel = url ? text(f.newURLlabel || 'Open web page', 31, 'URL label', { line: true }) : '';
        this.validateObject(object); result.refresh.push(object.regionId); break;
      }
      case 186: {
        const object = target(); this.assertOwner(profile, object, draft);
        if (protectedClasses.has(object.classNumber)) throw new BuilderError('That record cannot be glued');
        const glued = integer(f.glued, 0, 1, 'Glued state');
        object.fields.common_flags = glued ? (object.fields.common_flags ?? 0) | 512 : (object.fields.common_flags ?? 0) & ~512;
        object.portable = !(object.fields.common_flags & (2 | 256 | 512)); result.refresh.push(object.regionId); break;
      }
      case 194: case 5306: {
        const object = target(); if (request.id === 194) this.assertOwner(profile, object, draft);
        object.properties ??= {}; object.properties.description = text(f.newTMA ?? f.TMAtext, 16384, 'Description');
        object.properties.TMA = object.properties.description; result.refresh.push(object.regionId); break;
      }
      case 5302: {
        const object = target(); if (protectedClasses.has(object.classNumber)) throw new BuilderError('Use the dedicated actor/region rename operation');
        object.fields.name = text(f.name, 31, 'Object name', { empty: false, line: true });
        this.validateObject(object); result.refresh.push(object.regionId); break;
      }
      case 5333: {
        const object = target(); object.fields.colorMap = this.fieldValue(object, 'colorMap', f.colorMap);
        this.validateObject(object); result.refresh.push(object.regionId); break;
      }
      case 200: case 5310: case 3051: {
        const count = request.id === 200 ? integer(f.count, 1, 100, 'Creation count') : 1;
        if (request.id === 3051 && f.target !== 65535) target();
        for (let index = 0; index < count; index++) result.created = this.createObject(draft, profile, f.classno, f.xloc, f.yloc);
        if (request.id === 3051) result.created!.fields.position[2] = integer(f.zloc, 0, 32767, 'Z coordinate');
        result.refresh.push(profile.regionId); break;
      }
      case 201: case 5314: {
        const source = target();
        if (Object.values(draft.objects).some(object => object.containerId === source.id)) throw new BuilderError('Empty the object before duplicating it');
        const count = integer(f.count, 1, 100, 'Duplicate count');
        for (let index = 0; index < count; index++) result.created = this.createObject(draft, profile, source.classNumber, source.fields.position?.[0] ?? 0, source.fields.position?.[1] ?? 0, source);
        result.refresh.push(source.regionId); break;
      }
      case 202: case 5318: case 3053: {
        const object = target();
        if (protectedClasses.has(object.classNumber)) throw new BuilderError('Region and actor records cannot be deleted with this command');
        if (Object.values(draft.regions).some(region => region.properties?.housing?.managerId === object.id && region.properties.housing.endedAt === undefined)) throw new BuilderError('End the active home leases before deleting their manager');
        if (Object.values(draft.objects).some(child => child.containerId === object.id)) throw new BuilderError('Empty the object before deleting it');
        delete draft.objects[object.id]; if (draft.documents) delete draft.documents[object.id];
        result.refresh.push(object.regionId); break;
      }
      case 203: {
        const object = target();
        const name = String(f.field);
        if (identityFields.has(name) || !this.classInfo(object.classNumber).fields.some(field => field.name === name && field.scope !== 'c')) throw new BuilderError('That field is unavailable');
        const value = object.fields[name]; result.reply.value = Array.isArray(value) ? value.join(' ') : String(value ?? ''); break;
      }
      case 205: {
        const object = target();
        if (!['s', 'b'].includes(f.where)) throw new BuilderError('Only server fields may be modified');
        object.fields[f.field] = this.fieldValue(object, f.field, f.value);
        if (f.field === 'common_flags') {
          object.portable = !(object.fields.common_flags & (2 | 256 | 512)); object.locked = !!(object.fields.common_flags & 16);
        }
        this.validateObject(object); result.updated = copy(object); result.refresh.push(object.regionId); break;
      }
      case 206: {
        const object = target();
        result.reply.fields = this.classInfo(object.classNumber).fields.filter(field => field.scope !== 'c' && !identityFields.has(field.name)).map(field => `{${field.name} s}`).join(' '); break;
      }
      case 208: case 211: {
        const object = target();
        const value = this.propertyRead(object, f.property ?? f.propname, request.id === 211);
        result.reply[request.id === 211 ? 'propdata' : 'value'] = value; break;
      }
      case 210: {
        const object = target(); const name = propertyName(f.property);
        object.properties ??= {}; object.properties[name] = text(f.value, 16384, 'Property value');
        result.refresh.push(object.regionId); break;
      }
      case 5322: {
        const object = target();
        const values = text(f.newData, 32768, 'Object data').replace(/\r/g, '').split('\n');
        if (values.length < 31) throw new BuilderError('Incomplete builder object data');
        const fields = object.fields;
        fields.name = text(values[0], 31, 'Name', { line: true });
        let flags = Number(fields.common_flags ?? 0) >>> 0;
        for (const [index, mask] of [[1, 512], [2, 4], [3, 2]]) flags = integer(values[index], 0, 1, 'Object flag') ? flags | mask : flags & ~mask;
        fields.common_flags = flags >>> 0; object.portable = !(flags & (2 | 256 | 512)); object.locked = !!(flags & 16);
        fields.imageURL = text(values[4], 31, 'Image filename', { line: true });
        if (fields.imageURL && this.context.resources && !this.context.resources.getFileInfo(fields.imageURL)) throw new BuilderError('That image is not in the admitted cache');
        fields.imageDefault = integer(values[5], 0, 65535, 'Default image');
        fields.choreState = integer(values[6], 0, 65535, 'Chore state');
        fields.salePrice = integer(values[7], 0, 65535, 'Sale price');
        fields.colorMap = values.slice(8, 24).map(value => integer(value, 0, 255, 'Color'));
        fields.URLlabel = text(values[24], 31, 'URL label');
        object.properties ??= {}; object.properties.URL = text(values[25], 2048, 'URL'); object.properties.help = text(values[26], 16384, 'Help');
        fields.orientation = integer(values[27], 0, 65535, 'Orientation');
        fields.position = values.slice(28, 31).map(value => integer(value, -32768, 32767, 'Position'));
        if (object.classNumber === 36 && values[31] !== undefined) {
          const capacity = integer(values[31], 0, this.classInfo(36).capacity, 'Capacity');
          const used = Object.values(draft.objects).filter(child => child.containerId === object.id).length;
          if (used > capacity) throw new BuilderError('Capacity cannot be lower than the current contents');
          object.capacity = capacity;
          if (this.classInfo(36).fields.some(field => field.name === 'capacity')) fields.capacity = capacity;
          else fields.reducedCapacity = capacity;
        }
        const extras = object.classNumber === 30 ? ['slot'] : object.classNumber === 55 ? ['canType', 'charges'] : object.classNumber === 31 ? ['action_type', 'action_menu', 'charges', 'run_sound', 'stop_sound'] : [];
        for (const [index, field] of extras.entries()) if (values[31 + index] !== undefined && this.classInfo(object.classNumber).fields.some(spec => spec.name === field)) fields[field] = this.fieldValue(object, field, values[31 + index]);
        this.validateObject(object); result.updated = copy(object); result.refresh.push(object.regionId); break;
      }
      case 220: this.createRegion(draft, f.name, f.address, f.areaCode, f.regionFlags, f.regionNum); break;
      case 221: this.cloneRegion(draft, current, f.address, integer(f.areaCode, 0, 65535, 'Area code')); break;
      case 222: {
        if (current.id === draft.startRegionId) throw new BuilderError('The start region cannot be deleted');
        current.properties.pendingDeletion = true; result.refresh.push(current.id); break;
      }
      case 223: {
        const group = currentGroup(draft, current.id);
        Object.assign(result.reply, { name: current.name, address: addressOf(current), areaCode: areaOf(current),
          regionFlags: current.properties?.regionFlags ?? 0, regionNum: current.properties?.regionNum ?? current.id,
          reggroupName: group?.name ?? '', reggroupAddress: group?.address ?? '', reggroupAreaCode: group?.areaCode ?? 0 }); break;
      }
      case 225: {
        const areaCode = integer(f.areaCode, 0, 65535, 'Area code');
        const address = text(f.address, 31, 'Region address', { empty: false, line: true });
        const duplicate = findRegion(draft, address, areaCode);
        if (duplicate && duplicate.id !== current.id) throw new BuilderError('Region address is already in use');
        current.name = text(f.name, 31, 'Region name', { empty: false, line: true });
        Object.assign(current.properties, { address, areaCode, regionFlags: integer(f.regionFlags, 0, 0xffffffff, 'Region flags') });
        Object.assign(draft.objects[current.objectId].fields, { name: current.name, areaCode, region_flags: current.properties.regionFlags });
        result.refresh.push(current.id); break;
      }
      case 226: {
        const list = Object.values(draft.regions).filter(region => areaOf(region) === Number(f.areaCode)).sort((a, b) => a.id - b.id);
        Object.assign(result.reply, { num_regions: list.length, region_names: list.map(region => tclWord(region.name)).join(' '),
          region_addresses: list.map(region => tclWord(addressOf(region))).join(' '), region_nums: list.map(region => region.id) }); break;
      }
      case 230: {
        const name = text(f.name, 31, 'Group name', { empty: false, line: true }), address = text(f.address, 31, 'Group address', { empty: false, line: true });
        const areaCode = integer(f.areaCode, 0, 65535, 'Area code'), count = integer(f.count, 1, 32, 'Region count');
        draft.regionGroups ??= {}; draft.next.regionGroup ??= 1;
        if (findGroup(draft, address, areaCode)) throw new BuilderError('Group address is already in use');
        const group: RegionGroupRecord = { id: draft.next.regionGroup++, name, address, areaCode, flags: integer(f.reggroupFlags, 0, 0xffffffff, 'Group flags'), entryRegionId: null, regionIds: [] };
        for (let index = 0; index < count; index++) {
          const suffix = String(index + 1); const region = this.createRegion(draft, `${name.slice(0, 29 - suffix.length)} ${suffix}`, address.slice(0, 31 - suffix.length) + suffix, areaCode);
          group.regionIds.push(region.id);
        }
        group.entryRegionId = group.regionIds[0]; draft.regionGroups[group.id] = group; break;
      }
      case 231: {
        const source = currentGroup(draft, current.id); if (!source) throw new BuilderError('Current region has no group');
        const address = text(f.address, 31, 'Group address', { empty: false, line: true }), areaCode = integer(f.areaCode, 0, 65535, 'Area code');
        if (findGroup(draft, address, areaCode)) throw new BuilderError('Group address is already in use');
        draft.next.regionGroup ??= 1;
        const group: RegionGroupRecord = { ...copy(source), id: draft.next.regionGroup++, address, areaCode, regionIds: [], entryRegionId: null };
        for (const [index, sourceId] of source.regionIds.entries()) {
          const suffix = String(index + 1), region = this.cloneRegion(draft, draft.regions[sourceId], address.slice(0, 31 - suffix.length) + suffix, areaCode);
          group.regionIds.push(region.id); if (sourceId === source.entryRegionId) group.entryRegionId = region.id;
        }
        draft.regionGroups[group.id] = group; break;
      }
      case 232: {
        const group = currentGroup(draft, current.id); if (!group) throw new BuilderError('Current region has no group');
        if (group.regionIds.includes(draft.startRegionId!)) throw new BuilderError('The start-region group cannot be deleted');
        group.pendingDeletion = true;
        for (const regionId of group.regionIds) draft.regions[regionId].properties.pendingDeletion = true;
        result.refresh.push(...group.regionIds); break;
      }
      case 233: {
        const group = currentGroup(draft, current.id); if (!group) throw new BuilderError('Current region has no group');
        const names = Buffer.alloc(1024), addresses = Buffer.alloc(1024), codes = Array(32).fill(0), numbers = Array(32).fill(0);
        for (const [index, regionId] of group.regionIds.slice(0, 32).entries()) {
          const region = draft.regions[regionId]; encodeClientString(region.name).copy(names, index * 32, 0, 31);
          encodeClientString(addressOf(region)).copy(addresses, index * 32, 0, 31); codes[index] = areaOf(region); numbers[index] = region.id;
        }
        Object.assign(result.reply, { name: group.name, address: group.address, areaCode: group.areaCode,
          entryRegNum: group.entryRegionId ?? 0, reggroupFlags: group.flags ?? 0, regionNames: names,
          regionAddresses: addresses, regionAreaCodes: codes, regionNums: numbers }); break;
      }
      case 235: {
        const group = currentGroup(draft, current.id); if (!group) throw new BuilderError('Current region has no group');
        const address = text(f.address, 31, 'Group address', { empty: false, line: true }), areaCode = integer(f.areaCode, 0, 65535, 'Area code');
        const duplicate = findGroup(draft, address, areaCode); if (duplicate && duplicate.id !== group.id) throw new BuilderError('Group address is already in use');
        const entryRegionId = integer(f.entryRegNum, 1, 0x7fffffff, 'Entry region');
        if (!group.regionIds.includes(entryRegionId)) throw new BuilderError('Entry region must belong to the group');
        Object.assign(group, { name: text(f.name, 31, 'Group name', { empty: false, line: true }), address, areaCode,
          entryRegionId, flags: integer(f.reggroupFlags, 0, 0xffffffff, 'Group flags') }); break;
      }
      case 236: case 237: {
        const group = findGroup(draft, f.reggroupAddr, f.reggroupAC), region = findRegion(draft, f.regionAddr, f.regionAC);
        if (!group || !region) throw new BuilderError('Region or group was not found');
        if (request.id === 236) {
          if (group.regionIds.length >= 32 && !group.regionIds.includes(region.id)) throw new BuilderError('Group is full');
          if (currentGroup(draft, region.id) && !group.regionIds.includes(region.id)) throw new BuilderError('Region already belongs to another group');
          if (!group.regionIds.includes(region.id)) group.regionIds.push(region.id);
          group.entryRegionId ??= region.id;
        } else {
          group.regionIds = group.regionIds.filter(id => id !== region.id);
          if (group.entryRegionId === region.id) group.entryRegionId = group.regionIds[0] ?? null;
        }
        break;
      }
      case 238: {
        const list = Object.values(draft.regionGroups ?? {}).filter(group => group.areaCode === Number(f.areaCode)).sort((a, b) => a.id - b.id);
        Object.assign(result.reply, { num_reggroups: list.length, reggroup_names: list.map(group => tclWord(group.name)).join(' '), reggroup_addresses: list.map(group => tclWord(group.address)).join(' ') }); break;
      }
      case 4001: {
        const manager = this.manager(session, request, draft), plan = this.rentalPlan(manager, f.plan);
        result.reply.plan_info = text(plan.info || `${plan.rent} tokens per rental period; ${plan.available} homes available.`, 4096, 'Plan information'); break;
      }
      case 4005: {
        // The lease, available-home count and exact held-cash payment are one
        // transaction; neither an orphan home nor an unfunded lease may escape.
        const manager = this.manager(session, request, draft), plan = this.rentalPlan(manager, f.plan);
        if (!plan.available) throw new BuilderError('No homes are available for that plan');
        const address = text(f.address, 31, 'Home address', { empty: false, line: true });
        if (Object.values(draft.regions).some(region => addressOf(region).toLowerCase() === address.toLowerCase())) throw new BuilderError('That address is already in use');
        this.consumeHeldTokens(draft, profile, plan.rent, 'housing-initial-rent');
        const areaCode = integer(draft.next.region + 1000, 0, 65535, 'Generated home area code');
        const region = this.createRegion(draft, address, address, areaCode);
        region.properties.housing = { ownerId: profile.id, coOwnerIds: [], guestAllowed: true, kickOutOnExit: false,
          managerId: manager.id, plan: plan.number, rent: plan.rent, periodMs: plan.periodMs, maxAdvance: plan.maxAdvance,
          paidUntil: (this.context.now?.() ?? Date.now()) + plan.periodMs };
        this.setPlanAvailability(manager, plan, plan.available - 1);
        if (integer(f.primary, 0, 1, 'Primary-home selection') || !profile.homeRegionId) {
          profile.homeRegionId = region.id; draft.objects[profile.objectId].fields.home_areaCode = areaCode;
        }
        result.reply.home_areaCode = draft.objects[profile.objectId].fields.home_areaCode ?? 0;
        result.reply.fail_msg = `Home ${address} rented.`; result.refresh.push(profile.regionId); break;
      }
      case 4016: {
        const manager = this.manager(session, request, draft), region = this.homeByAddress(draft, f.address, manager.id);
        const housing = this.homeControl(profile, region); Object.assign(result.reply, this.rentQuote(housing)); break;
      }
      case 4009: {
        const manager = this.manager(session, request, draft), region = this.homeByAddress(draft, f.address, manager.id);
        const housing = this.homeControl(profile, region), quote = this.rentQuote(housing), tokens = this.heldTokens(draft, profile);
        const amount = integer(tokens?.fields?.denom ?? 0, 1, 0x7fffffff, 'Held rent payment');
        if (!housing.rent || amount % housing.rent || amount < quote.rent_due || amount > quote.max_rent) throw new BuilderError('Held tokens do not match the server rent quote');
        this.consumeHeldTokens(draft, profile, amount, 'housing-rent');
        housing.paidUntil += amount / housing.rent * housing.periodMs;
        result.reply.fail_msg = `Rent paid on ${addressOf(region)}.`; result.refresh.push(profile.regionId); break;
      }
      case 4013: {
        const manager = this.manager(session, request, draft), region = this.homeByAddress(draft, f.address, manager.id);
        const housing = this.homeControl(profile, region, { primary: true });
        const remaining = Math.max(0, Math.floor((housing.paidUntil - (this.context.now?.() ?? Date.now())) / housing.periodMs));
        const penalty = integer(manager.properties?.breakPenaltyPeriods ?? 1, 0, 120, 'Lease-break penalty');
        const refund = integer(Math.max(0, remaining - penalty) * housing.rent, 0, 0x7fffffff, 'Lease refund');
        const actor = draft.objects[profile.objectId];
        if (refund) {
          if (Object.values(draft.objects).some(object => object.containerId === actor.id && Number(object.slot ?? object.fields.position?.[0] ?? 0) === 0)) throw new BuilderError('Empty your hand before receiving the lease refund');
          const fields = { ...this.context.registry.defaults(26), name: 'Tokens', denom: refund, position: [0, 0, 0], colorMap: Array.from({ length: 16 }, (_, index) => index) };
          const tokens = { id: draft.next.object++, classNumber: 26, regionId: profile.regionId, containerId: actor.id,
            ownerId: profile.id, capacity: 0, portable: true, locked: false, slot: 0, fields };
          this.validateObject(tokens); draft.objects[tokens.id] = tokens; result.updated = copy(tokens);
          draft.ledger.push({ id: draft.next.transaction++, at: this.context.now?.() ?? Date.now(), avatarId: profile.id,
            kind: 'housing-refund', amount: refund, objectId: tokens.id });
        }
        housing.endedAt = this.context.now?.() ?? Date.now(); region.properties.pendingDeletion = true;
        const plan = this.rentalPlan(manager, housing.plan), availability = Math.min(32767, plan.available + 1); this.setPlanAvailability(manager, plan, availability);
        for (const avatar of Object.values(draft.avatars)) if (avatar.homeRegionId === region.id) {
          avatar.homeRegionId = null; draft.objects[avatar.objectId].fields.home_areaCode = 0;
        }
        Object.assign(result.reply, { plan: housing.plan, home_areaCode: actor.fields.home_areaCode ?? 0,
          num_avail: availability, cvsize: 0, contentsVector: Buffer.alloc(0) });
        result.refresh.push(profile.regionId, region.id); break;
      }
      case 4020: {
        const manager = this.manager(session, request, draft);
        const url = manager.properties?.leaseURL ?? '';
        if (!/^https?:\/\//i.test(url)) throw new BuilderError('No lease-information URL is configured');
        result.reply.leaseURL = text(url, 2048, 'Lease URL', { line: true }); break;
      }
      case 4024: {
        const manager = this.manager(session, request, draft), region = this.homeByAddress(draft, f.address, manager.id);
        const housing = this.homeControl(profile, region, { primary: true });
        const added = Object.values(draft.avatars).find(avatar => avatar.name.toLowerCase() === String(f.newOwnerName).toLowerCase());
        if (!added) throw new BuilderError('Avatar was not found');
        if (added.id === housing.ownerId || housing.coOwnerIds.includes(added.id)) throw new BuilderError('Avatar is already on the lease');
        if (housing.coOwnerIds.length >= 7) throw new BuilderError('This lease already has eight owners');
        housing.coOwnerIds.push(added.id); result.refresh.push(region.id); break;
      }
      case 4028: {
        const manager = this.manager(session, request, draft), region = this.homeByAddress(draft, f.address, manager.id);
        this.homeControl(profile, region, { primary: true });
        const address = text(f.newAddress, 31, 'Home address', { empty: false, line: true });
        if (Object.values(draft.regions).some(candidate => candidate.id !== region.id && addressOf(candidate).toLowerCase() === address.toLowerCase())) throw new BuilderError('That address is already in use');
        region.properties.address = address; region.name = address; draft.objects[region.objectId].fields.name = address;
        result.refresh.push(region.id); break;
      }
      case 30001: {
        const object = target(); const binding = object.actionBinding ?? {}; const action = draft.actions?.[binding.id];
        Object.assign(result.reply, { id_action: action?.id ?? 0, next_action: binding.next ?? 0, action_name: action?.name ?? '' }); break;
      }
      case 30003: {
        const object = target(), id = integer(f.id_action, 0, 65535, 'Action ID'), next = integer(f.next_action, 0, 0xffffffff, 'Next action ID');
        if (id && !draft.actions?.[id]) throw new BuilderError('Action is not defined');
        object.actionBinding = id ? { id, next } : null; result.reply.fail_msg = draft.actions?.[id]?.name ?? ''; break;
      }
      case 30004: {
        const action = draft.actions?.[integer(f.id_action, 1, 65535, 'Action ID')]; if (!action) throw new BuilderError('Action is not defined');
        Object.assign(result.reply, { action_name: action.name, action_description: action.description, script: action.script }); break;
      }
      case 30006: {
        const id = integer(f.id_action, 1, 65535, 'Action ID'); draft.actions ??= {};
        draft.actions[id] = { id, name: text(f.action_name, 128, 'Action name', { empty: false, line: true }),
          description: text(f.action_description, 4096, 'Action description'), script: text(f.script, 65536, 'Stored script'),
          executable: false, updatedAt: this.context.now?.() ?? Date.now() };
        draft.next.action = Math.max(draft.next.action ?? 1, id + 1); break;
      }
      default: throw new BuilderError('Unsupported builder operation');
    }
    return result;
  }

  async handle(session: ActionSession, request: NativeActionRequest) {
    const contract = contracts.get(request.id); if (!contract) return false;
    let result;
    try {
      if (readOnly.has(request.id)) result = this.apply(this.context.worldStore.snapshot(), session, request);
      else result = this.context.worldStore.transaction(draft => this.apply(draft, session, request), {
        actorId: session.avatar?.id ?? session.avatarId, action: 'builder-request', details: { requestId: request.id, name: contract.name },
      });
      if (request.id === 5310) result.reply.new_noid = this.context.nativeNoid(session, result.created!);
      if (request.id === 205 || request.id === 4013 && result.updated) {
        const vector = this.context.contentsVector ? this.context.contentsVector(session, result.updated ? [result.updated] : []) : Buffer.alloc(4);
        result.reply.cvsize = vector.length; result.reply.contentsVector = vector;
      }
    } catch (error) {
      // Preserve useful native status/message information from both authoring
      // denials and persistence errors without assuming every throw is a BuilderError.
      const failure = error as { status?: number; message?: unknown };
      await this.context.reply(session, request.noid, contract.replyId, { success: failure.status ?? 5,
        fail_msg: String(failure.message ?? 'Builder request failed').slice(0, 255), fail_URL: '',
        value: '', propdata: '', fields: '', new_noid: 0, cvsize: 4, contentsVector: Buffer.alloc(4) });
      return true;
    }
    // Persistence errors become a denial before any success reply. Transport
    // failure after commit must propagate; it cannot undo an accepted edit.
    await this.context.reply(session, request.noid, result.replyId, result.reply);
    for (const regionId of new Set(result.refresh)) await this.context.refreshRegion(regionId);
    for (const avatarId of result.evict) {
      for (const other of this.context.sessions ?? []) if ((other.avatar?.id ?? other.avatarId) === avatarId && typeof this.context.teleport === 'function') {
        await this.context.teleport(other, this.context.worldStore.snapshot().startRegionId!);
      }
    }
    return true;
  }
}
