import type { AccountRecord, AccountState, AvatarIdentity, Clock, LoginTicket } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export class StoreError extends Error {}
export class StoreConflictError extends StoreError {}
const accountPattern = /^[A-Za-z0-9_.-]{1,24}$/;
const avatarPattern = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,28}$/;

function validateAccount(name: string, password: string, capacity: number) {
  if (typeof name !== 'string' || !accountPattern.test(name)) throw new StoreError('Account must use 1..24 ASCII letters, digits, dot, underscore or hyphen');
  if (typeof password !== 'string' || !/^[\x20-\x7e]{1,24}$/.test(password)) throw new StoreError('Password must use 1..24 printable ASCII characters');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) throw new StoreError('Avatar capacity must be 1..8');
}
function validateAvatar(name: string) {
  if (typeof name !== 'string' || !avatarPattern.test(name) || name.toLowerCase() === 'create new') throw new StoreError('Avatar must use 1..29 safe ASCII characters');
}
function passwordAccount(id: number, name: string, password: string, capacity: number): AccountRecord {
  const salt = randomBytes(16).toString('hex');
  return { id, name, capacity, salt, hash: scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex') };
}

/** Owns the directory lock and atomically replaces the identity database. */
export class AccountStore {
  readonly dataDir: string;
  readonly clock: Clock;
  readonly tickets: Map<string, LoginTicket>;
  readonly filename: string;
  readonly lockPath: string;
  lock: number | undefined;
  state: AccountState;
  closed: boolean;
  constructor(dataDir: string, { clock = () => Date.now() }: { clock?: Clock } = {}) {
    this.dataDir = dataDir; this.clock = clock; this.tickets = new Map(); this.closed = false;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filename = path.join(dataDir, 'accounts.json');
    this.lockPath = path.join(dataDir, 'server.lock');
    try { this.lock = fs.openSync(this.lockPath, 'wx', 0o600); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StoreError('This data directory is locked. Stop its server; remove server.lock only after confirming it is no longer running.');
      throw error;
    }
    try {
      fs.writeFileSync(this.lock, String(process.pid) + '\n');
      this.state = fs.existsSync(this.filename) ? JSON.parse(fs.readFileSync(this.filename, 'utf8'))
        : { format: 1, nextAccount: 1, nextAvatar: 1, accounts: [], avatars: [] };
      this.#validate();
    } catch (error: unknown) { this.close(); throw error; }
  }

  #validate() {
    const s = this.state;
    if (s.format !== 1 || !Array.isArray(s.accounts) || !Array.isArray(s.avatars) || !Number.isSafeInteger(s.nextAccount) || !Number.isSafeInteger(s.nextAvatar)) throw new StoreError('Unsupported or damaged account file');
    const ids = new Set<number>(), names = new Set<string>();
    for (const a of s.accounts) {
      if (!Number.isSafeInteger(a.id) || a.id < 1 || typeof a.name !== 'string' || !accountPattern.test(a.name) || !/^[a-f0-9]{32}$/.test(a.salt) || !/^[a-f0-9]{64}$/.test(a.hash) || !Number.isInteger(a.capacity) || a.capacity < 1 || a.capacity > 8 || ids.has(a.id) || names.has(a.name.toLowerCase())) throw new StoreError('Damaged account record');
      ids.add(a.id); names.add(a.name.toLowerCase());
    }
    const avatarIds = new Set<number>(), avatarNames = new Set<string>();
    for (const a of s.avatars) {
      if (!Number.isSafeInteger(a.id) || a.id < 1 || !ids.has(a.accountId) || typeof a.name !== 'string' || !avatarPattern.test(a.name) || a.name.toLowerCase() === 'create new' || avatarIds.has(a.id) || avatarNames.has(a.name.toLowerCase())) throw new StoreError('Damaged avatar record');
      avatarIds.add(a.id); avatarNames.add(a.name.toLowerCase());
    }
    if (s.nextAccount <= Math.max(0, ...ids) || s.nextAvatar <= Math.max(0, ...avatarIds)) throw new StoreError('Damaged identity counters');
    for (const a of s.accounts) if (this.listAvatars(a).length > a.capacity) throw new StoreError('Account exceeds native avatar capacity');
  }

  #save(nextState: AccountState) {
    if (this.closed) throw new StoreError('Account store is closed');
    const temp = this.filename + '.' + randomBytes(6).toString('hex') + '.tmp';
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(nextState, null, 2) + '\n'); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined; fs.renameSync(temp, this.filename);
      this.state = nextState;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  account(name: unknown): AccountRecord | null { return this.state.accounts.find(a => a.name.toLowerCase() === String(name).toLowerCase()) ?? null; }
  createAccount(name: string, password: string, { capacity = 3 }: { capacity?: number } = {}): AccountRecord {
    validateAccount(name, password, capacity);
    if (this.account(name)) throw new StoreConflictError('Account already exists');
    const account = passwordAccount(this.state.nextAccount, name, password, capacity);
    this.#save({ ...this.state, nextAccount: this.state.nextAccount + 1, accounts: [...this.state.accounts, account] });
    return account;
  }
  /**
   * Allocate both identities in the same replacement: duplicate avatar names or
   * failed disk writes cannot strand an account with no usable first avatar.
   */
  createAccountWithAvatar(name: string, password: string, avatarName: string): { account: AccountRecord; avatar: AvatarIdentity } {
    const capacity = 3;
    validateAccount(name, password, capacity); validateAvatar(avatarName);
    if (this.account(name)) throw new StoreConflictError('Account already exists');
    if (this.state.avatars.some(avatar => avatar.name.toLowerCase() === avatarName.toLowerCase())) throw new StoreConflictError('Avatar name already in use');
    const account = passwordAccount(this.state.nextAccount, name, password, capacity);
    const avatar = { id: this.state.nextAvatar, accountId: account.id, name: avatarName };
    this.#save({ ...this.state, nextAccount: this.state.nextAccount + 1, nextAvatar: this.state.nextAvatar + 1,
      accounts: [...this.state.accounts, account], avatars: [...this.state.avatars, avatar] });
    return { account, avatar };
  }
  authenticate(name: unknown, password: unknown): AccountRecord | null {
    if (typeof password !== 'string' || password.length > 24 || String(name).length > 24) return null;
    const account = this.account(name);
    const actual = scryptSync(password, account ? Buffer.from(account.salt, 'hex') : Buffer.alloc(16), 32);
    return account && timingSafeEqual(actual, Buffer.from(account.hash, 'hex')) ? account : null;
  }
  listAvatars(account: AccountRecord | number): AvatarIdentity[] { const id = typeof account === 'object' ? account.id : account; return this.state.avatars.filter(a => a.accountId === id); }
  findAvatar(account: AccountRecord | number, name: unknown): AvatarIdentity | null { return this.listAvatars(account).find(a => a.name.toLowerCase() === String(name).toLowerCase()) ?? null; }
  createAvatar(account: AccountRecord | number, name: string): AvatarIdentity {
    const id = typeof account === 'object' ? account.id : account;
    const owner = this.state.accounts.find(a => a.id === id);
    if (!owner) throw new StoreError('Account does not exist');
    validateAvatar(name);
    if (this.listAvatars(id).length >= owner.capacity) throw new StoreError('Avatar capacity reached');
    if (this.state.avatars.some(a => a.name.toLowerCase() === name.toLowerCase())) throw new StoreConflictError('Avatar name already in use');
    const avatar = { id: this.state.nextAvatar, accountId: id, name };
    this.#save({ ...this.state, nextAvatar: this.state.nextAvatar + 1, avatars: [...this.state.avatars, avatar] });
    return avatar;
  }
  /** Tickets are process-local, one-use grants; only their hashes are retained. */
  issueToken(account: AccountRecord, avatar: AvatarIdentity | null = null, ttlSeconds = 300): string {
    if (avatar && avatar.accountId !== account.id) throw new StoreError('Avatar does not belong to account');
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new StoreError('Ticket expiry must be positive');
    const token = randomBytes(12).toString('base64url').slice(0, 15);
    const now = this.clock();
    for (const [hash, t] of this.tickets) if (t.expires <= now) this.tickets.delete(hash);
    if (this.tickets.size > 4096) throw new StoreError('Too many pending login tickets');
    this.tickets.set(createHash('sha256').update(token).digest('hex'), { accountId: account.id, avatarId: avatar?.id ?? null, expires: now + ttlSeconds * 1000 });
    return token;
  }
  consumeToken(name: unknown, token: string): { account: AccountRecord; avatarId: number | null } | null {
    if (!/^[A-Za-z0-9_-]{15}$/.test(token)) return null;
    const account = this.account(name); if (!account) return null;
    const hash = createHash('sha256').update(token).digest('hex');
    const ticket = this.tickets.get(hash);
    if (!ticket || ticket.accountId !== account.id) return null;
    this.tickets.delete(hash);
    return ticket.expires > this.clock() ? { account, avatarId: ticket.avatarId } : null;
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.tickets.clear();
    if (this.lock !== undefined) { fs.closeSync(this.lock); this.lock = undefined; fs.unlinkSync(this.lockPath); }
  }
}
