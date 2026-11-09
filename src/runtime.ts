import type { CompatibilityServer } from './server.js';
import type { ResourceProvider } from './resources.js';
import type { AccountRecord, AvatarIdentity, AvatarProfile, GameObject, NativeFields, WorldState } from './types.js';
import type { ActionContext, ActionSession, NativeActionRequest, TravelTransition } from './action-types.js';
import * as wire from './protocol.js';
import { ClassRegistry, SchemaError } from './classes.js';
import { WorldStore } from './world-store.js';
import { encodeContentsVector, buildRegionHereIs } from './world.js';
import { ObjectActions, SUPPORTED_REQUESTS as objectRequests, replyIdForObjectRequest } from './object-actions.js';
import { SocialActions, SUPPORTED_REQUESTS as socialRequests } from './social-actions.js';
import { BuilderActions, SUPPORTED_REQUESTS as builderRequests } from './builder-actions.js';
import { buildFeatureCoverage } from './coverage.js';
import { SpecialActions, SUPPORTED_REQUESTS as specialRequests, applySpecialTimer } from './special-actions.js';
import { randomInt } from 'node:crypto';
import { SystemActions, SUPPORTED_REQUESTS as systemRequests } from './system-actions.js';
import { ensureStarterContent } from './starter-content.js';
import { applyHousingExitPolicy, carriedObjectIds } from './presence-policy.js';
import { applyFollowingTravel, applyPetFollowing, busesDue, tickBusRoutes } from './automation.js';
import { ensureDistricts } from './districts.js';
import { ensureContentUpgrades } from './content-upgrades.js';
import { prepareSurveyArchive, importSurvey } from './survey-import.js';
import { avatarColorMap, DEFAULT_AVATAR_COLORS } from './avatar-defaults.js';

const copy = <T>(value: T): T => structuredClone(value);
const actorClasses = new Set([21, 22]);
const safeCoordinates = (value: unknown): value is number[] => Array.isArray(value) && value.length === 3 && value.every(n => Number.isInteger(n) && n >= -32768 && n <= 32767);

interface ViewEntry { classNumber: number; objectId: number; virtualGhost: boolean; data: Buffer }
interface RegionNoids { next: number; forward: Map<number, number>; reverse: Map<number, number> }
interface TravelOptions { coords?: number[]; mode?: 'ghost' | 'avatar'; reason?: string; exitDir?: number }

/** Native Y is depth measured upwards from the bottom of the scene. Compass
 * travel enters at the opposite edge and keeps the position along that edge. */
function regionEntryCoordinates(actor: GameObject, region: WorldState['regions'][string], exitDir: number): number[] {
  const extent = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 32767 ? Number(value) : 512;
  const width = extent(region.properties?.width), depth = extent(region.properties?.height);
  const inset = (size: number) => Math.min(48, Math.floor(size / 4));
  const xInset = inset(width), yInset = inset(depth);
  const previous = safeCoordinates(actor.fields.position) ? actor.fields.position : [256, 220, 0];
  const x = Math.max(xInset, Math.min(width - xInset, previous[0]));
  const y = Math.max(yInset, Math.min(depth - yInset, previous[1]));
  return [[x, yInset, 0], [xInset, y, 0], [x, depth - yInset, 0], [width - xInset, y, 0]][exitDir];
}

/** An authenticated world connection after its avatar has been selected. */
export interface RuntimeSession extends ActionSession {
  account: AccountRecord;
  avatar: AvatarIdentity;
  closed: boolean;
  regionId: number;
  actorObjectId?: number;
  actorNoid?: number;
  profile?: AvatarProfile;
  viewRegionId?: number;
  view?: Map<number, ViewEntry>;
  send(packet: Buffer): Promise<void>;
  end(): void;
}
interface ActionSets { social: SocialActions; objects: ObjectActions; builder: BuilderActions; special: SpecialActions; system: SystemActions }
const entered = (session: ActionSession): RuntimeSession => session as RuntimeSession;

/** Authoritative shared world. Resource Tcl is data; none of it is evaluated. */
export class GameRuntime {
  readonly server: CompatibilityServer;
  readonly resources: ResourceProvider;
  readonly registry: ClassRegistry;
  readonly worldStore: WorldStore;
  readonly sessions: Set<RuntimeSession>;
  readonly regionMaps: Map<number, RegionNoids>;
  readonly actionSets: WeakMap<RuntimeSession, ActionSets>;
  readonly coverage: ReturnType<typeof buildFeatureCoverage>;
  readonly replyContracts: Map<number, number>;
  queue: Promise<void>;
  closed: boolean;
  timer?: NodeJS.Timeout;

