import type { NativeFields, GameObject, AvatarProfile, RegionRecord, WorldState } from './types.js';
import type { ActionContext, ActionSession, NativeActionRequest } from './action-types.js';
/** Global/Region request contracts recovered from WA client Tcl. */
import { WorldStoreError } from './world-store.js';
import { encodeClientString } from './classes.js';
import { carriedObjectIds } from './presence-policy.js';

export const SUPPORTED_REQUESTS = Object.freeze([
  { id: 103, name: 'take region exit', replyId: 70, classNumbers: [20] },
  { id: 124, name: 'relocate named avatar', replyId: 70, classNumbers: [20] },
  { id: 133, name: 'set room guest policy', replyId: 70, classNumbers: [20] },
  { id: 135, name: 'set room population limit', replyId: 70, classNumbers: [20] },
  { id: 155, name: 'set room access controls', replyId: 156, classNumbers: [20] },
  { id: 190, name: 'move owned or builder object', replyId: 191, classNumbers: [20] },
  { id: 1207, name: 'configure teleporter connection', replyId: 70, classNumbers: [56] },
]);
const contracts = new Map(SUPPORTED_REQUESTS.map(item => [item.id, item]));
const directions = ['north', 'east', 'south', 'west'];
const GUESTS_BLOCKED = 2048;

interface SystemResult {
  reply: NativeFields;
  replyId?: number;
  regionId?: number;
  refresh?: boolean;
  notice?: { noid: number; id: number; fields: NativeFields };
  navigate?: { sessions: ActionSession[]; regionId: number; getReal: boolean; exitDir?: number };
}

export class SystemActionError extends Error {
  readonly success: number;
  constructor(message: string, success = 5) { super(message); this.success = success; }
}
function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new SystemActionError(`Invalid ${label}`);
  return value;
}
function text(value: unknown, maximum: number, label: string, { empty = true } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || /[\0\r\n]/.test(value)) throw new SystemActionError(`Invalid ${label}`);
  try { if (encodeClientString(value).length > maximum) throw new Error(); }
  catch { throw new SystemActionError(`${label} must fit ${maximum} Windows-1252 bytes`); }
  return value;
}
function coordinates(value: unknown): number[] {
  // DataView is a byte view without indexed numeric coordinates; typed numeric
  // arrays and normal arrays share the original native three-component shape.
  if ((!Array.isArray(value) && !(ArrayBuffer.isView(value) && 'length' in value)) || value.length !== 3) throw new SystemActionError('Expected three coordinates');
  return Array.from(value as ArrayLike<unknown>, component => integer(component, -32768, 32767, 'coordinate'));
}
function address(region: RegionRecord) { return String(region.properties?.address ?? region.id); }
function code(region: RegionRecord) { return Number(region.properties?.areaCode ?? 0); }
function ownerIds(region: RegionRecord) {
  const housing = region.properties?.housing;
  return new Set([housing?.ownerId, ...(housing?.coOwnerIds ?? []), region.properties?.ownerId,
    ...(region.properties?.coOwnerIds ?? [])].filter(Number.isSafeInteger));
}
function isStaff(profile: AvatarProfile) { return ['builder', 'admin'].includes(profile.role); }
function guestAllowed(region: RegionRecord, root: GameObject | undefined) {
  if (region.properties?.housing?.guestAllowed !== undefined) return region.properties.housing.guestAllowed;
  if (region.properties?.guestAllowed !== undefined) return region.properties.guestAllowed;
  return !(Number(root?.fields?.region_flags ?? region.properties?.regionFlags ?? 0) & GUESTS_BLOCKED);
}

