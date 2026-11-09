/**
 * Typed action boundary between native request decoding and durable evaluators.
 * Object IDs here are stable world IDs; only NativeActionRequest.noid is the
 * region-local identifier received on the wire. Schema-specific fields remain
 * dynamic because the recovered catalog supplies their layouts at runtime.
 */
import type { AccountRecord, AvatarIdentity, DynamicFields, GameObject, NativeFields, WorldState } from './types.js';
import type { WorldStore } from './world-store.js';
import type { ClassRegistry } from './classes.js';
import type { ResourceProvider } from './resources.js';

export interface ActionSession {
  avatar: AvatarIdentity;
  account?: AccountRecord;
  avatarId?: number;
  regionId?: number;
  actorNoid?: number;
  closed?: boolean;
  end?: () => void;
}
export interface NativeActionRequest {
  id: number;
  noid: number;
  payload?: Buffer;
  fields?: NativeFields;
  object?: GameObject | null;
}
export interface RequestContract {
  id: number;
  replyId: number;
  name: string;
  classNumbers?: readonly number[];
  classes?: readonly number[];
  admin?: boolean;
  replyByClass?: Readonly<Record<number, number>>;
}
export interface TransactionRequest {
  id: number;
  actorId: number;
  objectId: number;
  avatarId: number;
  avatarName?: string;
  fields?: NativeFields;
  refs?: Record<string, number | undefined>;
  admin: boolean;
  now: number;
  onlineAvatarIds?: number[];
  targetAccountId?: number | null;
  targetAccountName?: string;
  randomInt?: (minimum: number, maximum: number) => number;
  destinationId?: number;
  canEnterRegion?: (regionId: number) => boolean;
}
export interface TravelTransition {
  oldRegion: number;
  regionId: number;
  evictedAvatarIds?: number[];
  followerAvatarIds?: number[];
}
export interface ActionNotice { targetId: number | null; id: number; fields: NativeFields; includeSelf?: boolean }
export interface ActionResult {
  replyId: number;
  reply: NativeFields;
  notices: ActionNotice[];
  refresh: boolean;
  cvObjectIds?: number[];
  teleportRegionId?: number;
  travelTransition?: TravelTransition;
  summonAvatarId?: number;
  moveAvatarId?: number;
  moveAvatarRegionId?: number;
  kickAvatarIds?: number[];
  permissionAvatarId?: number;
  permissionLevel?: number;
  hidden?: { id: number; name: string; position: number[] }[];
}

/** Live services are injected so evaluators themselves perform no I/O. */
export interface ActionContext {
  worldStore: WorldStore;
  registry: ClassRegistry;
  resources: ResourceProvider;
  sessions?: Iterable<ActionSession> & { values?(): IterableIterator<ActionSession> };
  now?: () => number;
  clock?: () => number;
  random?: (maximum: number) => number;
  actorObject(session: ActionSession): GameObject | null;
  resolveObject(session: ActionSession, noid: number): GameObject | null;
  ref(object: GameObject | number): number | { $waObjectRef: number };
  objectNoid(session: ActionSession, object: GameObject | number | null): number;
  noidFor?(session: ActionSession, object: GameObject | number | null): number;
  nativeNoid(session: ActionSession, object: GameObject | number | null): number;
  reply(session: ActionSession, noid: number, id: number, fields: NativeFields): Promise<void>;
  broadcastObject(regionId: number, objectId: number | null, id: number, fields: NativeFields, except?: ActionSession): Promise<void>;
  broadcast(regionId: number, noid: number, id: number, fields: NativeFields, except?: ActionSession): Promise<void>;
  contentsVector(session: ActionSession, objects: GameObject[]): Buffer;
  refreshRegion(regionId: number): Promise<void>;
  refreshSession?(session: ActionSession): Promise<void>;
  teleport(session: ActionSession, regionId: number): Promise<void>;
  setActorMode(session: ActionSession, mode: 'ghost' | 'avatar', coords?: number[]): Promise<{ actorNoid: number; contentsVector: Buffer; afterReply?: () => Promise<void> }>;
  prepareTeleport(session: ActionSession, regionId: number, options?: { reason?: string; mode?: 'ghost' | 'avatar'; exitDir?: number }): Promise<{ regionId: number; afterReply: () => Promise<void> }>;
  moveActorInDraft(draft: WorldState, session: ActionSession, regionId: number, options?: { coords?: number[]; mode?: 'ghost' | 'avatar'; exitDir?: number }): TravelTransition;
  publishTravel(session: ActionSession, transition: TravelTransition): Promise<void>;
  canEnterRegion(session: ActionSession, regionId: number): boolean | { allowed: boolean } | Promise<boolean | { allowed: boolean }>;
  requireOwned?(session: ActionSession, object: GameObject): GameObject;
  updateObject?: WorldStore['updateObject'];
  isAdmin?(session: ActionSession): boolean;
  accountForName?(name: string): Pick<AccountRecord, 'id' | 'name'> | null;
}

/** Values read from a validated schema or authored declarative configuration. */
export type SchemaValue = DynamicFields[string];