  constructor(server: CompatibilityServer) {
    this.server = server;
    this.resources = server.resources;
    this.registry = new ClassRegistry(this.resources);
    this.worldStore = new WorldStore(server.config.dataDir, { clock: server.config.now ?? (() => Date.now()), startRegionName: `${server.config.worldName} Lobby`.slice(0, 63) });
    this.sessions = new Set(); this.regionMaps = new Map(); this.actionSets = new WeakMap(); this.queue = Promise.resolve(); this.closed = false;
    const handlers = [
      ...objectRequests.map(x => ({ ...x, family: 'objects', classNumbers: x.classes })),
      ...socialRequests.map(x => ({ ...x, family: 'social' })),
      ...builderRequests.map(x => ({ ...x, family: 'builder' })),
      ...specialRequests.map(x => ({ ...x, family: 'special' })),
      ...systemRequests.map(x => ({ ...x, family: 'system' })),
    ];
    this.coverage = buildFeatureCoverage(this.resources, { handlers });
    this.replyContracts = new Map();
    for (const group of [...this.coverage.classes.map(x => ({ requests: x.contracts })), ...this.coverage.libraries]) {
      for (const candidate of group.requests ?? []) {
        if (candidate.commentedLine || candidate.replyId === null) continue;
        if (!this.replyContracts.has(candidate.requestId)) this.replyContracts.set(candidate.requestId, candidate.replyId);
      }
    }
    for (const contract of handlers) this.replyContracts.set(contract.id, contract.replyId);
    this.worldStore.finalizePendingRegions([]);
    ensureStarterContent(this.worldStore, this.registry, this.resources);
    ensureContentUpgrades(this.worldStore);
    if (server.config.seedDistricts) ensureDistricts(this.worldStore, this.registry, this.resources);
    if (server.config.surveyImportFile) {
      const { survey, archive } = prepareSurveyArchive(server.config.dataDir, server.config.surveyImportFile);
      const imported = importSurvey(this.worldStore, this.registry, survey, { archive, resources: this.resources });
      server.config.log('survey-import', { namespace: imported.namespace, sourceSha256: imported.sourceSha256,
        alreadyImported: imported.alreadyImported, regionsCreated: imported.regionsCreated, objectsCreated: imported.objectsCreated,
        objectsExcluded: imported.objectsExcluded, portalIds: imported.portalIds, backupFile: imported.backupFile ?? null,
        missingAssets: imported.assetAdmission.missingFiles?.map((file: { name: string }) => file.name) ?? [] });
    }
  }
  now() { return this.server.config.now?.() ?? Date.now(); }
  profile(session: RuntimeSession): AvatarProfile { return this.worldStore.getAvatar(session.avatar.id)!; }
  actorObject(session: RuntimeSession): GameObject | null { const profile = this.profile(session); return profile ? this.worldStore.getObject(profile.objectId) : null; }
  /** Stable object IDs never leave storage; each region assigns its own 16-bit wire noids. */
  regionMap(regionId: number): RegionNoids {
    let map = this.regionMaps.get(regionId);
    if (!map) { map = { next: 16, forward: new Map(), reverse: new Map() }; this.regionMaps.set(regionId, map); }
    for (const object of this.worldStore.listObjects({ regionId }).sort((a, b) => a.id - b.id)) {
      if (object.classNumber === 20 || map.forward.has(object.id)) continue;
      if (map.next > 65534) throw new Error('Native object-number capacity exhausted in region');
      const noid = map.next++;
      map.forward.set(object.id, noid); map.reverse.set(noid, object.id);
    }
    return map;
  }
  objectNoid(session: RuntimeSession, input: GameObject | number | null | undefined): number {
    if (typeof input === 'object' && input?.virtualGhost) return 15;
    const object = typeof input === 'object' ? input : this.worldStore.getObject(Number(input));
    if (!object || object.regionId !== session.regionId) return 65535;
    const region = this.worldStore.getRegion(session.regionId)!;
    if (object.id === region?.objectId) return 0;
    const profile = this.profile(session);
    if (object.id === profile?.objectId && object.classNumber === 22) return 15;
    return this.regionMap(session.regionId).forward.get(object.id) ?? 65535;
  }
  ghostObject(session: RuntimeSession): GameObject {
    const profile = this.profile(session), actor = this.actorObject(session);
    return { id: profile.objectId, virtualGhost: true, classNumber: 22, regionId: session.regionId,
      ownerId: profile.id, containerId: null, capacity: 0, portable: false, locked: false,
      fields: { name: profile.name, position: actor?.fields.position ?? [256, 220, 0], imageURL: 'o.ghost.img',
        imageVersion: 0, colorMap: [...Array(16).keys()], common_flags: profile.ghost ? 0 : 1 } };
  }
  resolveObject(session: RuntimeSession, noid: number): GameObject | null {
    if (!Number.isInteger(noid) || !session.regionId) return null;
    const region = this.worldStore.getRegion(session.regionId)!;
    if (noid === 0) return this.worldStore.getObject(region?.objectId);
    if (noid === 15) return this.profile(session)?.ghost ? this.actorObject(session) : this.ghostObject(session);
    const id = this.regionMap(session.regionId).reverse.get(noid);
    const object = id ? this.worldStore.getObject(id) : null;
    return object?.regionId === session.regionId && this.visible(session, object) ? object : null;
  }
  visible(session: RuntimeSession, object: GameObject): boolean {
    if (object.regionId !== session.regionId || object.archivedIn || object.deleted) return false;
    let current: GameObject | null = object;
    const seen = new Set();
    while (current) {
      if (current.archivedIn || current.deleted) return false;
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      if (actorClasses.has(current.classNumber) && current.ownerId !== null) {
        const ownerId = current.ownerId;
        const present = [...this.sessions].some(other => !other.closed && other.avatar?.id === ownerId && other.regionId === session.regionId);
        if (!present) return false;
        const profile = this.worldStore.getAvatar(current.ownerId);
        // Ghosts keep carried objects server-side; their wire class has no slots.
        if (current.id !== object.id && profile?.ghost) return false;
      }
      if (current.containerId === null) break;
      current = this.worldStore.getObject(current.containerId);
    }
    return true;
  }
  objectsFor(session: RuntimeSession): GameObject[] {
    const region = this.worldStore.getRegion(session.regionId)!;
    const objects = this.worldStore.listObjects({ regionId: session.regionId }).filter(object => this.visible(session, object));
    const depth = (object: GameObject) => { let value = 0; let parent: GameObject | null = object; while (parent.containerId !== null) { value++; parent = this.worldStore.getObject(parent.containerId); if (!parent) break; } return value; };
    objects.sort((a, b) => a.id === region.objectId ? -1 : b.id === region.objectId ? 1 : depth(a) - depth(b) || a.id - b.id);
    // A materialized actor still needs its hidden, reserved Ghost15 for the
    // native ghost/deghost transitions. It is a session-local view, not a second account.
    if (!this.profile(session).ghost) objects.push(this.ghostObject(session));
    return objects;
  }
  objectFields(session: RuntimeSession, object: GameObject): NativeFields {
    const fields = { ...this.registry.defaults(object.classNumber), ...copy(object.fields ?? {}) };
    fields.classNumber = object.classNumber;
    fields.noid = this.objectNoid(session, object);
    fields.container_noid = object.containerId === null ? 0 : this.objectNoid(session, object.containerId);
    if (Object.hasOwn(fields, 'reducedCapacity') && !Object.hasOwn(object.fields ?? {}, 'reducedCapacity')) fields.reducedCapacity = object.capacity;
    let flags = Number(fields.common_flags ?? 0) >>> 0;
    if (![20, 21, 22].includes(object.classNumber)) flags = object.portable ? flags & ~2 : flags | 2;
    flags = object.locked ? flags | 16 : flags & ~16;
    if (typeof object.open === 'boolean') flags = object.open ? flags & ~8 : flags | 8;
    fields.common_flags = flags >>> 0;
    for (const key of ['following', 'webfollowing', ...(object.classNumber === 201 ? ['owner'] : [])]) {
      if (key in fields) fields[key] = fields[key] === 65535 ? 65535 : fields[key] ? this.objectNoid(session, fields[key]) : key === 'following' ? 65535 : 0;
    }
    if (object.classNumber === 20) {
      const region = this.worldStore.getRegion(session.regionId)!;
      fields.validExits = ['north', 'east', 'south', 'west'].map(direction => region.exits?.[direction] ? 1 : 0);
      fields.max_avatars = object.fields?.max_avatars ?? 32; fields.max_ghosts = object.fields?.max_ghosts ?? 32;
    }
    return fields;
  }
  contentsVector(session: RuntimeSession, objects: GameObject[]): Buffer {
    return encodeContentsVector(objects.map(object => this.registry.encodeObject({ classNumber: object.classNumber, fields: this.objectFields(session, object) })));
  }
  async sendScene(session: RuntimeSession): Promise<void> {
    if (session.closed || !this.sessions.has(session)) return;
    const profile = this.profile(session), actor = this.actorObject(session)!;
    session.profile = profile; session.actorObjectId = actor!.id; session.actorNoid = this.objectNoid(session, actor);
    const success = Buffer.alloc(2); success.writeUInt16BE(1);
    await session.send(wire.frame(0, 145, success));
    const permissionLevel = profile.permissionLevel ?? (profile.role === 'admin' ? 3000 : profile.role === 'builder' ? 2000 : 10);
    const normalFlags = 0x00bffef0;
    const permissionFlags = (normalFlags | (profile.role === 'builder' ? 1 : profile.role === 'admin' ? 0x0100000f : 0)) >>> 0;
    const housing = this.worldStore.getRegion(session.regionId)?.properties?.housing;
    const owner = housing && (housing.ownerId === profile.id || housing.coOwnerIds?.includes(profile.id));
    const actorFlags = ((profile.preferences?.flags ?? profile.flags ?? 0) & 0xffff) | (owner ? 16 : 0);
    const objects = this.objectsFor(session).map(object => this.registry.encodeObject({ classNumber: object.classNumber, fields: this.objectFields(session, object) }));
    await session.send(wire.frame(0, 101, buildRegionHereIs({ actorNoid: session.actorNoid, actorFlags, permissionLevel, permissionFlags, objects })));
    this.recordView(session);
  }
  recordView(session: RuntimeSession): void {
    session.viewRegionId = session.regionId;
    session.view = new Map(this.objectsFor(session).map(object => [this.objectNoid(session, object), {
      classNumber: object.classNumber, objectId: object.id, virtualGhost: Boolean(object.virtualGhost),
      data: this.registry.encodeObject({ classNumber: object.classNumber, fields: this.objectFields(session, object) }),
    }]));
  }
  /** Publish committed changes relative to this connection's last complete view. */
  async sendDelta(session: RuntimeSession): Promise<void> {
    if (!session.view || session.viewRegionId !== session.regionId) return this.sendScene(session);
    const objects = this.objectsFor(session);
    const previous = session.view;
    const next = new Map(objects.map(object => [this.objectNoid(session, object), {
      classNumber: object.classNumber, objectId: object.id, virtualGhost: Boolean(object.virtualGhost),
      data: this.registry.encodeObject({ classNumber: object.classNumber, fields: this.objectFields(session, object) }),
    }]));
    const removed = [...session.view.entries()].filter(([noid]) => !next.has(noid));
    if (removed.some(([noid, object]) => noid === 0 || !this.registry.get(object.classNumber)?.methods.has(68))) return this.sendScene(session);
    for (const [noid] of removed) await this.reply(session, noid, 68, { dummy: 0 });
    const changed = [...next.entries()].filter(([noid, object]) => !previous.get(noid)?.data.equals(object.data)).map(([, object]) => object.data);
    if (changed.length) {
      const contentsVector = encodeContentsVector(changed);
      await this.reply(session, 0, 81, { cvsize: contentsVector.length, contentsVector });
    }
    session.view = next;
  }
  async attach(session: RuntimeSession): Promise<void> {
    const profile = this.worldStore.ensureAvatar(session.avatar);
    this.assertLogin(session);
    session.regionId = profile.regionId; session.profile = profile; session.actorObjectId = profile.objectId;
    this.sessions.add(session);
    this.actionsFor(session).social.register(session);
    if (!this.canEnterRegion(session, session.regionId)) {
      await this.teleport(session, this.worldStore.snapshot().startRegionId!); return;
    }
    await this.refreshRegion(session.regionId);
  }
  assertLogin(session: Pick<RuntimeSession, 'avatar' | 'account'>): void {
    const profile = this.worldStore.getAvatar(session.avatar.id);
    const state = this.worldStore.snapshot();
    const accountBan = state.accountBans?.[session.account.id];
    const until = typeof accountBan === 'number' ? accountBan : accountBan?.until;
    if ((profile?.preferences?.bannedUntil ?? 0) > this.now() || (until ?? 0) > this.now()) throw new wire.ProtocolError('This account or avatar is banned from this world');
  }
  canEnterRegion(session: RuntimeSession, regionId: number, { mode }: Pick<TravelOptions, 'mode'> = {}): boolean {
    return this.canEnterProfile(this.worldStore.snapshot(), this.profile(session), Number(regionId), { mode });
  }
  canEnterProfile(state: WorldState, profile: AvatarProfile, regionId: number, { mode }: Pick<TravelOptions, 'mode'> = {}): boolean {
    const region = state.regions[regionId];
    if (!region || region.properties?.pendingDeletion) return false;
    if (!profile) return false;
    const housing = region.properties?.housing;
    const owner = housing && (housing.ownerId === profile.id || housing.coOwnerIds?.includes(profile.id));
    if (profile.role === 'admin' || owner) return true;
    if (region.properties?.guestAllowed === false || (region.properties?.regionFlags & 2048) || housing?.guestAllowed === false) return false;
    const ghost = mode ? mode === 'ghost' : profile.ghost;
    const root = state.objects[region.objectId];
    const limit = root.fields?.[ghost ? 'max_ghosts' : 'max_avatars'] ?? 32;
    const online = new Set([...this.sessions].filter(other => !other.closed).map(other => other.avatar.id));
    const count = Object.values(state.avatars).filter(other => other.id !== profile.id && online.has(other.id)
      && other.regionId === region.id && Boolean(other.ghost) === Boolean(ghost)).length;
    return count < limit;
  }
  detach(session: RuntimeSession): void {
    if (!this.sessions.delete(session)) return;
    try { this.actionSets.get(session)?.social.onDisconnect(session); } catch (error) { this.server.config.log('presence-error', { message: (error instanceof Error ? error.message : String(error)) }); }
    const regionId = session.regionId;
    // Cleanup online-only relationships; persistent identities and inventory stay.
    if (!this.closed) this.queue = this.queue.then(async () => {
      const housing = this.worldStore.getRegion(regionId)?.properties?.housing;
      const evicted = housing?.kickOutOnExit ? this.worldStore.transaction(draft => applyHousingExitPolicy(draft, {
        departingAvatarId: session.avatar.id, fromRegionId: regionId,
        presentAvatarIds: [...this.sessions].filter(other => !other.closed).map(other => other.avatar.id),
      }), { actorId: session.avatar.id, action: 'housing-owner-disconnected', details: { regionId } }) : [];
      await this.publishTravel(null, { oldRegion: regionId, regionId, evictedAvatarIds: evicted });
    }).catch(error => this.server.config.log('world-refresh-error', { message: (error instanceof Error ? error.message : String(error)) }));
  }
  async refreshRegion(input: number | { regionId: number }): Promise<void> {
    const regionId = typeof input === 'object' ? input.regionId : input;
    for (const session of this.sessions) if (!session.closed && session.regionId === regionId) {
      try { await this.sendDelta(session); } catch { session.end(); }
    }
  }
  ref(input: GameObject | number): { $waObjectRef: number } { return { $waObjectRef: typeof input === 'object' ? input.id : Number(input) }; }
  references(session: RuntimeSession, input: unknown): unknown {
    if (Buffer.isBuffer(input)) return input;
    if (Array.isArray(input)) return input.map(value => this.references(session, value));
    if (input && typeof input === 'object') {
      if (Object.hasOwn(input, '$waObjectRef')) {
        const current = this.objectNoid(session, (input as { $waObjectRef: number }).$waObjectRef);
        if (current !== 65535) return current;
        // Destruction/travel replies can refer to an object removed from the
        // authoritative room but still present in this client's previous view.
        return [...(session.view?.entries() ?? [])].find(([, entry]) => entry.objectId === (input as { $waObjectRef: number }).$waObjectRef && !entry.virtualGhost)?.[0] ?? 65535;
      }
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, this.references(session, value)]));
    }
    return input;
  }
  async reply(session: RuntimeSession, noid: number, id: number, fields: NativeFields): Promise<void> {
    if (session.closed) return;
    await session.send(wire.frame(noid, id, this.registry.encodeMessage(id, this.references(session, fields) as NativeFields)));
  }
  async broadcastObject(regionId: number, objectId: number | null, id: number, fields: NativeFields, except?: ActionSession): Promise<void> {
    for (const recipient of this.sessions) {
      if (recipient.closed || recipient === except || recipient.regionId !== regionId) continue;
      const noid = objectId === null ? 0 : this.objectNoid(recipient, objectId);
      if (noid === 65535) continue;
      try { await this.reply(recipient, noid, id, fields); } catch { recipient.end(); }
    }
  }
  /** Move the actor, inventory, companions and housing effects in one durable commit. */
  moveActorInDraft(draft: WorldState, session: RuntimeSession, regionId: number, { coords, mode, exitDir }: TravelOptions = {}): TravelTransition {
    regionId = Number(regionId);
    if (!draft.regions[regionId]) throw new Error('Destination region does not exist');
    if (!this.canEnterProfile(draft, draft.avatars[session.avatar.id], regionId, { mode })) throw new Error('Access to that region is not permitted');
    const oldRegion = session.regionId;
    const current = draft.avatars[session.avatar.id], actor = draft.objects[current.objectId];
    if (exitDir !== undefined && (!Number.isInteger(exitDir) || exitDir < 0 || exitDir > 3)) throw new Error('Invalid exit direction');
    const physical = mode ? mode === 'avatar' : !current.ghost;
    coords ??= exitDir !== undefined && physical ? regionEntryCoordinates(actor, draft.regions[regionId], exitDir) : [256, 220, 0];
    if (mode) this.setActorModeInDraft(draft, session, mode, coords);
    current.regionId = regionId; actor.regionId = regionId; actor.containerId = null;
    if (!safeCoordinates(coords)) throw new Error('Invalid destination coordinates');
    actor.fields.position = [...coords]; current.position = [...actor.fields.position];
    actor.fields.choreState = 0;
    // Sprite facing follows native depth, rather than the compass enum's N/S.
    if (exitDir !== undefined && physical) actor.fields.orientation = [2, 1, 0, 3][exitDir];
    for (const id of carriedObjectIds(draft, actor.id)) draft.objects[id].regionId = regionId;
    const presentAvatarIds = [...this.sessions].filter(other => !other.closed).map(other => other.avatar.id);
    const followerAvatarIds = applyFollowingTravel(draft, {
      leaderAvatarId: session.avatar.id, fromRegionId: oldRegion, toRegionId: regionId, presentAvatarIds,
      canEnter: (profile, destination, state) => !(profile.preferences?.frozenUntil > this.now()) && this.canEnterProfile(state, profile, destination),
    });
    if (exitDir !== undefined) for (const id of followerAvatarIds) {
      const follower = draft.avatars[id];
      if (!follower.ghost) draft.objects[follower.objectId].fields.orientation = [2, 1, 0, 3][exitDir];
    }
    applyPetFollowing(draft, { avatarIds: [session.avatar.id, ...followerAvatarIds], fromRegionId: oldRegion });
    const evictedAvatarIds = applyHousingExitPolicy(draft, {
      departingAvatarId: session.avatar.id, fromRegionId: oldRegion, toRegionId: regionId,
      presentAvatarIds,
    });
    for (const followerId of followerAvatarIds) evictedAvatarIds.push(...applyHousingExitPolicy(draft, {
      departingAvatarId: followerId, fromRegionId: oldRegion, toRegionId: regionId, presentAvatarIds,
    }));
    return { oldRegion, regionId, evictedAvatarIds: [...new Set(evictedAvatarIds)], followerAvatarIds };
  }
  async publishTravel(session: RuntimeSession | null, transition: TravelTransition): Promise<void> {
    const { oldRegion, regionId, evictedAvatarIds = [], followerAvatarIds = [] } = transition;
    if (session) session.regionId = regionId;
    const affected = new Set([oldRegion, regionId]);
    const evicted = new Set([...evictedAvatarIds, ...followerAvatarIds]);
    for (const other of this.sessions) if (!other.closed && evicted.has(other.avatar.id)) {
      affected.add(other.regionId);
      other.regionId = this.profile(other).regionId;
      affected.add(other.regionId);
    }
    for (const id of affected) await this.refreshRegion(id);
    this.finalizeRegions();
  }
  async prepareTeleport(session: RuntimeSession, regionId: number, options: TravelOptions = {}) {
    const transition = this.worldStore.transaction(draft => this.moveActorInDraft(draft, session, regionId, options),
      { actorId: session.avatar.id, action: options.reason ?? 'region-travel', details: { from: session.regionId, to: Number(regionId) } });
    session.regionId = transition.regionId;
    return { regionId: transition.regionId, afterReply: () => this.publishTravel(session, transition) };
  }
  async teleport(session: RuntimeSession, regionId: number, options: TravelOptions = {}): Promise<void> {
    const prepared = await this.prepareTeleport(session, regionId, options);
    await prepared.afterReply();
  }
  finalizeRegions() {
    return this.worldStore.finalizePendingRegions([...this.sessions].filter(session => !session.closed).map(session => session.regionId));
  }
  setActorModeInDraft(draft: WorldState, session: RuntimeSession, mode: 'ghost' | 'avatar', coords?: number[]): void {
    if (!['ghost', 'avatar'].includes(mode)) throw new Error('Unknown actor mode');
    const imageNames = this.resources.listFileNames();
    const headImage = imageNames.find(name => /^h\./i.test(name) && !/headless|poop/i.test(name)) ?? '';
    const bodyImage = imageNames.includes('a.fjdefmale.img') ? 'a.fjdefmale.img' : '';
    const profile = this.profile(session);
    const current = draft.avatars[profile.id], actor = draft.objects[current.objectId];
    current.preferences ??= {};
    current.preferences.following = null;
    current.ghost = mode === 'ghost'; actor.classNumber = current.ghost ? 22 : 21;
    // Inventory persists while ghosted, but is hidden from the Ghost wire view.
    actor.capacity = 10;
    actor.fields = { ...actor.fields, name: current.name, imageURL: current.ghost ? 'o.ghost.img' : bodyImage,
      imageVersion: 0, bodyStyle: 0, following: 65535, colorMap: avatarColorMap(actor.fields.colorMap) };
    if (safeCoordinates(coords)) actor.fields.position = [...coords];
    current.position = [...actor.fields.position];
    if (!current.ghost && !Object.values(draft.objects).some(object => object.classNumber === 24 && object.containerId === actor.id)) {
      const id = draft.next.object++;
      draft.objects[id] = { id, classNumber: 24, regionId: current.regionId, ownerId: current.id, containerId: actor.id,
        capacity: 3, portable: true, locked: false, fields: { name: `${current.name} head`.slice(0, 31),
          position: [1, 0, 0], imageURL: headImage, imageVersion: 0, colorMap: [...DEFAULT_AVATAR_COLORS] }, slot: 1 };
    }
  }
  async setActorMode(session: RuntimeSession, mode: 'ghost' | 'avatar', coords?: number[]) {
    if (!this.canEnterRegion(session, session.regionId, { mode })) throw new Error('This region is not admitting that actor mode');
    const profile = this.profile(session);
    this.worldStore.transaction(draft => this.setActorModeInDraft(draft, session, mode, coords),
      { actorId: profile.id, action: 'actor-mode', details: { mode } });
    session.profile = this.profile(session); session.actorNoid = this.objectNoid(session, this.actorObject(session));
    const objects = this.objectsFor(session).filter(object => !object.virtualGhost && (object.id === profile.objectId || object.containerId === profile.objectId));
    return { actorNoid: session.actorNoid, contentsVector: this.contentsVector(session, objects), afterReply: async () => {
      // Preserve sender's synchronous native transition context. Other clients
      // get a coherent scene after the acknowledgement is delivered.
      this.recordView(session);
      for (const other of this.sessions) if (other !== session && other.regionId === session.regionId) await this.sendScene(other);
    } };
  }
  context(origin: RuntimeSession): ActionContext {
    const context: ActionContext = {
      worldStore: this.worldStore, registry: this.registry, resources: this.resources, sessions: this.sessions,
      now: () => this.now(), clock: () => this.now(), actorObject: session => this.actorObject(entered(session)),
      resolveObject: (session, noid) => this.resolveObject(entered(session), noid), ref: object => this.ref(object),
      objectNoid: (session, object) => this.objectNoid(entered(session), object),
      noidFor: (session, object) => this.objectNoid(entered(session), object), nativeNoid: (session, object) => this.objectNoid(entered(session), object),
      reply: (session, noid, id, fields) => this.reply(entered(session), noid, id, fields),
      broadcastObject: (...args) => this.broadcastObject(...args),
      broadcast: (regionId, noid, id, fields, except) => {
        const target = noid === 0 ? null : this.resolveObject(origin, noid)?.id;
        if (noid !== 0 && target === undefined) throw new Error('Broadcast target no longer exists');
        return this.broadcastObject(regionId, target ?? null, id, fields, except);
      },
      contentsVector: (session, objects) => this.contentsVector(entered(session), objects),
      refreshRegion: input => this.refreshRegion(input), teleport: (session, regionId) => this.teleport(entered(session), regionId),
      refreshSession: session => this.sendScene(entered(session)),
      setActorMode: (session, mode, coords) => this.setActorMode(entered(session), mode, coords),
      prepareTeleport: (session, regionId, options) => this.prepareTeleport(entered(session), regionId, options),
      moveActorInDraft: (draft, session, regionId, options) => this.moveActorInDraft(draft, entered(session), regionId, options),
      publishTravel: (session, transition) => this.publishTravel(entered(session), transition),
      isAdmin: session => this.profile(entered(session))?.role === 'admin',
      requireOwned: (session, object) => {
        if (object.ownerId !== session.avatar.id && !context.isAdmin?.(session)) throw new Error('Object is not owned by this avatar');
        return object;
      },
      updateObject: (id, patch, options) => this.worldStore.updateObject(id, patch, options),
      canEnterRegion: (session, regionId) => this.canEnterRegion(entered(session), regionId),
      random: this.server.config.random ?? (maximum => randomInt(maximum)),
      accountForName: name => {
        const account = this.server.store.account(name);
        if (account) return { id: account.id, name: account.name };
        const avatar = this.server.store.state.avatars.find(item => item.name.toLowerCase() === String(name).toLowerCase())
          ?? Object.values(this.worldStore.snapshot().avatars).find(item => item.name.toLowerCase() === String(name).toLowerCase());
        const owner = avatar && this.server.store.state.accounts.find(item => item.id === avatar.accountId);
        return owner ? { id: owner.id, name: owner.name } : null;
      },
    };
    return context;
  }
  actionsFor(session: RuntimeSession): ActionSets {
    let actions = this.actionSets.get(session);
    if (!actions) {
      const context = this.context(session);
      actions = { social: new SocialActions(context), objects: new ObjectActions(context), builder: new BuilderActions(context), special: new SpecialActions(context), system: new SystemActions(context) };
      this.actionSets.set(session, actions);
    }
    return actions;
  }
  async fail(session: RuntimeSession, request: NativeActionRequest, reason: string): Promise<void> {
    const object = request.object ?? this.resolveObject(session, request.noid);
    const replyId = replyIdForObjectRequest(request.id, object?.classNumber) ?? this.replyContracts.get(request.id) ?? 70;
    if (!this.registry.getMessage(replyId)) return;
    await this.reply(session, request.noid, replyId, { success: 1, fail_msg: reason, error: reason, text: reason,
      fail_URL: '', contentsVector: Buffer.alloc(0), cvsize: 0 });
  }
  /** Serialize player requests and timers so no reply can race a partially committed world. */
  handle(session: RuntimeSession, message: wire.NativeFrame): Promise<void> {
    const task = async () => {
      if (this.closed || session.closed) return;
      const definition = this.registry.getMessage(message.id);
      const object = this.resolveObject(session, message.noid);
      if (!object) { await this.fail(session, message, 'Object is not present in this region'); return; }
      try {
        this.assertLogin(session);
        if (!definition) throw new SchemaError('Unknown request schema');
        const profile = this.profile(session);
        if (message.id === 72 && (profile.preferences?.mutedUntil ?? 0) > this.now()) throw new Error('This avatar is muted');
        if (message.id === 1570 && (profile.preferences?.frozenUntil ?? 0) > this.now()) throw new Error('This avatar is frozen');
        const fields = this.registry.decodeMessage(message.id, message.payload);
        const request = { ...message, fields, object };
        for (const action of Object.values(this.actionsFor(session))) if (await action.handle(session, request)) return;
        this.server.config.log('unsupported-request', { noid: message.noid, id: message.id, classNumber: object.classNumber });
        await this.fail(session, message, 'This action is not implemented by this local world');
      } catch (error) {
        this.server.config.log('action-error', { id: message.id, name: error instanceof Error ? error.name : 'Error', message: (error instanceof Error ? error.message : String(error)) });
        await this.fail(session, message, error instanceof SchemaError ? 'Malformed request fields' : (error instanceof Error ? error.message : String(error)));
      }
    };
    this.queue = this.queue.then(task).catch(error => { this.server.config.log('runtime-error', { name: error instanceof Error ? error.name : 'Error', message: (error instanceof Error ? error.message : String(error)) }); session.end(); });
    return this.queue;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(error => this.server.config.log('timer-error', { message: (error instanceof Error ? error.message : String(error)) })), 1000);
    this.timer.unref();
  }
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.queue.catch(error => this.server.config.log('runtime-recovery', { name: error instanceof Error ? error.name : 'Error' })).then(task);
    this.queue = result.then(() => {}).catch(error => this.server.config.log('runtime-error', { name: error instanceof Error ? error.name : 'Error', message: (error instanceof Error ? error.message : String(error)) }));
    return result;
  }
  tick() {
    return this.run(async () => {
      if (this.closed) return;
      const affected = new Set<number>();
      const before = this.worldStore.snapshot();
      if (busesDue(before, this.now())) {
        const transport = this.worldStore.transaction(draft => {
          const result = tickBusRoutes(draft, { now: this.now(),
            canEnter: (profile, destination, state) => !(profile.preferences?.frozenUntil > this.now()) && this.canEnterProfile(state, profile, destination) });
          const presentAvatarIds = [...this.sessions].filter(session => !session.closed).map(session => session.avatar.id);
          for (const avatarId of [...result.movedAvatarIds]) {
            const from = before.avatars[avatarId]?.regionId, to = draft.avatars[avatarId].regionId;
            result.movedAvatarIds.push(...applyHousingExitPolicy(draft, { departingAvatarId: avatarId,
              fromRegionId: from, toRegionId: to, presentAvatarIds }));
          }
          return result;
        }, { action: 'bus-departures' });
        for (const regionId of transport.affectedRegionIds) affected.add(regionId);
        for (const session of this.sessions) if (!session.closed && transport.movedAvatarIds.includes(session.avatar.id)) {
          affected.add(session.regionId); session.regionId = this.profile(session).regionId; affected.add(session.regionId);
        }
      }
      const pets = applyPetFollowing(this.worldStore.snapshot());
      if (pets.movedObjectIds.length) {
        this.worldStore.transaction(draft => applyPetFollowing(draft), { action: 'pet-following' });
        for (const regionId of pets.affectedRegionIds) affected.add(regionId);
      }
      for (const timer of this.worldStore.dueTimers(this.now()).slice(0, 100)) {
        this.worldStore.transaction(draft => {
          const current = draft.timers[timer.id]; if (!current || current.dueAt > this.now()) return;
          if (applySpecialTimer(draft, current)) {
            const object = current.objectId === null ? undefined : draft.objects[current.objectId]; if (object) affected.add(object.regionId);
            delete draft.timers[current.id];
          } else {
            // Unknown saved jobs remain visible for repair; no saved code runs.
            current.lastError = 'Unsupported timer kind'; current.dueAt = Number.MAX_SAFE_INTEGER;
          }
        }, { action: 'timer-fired', details: { timerId: timer.id, kind: timer.kind } });
      }
      for (const regionId of affected) await this.refreshRegion(regionId);
    });
  }
  async close() {
    clearInterval(this.timer);
    try { await this.queue; this.closed = true; this.sessions.clear(); this.finalizeRegions(); }
    finally { this.closed = true; this.worldStore.close(); }
  }
}