/** Region controls and navigation share the same persisted admission rules. */
export class SystemActions {
  readonly context: ActionContext;
  constructor(context: ActionContext) { this.context = context; }
  #state() { return this.context.worldStore.snapshot(); }
  #profile(session: ActionSession, state: WorldState = this.#state()) {
    const profile = state.avatars[String(session.avatar?.id ?? session.avatarId)];
    if (!profile) throw new SystemActionError('Authenticated avatar required');
    return profile;
  }
  #region(profile: AvatarProfile, state: WorldState) {
    const region = state.regions[String(profile.regionId)];
    if (!region) throw new SystemActionError('Current region does not exist');
    return region;
  }
  #control(profile: AvatarProfile, region: RegionRecord) {
    if (!isStaff(profile) && !ownerIds(region).has(profile.id)) throw new SystemActionError('Room controls require its owner or a builder', 16);
  }
  #ref(object: GameObject) { return this.context.ref ? this.context.ref(object) : object.id; }
  #admit(profile: AvatarProfile, destination: RegionRecord, state: WorldState) {
    if (!destination || destination.properties?.pendingDeletion) throw new SystemActionError('Destination is unavailable', 3);
    const root = state.objects[String(destination.objectId)];
    const privileged = profile.role === 'admin' || ownerIds(destination).has(profile.id);
    if (!privileged && !guestAllowed(destination, root)) throw new SystemActionError('Guests are not allowed in that room', 16);
    const key = profile.ghost ? 'max_ghosts' : 'max_avatars';
    const limit = Number(root?.fields?.[key] ?? 32);
    const online = new Set([...(this.context.sessions ?? [])].filter(s => !s.closed).map(s => s.avatar?.id ?? s.avatarId));
    const population = Object.values(state.avatars).filter(a => a.id !== profile.id && a.regionId === destination.id && online.has(a.id) && !!a.ghost === !!profile.ghost).length;
    if (!privileged && population >= limit) throw new SystemActionError('That room is full', 15);
  }
  #resolveDestination(state: WorldState, value: unknown, areaCode: number, group = false) {
    const sought = text(value, 128, 'Destination address', { empty: false }).trim().toLowerCase();
    if (group) {
      const match = Object.values(state.regionGroups ?? {}).find(item => item.address.toLowerCase() === sought && Number(item.areaCode) === areaCode && !item.pendingDeletion);
      return match ? state.regions[String(match.entryRegionId ?? match.regionIds?.[0])] : null;
    }
    return Object.values(state.regions).find(region => !region.properties?.pendingDeletion && code(region) === areaCode &&
      ([String(region.id), region.name, address(region), ...(region.properties?.aliases ?? [])].some(candidate => String(candidate).toLowerCase() === sought))) ?? null;
  }
  async handle(session: ActionSession, request: NativeActionRequest) {
    const contract = contracts.get(request.id);
    if (!contract) return false;
    let result: SystemResult, acknowledged = false;
    try {
      const fields = request.fields ?? {}, state = this.#state(), profile = this.#profile(session, state);
      const current = this.#region(profile, state);
      if (request.id === 103 || request.id === 124) {
        result = this.#navigation(session, request, fields, state, profile, current);
      } else result = this.context.worldStore.transaction(draft => this.#apply(session, request, fields, draft),
        { actorId: profile.id, action: `system-${request.id}` });
      const publications = [];
      if (result.navigate) {
        for (const targetSession of result.navigate.sessions) {
          if (typeof this.context.prepareTeleport !== 'function') throw new SystemActionError('Durable region travel is unavailable');
          try {
            const prepared = await this.context.prepareTeleport(targetSession, result.navigate.regionId,
              { reason: `native-${request.id}`, ...(result.navigate.getReal ? { mode: 'avatar' } : {}),
                ...(result.navigate.exitDir !== undefined ? { exitDir: result.navigate.exitDir } : {}) });
            if (typeof prepared?.afterReply !== 'function') throw new Error('Region preparation did not return a publication callback');
            publications.push(prepared.afterReply);
          } catch (error) {
            if (error instanceof SystemActionError || error instanceof WorldStoreError) throw error;
            throw new SystemActionError('Region travel could not be committed; no scene was sent');
          }
        }
      }
      await this.context.reply(session, request.noid, result.replyId ?? contract.replyId, result.reply);
      acknowledged = true;
      if (result.notice) await this.context.broadcast(result.regionId!, result.notice.noid, result.notice.id, result.notice.fields, session);
      if (result.refresh) await this.context.refreshRegion(result.regionId!);
      for (const publish of publications) await publish();
    } catch (error) {
      // A failed publication after durable success is a transport/runtime error,
      // not a second contradictory response to the same native request.
      if (acknowledged) throw error;
      if (!(error instanceof SystemActionError) && !(error instanceof WorldStoreError)) throw error;
      const state = this.#state(), profile = this.#profile(session, state), region = this.#region(profile, state), root = state.objects[String(region.objectId)];
      await this.context.reply(session, request.noid, contract.replyId, {
        success: (error as Error & { success?: number }).success ?? 5, fail_msg: error.message, fail_URL: '',
        regionFlags: root.fields.region_flags ?? 0, maxAvatars: root.fields.max_avatars ?? 32, maxGhosts: root.fields.max_ghosts ?? 32,
        item: 65535, coords: [0, 0, 0], orientation: 0, msg: '',
      });
    }
    return true;
  }
  #navigation(session: ActionSession, request: NativeActionRequest, f: NativeFields, state: WorldState, profile: AvatarProfile, current: RegionRecord): SystemResult {
    // Online travel is prepared durably and published after acknowledgement;
    // offline relocation mutates the actor and all carried archives directly.
    let target: AvatarProfile | undefined = profile, destination, getReal = false, exitDir: number | undefined;
    if (request.id === 103) {
      if (request.noid !== 0) throw new SystemActionError('Region exit requests target the current room');
      exitDir = integer(f.exitDir, 0, 3, 'exit direction');
      const direction = directions[exitDir];
      destination = state.regions[String(current.exits?.[direction])];
      if (!destination) throw new SystemActionError('There is no exit in that direction', 3);
    } else {
      if (!isStaff(profile)) throw new SystemActionError('Address relocation requires a builder or administrator', 16);
      const name = text(f.avatar_name, 29, 'Avatar name', { empty: false }).trim().toLowerCase();
      target = Object.values(state.avatars).find(a => a.name.toLowerCase() === name);
      if (!target) throw new SystemActionError('Avatar not found', 3);
      if (target.id !== profile.id && profile.role !== 'admin') throw new SystemActionError('Only an administrator can relocate another avatar', 16);
      const group = integer(f.goto_reggroup ?? 0, 0, 1, 'Region-group choice');
      getReal = !!integer(f.get_real ?? 0, 0, 1, 'Materialization choice');
      destination = this.#resolveDestination(state, f.address, integer(f.areaCode ?? 0, 0, 65535, 'Area code'), group === 1);
      if (!destination) throw new SystemActionError('Destination address not found', 3);
    }
    this.#admit(getReal ? { ...target, ghost: false } : target, destination, state);
    const online = [...(this.context.sessions ?? [])].filter(s => !s.closed && (s.avatar?.id ?? s.avatarId) === target.id);
    if (!online.length) {
      if (getReal) throw new SystemActionError('The avatar must be online to materialize');
      this.context.worldStore.transaction(draft => {
        const moved = draft.avatars[String(target.id)], actor = draft.objects[String(moved.objectId)];
        moved.regionId = destination.id; actor.regionId = destination.id; actor.containerId = null;
        actor.fields.position = [256, 220, 0]; moved.position = [...actor.fields.position];
        for (const objectId of carriedObjectIds(draft, actor.id)) draft.objects[objectId].regionId = destination.id;
      }, { actorId: profile.id, action: 'offline-avatar-relocation' });
    }
    return { reply: { success: 0, fail_msg: '', fail_URL: '' }, navigate: { sessions: online, regionId: destination.id, getReal, exitDir } };
  }
  #apply(session: ActionSession, request: NativeActionRequest, f: NativeFields, draft: WorldState): SystemResult {
    const profile = this.#profile(session, draft), region = this.#region(profile, draft), root = draft.objects[String(region.objectId)];
    const out: SystemResult = { reply: { success: 0, fail_msg: '', fail_URL: '' }, regionId: region.id };
    if ([133, 135, 155].includes(request.id)) {
      if (request.noid !== 0) throw new SystemActionError('Room controls target the current room');
      this.#control(profile, region);
      let allowed = guestAllowed(region, root), avatars = Number(root.fields.max_avatars ?? 32), ghosts = Number(root.fields.max_ghosts ?? 32);
      if (request.id === 133) allowed = !!integer(f.allow, 0, 1, 'Guest permission');
      if (request.id === 135) {
        const which = integer(f.which, 0, 1, 'Population type'), count = integer(f.how_many, 0, 65535, 'Population limit');
        if (which === 0) avatars = count; else ghosts = count;
      }
      if (request.id === 155) {
        allowed = !!integer(f.guestAllowed, 0, 1, 'Guest permission');
        avatars = integer(f.maxAvatars, 0, 65535, 'Avatar limit'); ghosts = integer(f.maxGhosts, 0, 65535, 'Ghost limit');
      }
      let flags = Number(root.fields.region_flags ?? region.properties?.regionFlags ?? 0) >>> 0;
      flags = allowed ? flags & ~GUESTS_BLOCKED : flags | GUESTS_BLOCKED;
      region.properties ??= {}; region.properties.guestAllowed = allowed; region.properties.regionFlags = flags >>> 0;
      if (region.properties.housing) region.properties.housing.guestAllowed = allowed;
      Object.assign(root.fields, { region_flags: flags >>> 0, max_avatars: avatars, max_ghosts: ghosts });
      const fields = { regionFlags: flags >>> 0, maxAvatars: avatars, maxGhosts: ghosts };
      if (request.id === 155) Object.assign(out.reply, fields);
      out.notice = { noid: 0, id: 157, fields }; return out;
    }
    if (request.id === 190) {
      const target = this.context.resolveObject(session, f.item), object = target && draft.objects[String(target.id)];
      if (!object || object.regionId !== profile.regionId) throw new SystemActionError('Object is not in this room', 3);
      if (!isStaff(profile) && object.ownerId !== profile.id && !ownerIds(region).has(profile.id)) throw new SystemActionError('Object movement requires ownership or a builder', 16);
      if (object.classNumber === 20) throw new SystemActionError('The root Region cannot be repositioned');
      if ([21, 22].includes(object.classNumber) && object.ownerId !== profile.id && profile.role !== 'admin') throw new SystemActionError('Only an administrator can reposition another avatar', 16);
      if (object.containerId !== null) throw new SystemActionError('Move the item out of its container before positioning it');
      const coords = coordinates(f.coords), orientation = integer(f.orientation, 0, 3, 'Orientation');
      Object.assign(object.fields, { position: coords, orientation });
      const owner = Object.values(draft.avatars).find(a => a.objectId === object.id);
      if (owner) owner.position = [...coords];
      Object.assign(out.reply, { item: this.#ref(object), coords, orientation, msg: '' });
      out.notice = { noid: 0, id: 192, fields: { item: this.#ref(object), coords, orientation, msg: '' } };
      return out;
    }
    const target = request.object ?? this.context.resolveObject(session, request.noid), object = target && draft.objects[String(target.id)];
    if (!object || object.regionId !== profile.regionId || object.classNumber !== 56) throw new SystemActionError('Connection controls require a Teleport object');
    if (!isStaff(profile) && object.ownerId !== profile.id && !ownerIds(region).has(profile.id)) throw new SystemActionError('Connection configuration requires ownership or a builder', 16);
    const config = { address: text(f.address, 128, 'Connection address'),
      aliases0: text(f.aliases0, 255, 'Alias 0'), aliases1: text(f.aliases1, 255, 'Alias 1'), aliases2: text(f.aliases2, 255, 'Alias 2'),
      aliases3: text(f.aliases3, 255, 'Alias 3'), aliases4: text(f.aliases4, 255, 'Alias 4'),
      secret_address: integer(f.secret_address, 0, 1, 'Secret-address option'), areaCode: integer(f.areaCode, 0, 65535, 'Area code'),
      rideCost: integer(f.rideCost, 0, 65535, 'Ride cost'), entrySound: integer(f.entrySound, 0, 65535, 'Entry sound'),
      exitSound: integer(f.exitSound, 0, 65535, 'Exit sound'), operateOrientation: integer(f.operateOrientation, 0, 3, 'Operating orientation') };
    object.properties ??= {}; object.properties.connection = config;
    Object.assign(object.properties, config);
    Object.assign(object.fields, { rideCost: config.rideCost, entrySound: config.entrySound, exitSound: config.exitSound, operateOrientation: config.operateOrientation });
    const destination = config.address ? this.#resolveDestination(draft, config.address, config.areaCode) : null;
    if (destination) object.properties.destinationRegionId = destination.id;
    out.notice = { noid: request.noid, id: 1208, fields: { rideCost: config.rideCost, entrySound: config.entrySound,
      exitSound: config.exitSound, operateOrientation: config.operateOrientation } };
    return out;
  }
}
