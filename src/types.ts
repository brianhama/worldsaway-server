/** Stable server identities and durable state, independent of native room noids. */
export type EntityId = number;
export type Role = 'player' | 'builder' | 'admin';
export type Position = number[];
export type EntityMap<T> = Record<string, T>;
export type Clock = () => number;

/**
 * The recovered CUTESI catalog and authored device programs define their fields
 * at runtime. These are the intentional dynamic boundaries: the codec/world
 * validator checks their values before bytes or JSON are committed. Identity,
 * ownership, balances and containment stay explicitly typed outside this map.
 */
export type DynamicFields = Record<string, any>;
export type NativeFields = DynamicFields;

export interface AccountRecord {
  id: EntityId;
  name: string;
  capacity: number;
  salt: string;
  hash: string;
}
export interface AvatarIdentity { id: EntityId; accountId: EntityId; name: string }
export interface AccountState {
  format: number;
  nextAccount: number;
  nextAvatar: number;
  accounts: AccountRecord[];
  avatars: AvatarIdentity[];
}
export interface LoginTicket { accountId: EntityId; avatarId: EntityId | null; expires: number }

/** Concrete core fields shared by all class-specific durable object records. */
export interface GameObject extends DynamicFields {
  id: EntityId;
  classNumber: number;
  regionId: EntityId;
  containerId: EntityId | null;
  ownerId: EntityId | null;
  capacity: number;
  portable: boolean;
  locked: boolean;
  fields: NativeFields;
  properties?: DynamicFields;
  slot?: number;
  archivedIn?: EntityId;
  archivedFlags?: number;
  deleted?: boolean;
  shared?: boolean;
  busRoutes?: number[];
  petState?: DynamicFields;
}
export interface RegionRecord {
  id: EntityId;
  name: string;
  objectId: EntityId;
  exits: Record<string, EntityId | null>;
  properties: DynamicFields;
}
export interface AvatarProfile extends AvatarIdentity, DynamicFields {
  objectId: EntityId;
  regionId: EntityId;
  balance: number;
  ghost: boolean;
  role: Role;
  preferences: DynamicFields;
  friends: EntityId[];
  ignored: EntityId[];
  mailbox: EntityId[];
  position?: Position;
}
export interface DocumentRecord extends DynamicFields {
  objectId: EntityId;
  title: string;
  text: string;
  updatedAt: number;
  entries?: EntityId[];
  pages?: string[];
}
export interface MailRecord extends DynamicFields {
  id: EntityId;
  fromId: EntityId;
  toId: EntityId;
  subject: string;
  body: string;
  createdAt: number;
  readAt: number | null;
}
export interface TimerRecord extends DynamicFields {
  id: EntityId;
  objectId: EntityId | null;
  kind: string;
  dueAt: number;
  payload: DynamicFields;
}
export interface RegionGroupRecord extends DynamicFields {
  id: EntityId;
  name: string;
  address: string;
  areaCode: number;
  regionIds: EntityId[];
  entryRegionId: EntityId | null;
  pendingDeletion?: boolean;
}
export interface BusRoute {
  id: number;
  name: string;
  vehicleObjectId: EntityId;
  stopObjectIds: EntityId[];
  intervalSeconds: number;
  enabled: boolean;
  stopIndex: number;
  nextAt: number;
  journeys: number;
  lastDepartedAt?: number;
  lastError?: string;
}
export interface AuditEntry {
  revision: number;
  at: number;
  action: string;
  actorId: EntityId | null;
  details: DynamicFields;
}
export interface LedgerEntry extends DynamicFields { id: number; kind: string; amount: number; at: number }
export interface WorldState {
  format: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  next: Record<'object' | 'region' | 'message' | 'transaction' | 'timer' | 'regionGroup' | 'action', number>;
  startRegionId: EntityId | null;
  regions: EntityMap<RegionRecord>;
  objects: EntityMap<GameObject>;
  avatars: EntityMap<AvatarProfile>;
  documents: EntityMap<DocumentRecord>;
  mail: EntityMap<MailRecord>;
  timers: EntityMap<TimerRecord>;
  regionGroups: EntityMap<RegionGroupRecord>;
  actions: EntityMap<DynamicFields>;
  ledger: LedgerEntry[];
  audit: AuditEntry[];
  busRoutes?: EntityMap<BusRoute>;
  contentMigrations?: EntityMap<DynamicFields>;
  accountBans?: EntityMap<number | DynamicFields>;
}

export interface OwnershipOptions { actorId?: EntityId | null; admin?: boolean; allowUnowned?: boolean }
export interface TransactionOptions {
  actorId?: EntityId | null;
  action?: string;
  details?: DynamicFields;
  authorize?: (state: WorldState) => boolean;
}
export interface ServerConfig {
  host: string;
  advertiseHost: string;
  httpPort: number;
  worldPort: number;
  rpcPort: number;
  advertiseWorldPort: number | null;
  advertiseRpcPort: number | null;
  publicUrl: string | null;
  worldName: string;
  clientDir: string;
  resourcePackDir: string | null;
  dataDir: string;
  surveyImportFile: string | null;
  demoAccount: string;
  demoPassword: string;
  demoAvatar: string;
  seedDemo: boolean;
  seedDistricts: boolean;
  allowRegistration: boolean;
  worldProfile: 'region' | 'empty';
  tokenTtlSeconds: number;
  keepaliveSeconds: number;
  sessionTimeoutSeconds: number;
  maxFrameBytes: number;
  maxFileBytes: number;
  maxHttpBodyBytes: number;
  maxBufferedBytes: number;
  log: (event: string, details: DynamicFields) => void;
  now?: Clock;
  random?: (maximum: number) => number;
}
