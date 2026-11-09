/** HTTP/native transport adapters; gameplay authority lives in GameRuntime. */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket, Server as NetServer } from 'node:net';
import type { AccountRecord, AvatarIdentity, ServerConfig } from './types.js';
import type { ResourceProvider } from './resources.js';
import type { RuntimeSession } from './runtime.js';
import type { WorldStore } from './world-store.js';
import http from 'node:http';
import net from 'node:net';
import { makeConfig } from './config.js';
import { AccountStore, StoreError, StoreConflictError } from './store.js';
import { loadServerResources } from './resource-pack.js';
import { buildImageArchive } from './archives.js';
import { buildWorldEntry } from './world.js';
import * as wire from './protocol.js';
import { GameRuntime } from './runtime.js';
import { handleWorldApi, WorldApiError } from './api.js';

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function sendToSocket(socket: Socket, data: Buffer, timeoutMs = 15000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let finished = false; let timer: NodeJS.Timeout | undefined;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      socket.off('drain', drained); socket.off('close', closed); socket.off('error', failed);
      if (error) reject(error); else resolve();
    };
    const drained = () => finish();
    const closed = () => finish(new Error('Connection closed before output drained'));
    const failed = (error: Error) => finish(error);
    if (socket.destroyed) { closed(); return; }
    socket.once('drain', drained); socket.once('close', closed); socket.once('error', failed);
    try {
      if (socket.write(data)) finish();
      else if (!finished) {
        timer = setTimeout(() => { finish(new Error('Output drain timed out')); socket.destroy(); }, timeoutMs);
        timer.unref?.();
      }
    } catch (error) { finish(error); }
  });
}


export interface ServerOptions extends Partial<ServerConfig> { resources?: ResourceProvider }
type SocketSender = (data: Buffer) => void | Promise<void>;
export interface HttpRequestInput { method?: string; path?: string; headers?: IncomingHttpHeaders; body?: Buffer | string }
export interface HttpResponse { status: number; headers: Record<string, string>; body: Buffer }

/** Native session state progresses from ticket login to owned avatar to a live scene. */
export class WorldSession {
  readonly server: CompatibilityServer;
  readonly closeTransport: () => void;
  readonly decoder: wire.FrameDecoder;
  output: Promise<void>;
  send: (data: Buffer) => Promise<void>;
  closed: boolean;
  account: AccountRecord | null;
  avatar: AvatarIdentity | null;
  ticket?: { account: AccountRecord; avatarId: number | null };
  client?: ReturnType<typeof wire.parseLogin>;
  queue: Promise<void>;
  regionId!: number;
  actorNoid?: number;
  actorObjectId?: number;
  profile?: RuntimeSession['profile'];
  view?: RuntimeSession['view'];
  viewRegionId?: number;

  constructor(server: CompatibilityServer, send: SocketSender, close: () => void) {
    this.server = server; this.closeTransport = close; this.output = Promise.resolve();
    this.send = data => { const result = this.output.then(() => send(data)); this.output = result.catch(() => {}); return result; };
    this.decoder = new wire.FrameDecoder(server.config.maxFrameBytes, server.config.maxBufferedBytes);
    this.closed = false; this.account = null; this.avatar = null;
    this.queue = Promise.resolve(); server.sessions.add(this);
  }
  feed(chunk: Buffer): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      for (const message of this.decoder.feed(chunk)) {
        if (this.closed) break;
        await this.handle(message);
      }
    }).catch(async error => {
      if (!this.closed && error instanceof wire.ProtocolError) {
        try { await this.send(wire.loginError((error instanceof Error ? error.message : String(error)))); } catch {}
      } else if (!(error instanceof wire.ProtocolError)) this.server.config.log('world-error', { name: error instanceof Error ? error.name : 'Error' });
      this.end();
    });
    return this.queue;
  }
  async handle({ noid, id, payload }: wire.NativeFrame): Promise<void> {
    const s = this.server;
    if (!this.account) {
      if (noid !== 10 || id !== 11) throw new wire.ProtocolError('Login required');
      let login;
      try { login = wire.parseLogin(payload); }
      catch (error) {
        s.config.log('login-error', { bytes: payload.length, reason: (error instanceof Error ? error.message : String(error)) });
        throw error;
      }
      const ticket = s.store.consumeToken(login.account, login.token);
      if (!ticket) throw new wire.ProtocolError('Login ticket is invalid, expired or already used');
      this.account = ticket.account; this.ticket = ticket; this.client = login;
      const avatars = s.store.listAvatars(this.account);
      await this.send(wire.configuration(s.config.keepaliveSeconds));
      await this.send(wire.avatarList(avatars, this.account.capacity, s.busy));
      return;
    }
    if (noid === 10 && id === 20) { this.end(); return; }
    if (noid === 10 && id === 19) return;
    if (noid === 10 && id === 13) {
      if (this.avatar) throw new wire.ProtocolError('Avatar already entered');
      const selected = wire.parseAvatarEntry(payload);
      const avatar = s.store.findAvatar(this.account, selected.name);
      if (!avatar || (this.ticket!.avatarId !== null && this.ticket!.avatarId !== avatar.id)) throw new wire.ProtocolError('Avatar does not match account or ticket');
      if (s.busy.has(avatar.id)) throw new wire.ProtocolError('Avatar is already connected');
      this.avatar = avatar; s.runtime?.assertLogin(this as RuntimeSession); s.busy.add(avatar.id);
      for (const packet of wire.resourcePackets(s.resources.bootstrapResources())) {
        if (this.closed) return;
        await this.send(packet);
      }
      const runtime = s.runtime;
      if (runtime) await runtime.run(() => runtime.attach(this as RuntimeSession)); else await this.enterRegion();
      s.config.log('entered', { avatar: avatar.name, mode: s.config.worldProfile });
      return;
    }
    if (!this.avatar) throw new wire.ProtocolError('Select an owned avatar first');
    if (noid === 0 && id === 113) {
      if (payload.length !== 4) throw new wire.ProtocolError('Invalid teleport body');
      const runtime = s.runtime;
      if (runtime) await runtime.run(async () => {
        runtime.assertLogin(this as RuntimeSession);
        if ((runtime.profile(this as RuntimeSession).preferences?.frozenUntil ?? 0) > runtime.now()) throw new wire.ProtocolError('This avatar is frozen');
        await runtime.teleport(this as RuntimeSession, payload.readUInt32BE(0));
      }); else await this.enterRegion();
      return;
    }
    if (s.runtime) await s.runtime.handle(this as RuntimeSession, { noid, id, payload });
    else s.config.log('unimplemented-message', { noid, id, bytes: payload.length });
  }
  async enterRegion() {
    for (const packet of buildWorldEntry({ worldName: this.server.config.worldName,
      avatarName: this.avatar!.name, profile: this.server.config.worldProfile })) {
      if (this.closed) return;
      await this.send(wire.frame(packet.noid, packet.id, packet.payload));
    }
  }
  end() {
    if (this.closed) return;
    this.closed = true;
    this.server.runtime?.detach(this as RuntimeSession);
    if (this.avatar) this.server.busy.delete(this.avatar.id);
    this.server.sessions.delete(this);
    this.closeTransport();
  }
}

/** One bounded filename batch; the same adapter works on the dedicated or multiplexed port. */
export class RpcSession {
  readonly server: CompatibilityServer;
  readonly send: SocketSender;
  readonly closeTransport: () => void;
  buffer: Buffer;
  closed: boolean;
  processing: boolean;
  queue: Promise<void>;

  constructor(server: CompatibilityServer, send: SocketSender, close: () => void) {
    this.server = server; this.send = send; this.closeTransport = close;
    this.buffer = Buffer.alloc(0); this.closed = false; this.processing = false;
    this.queue = Promise.resolve(); server.sessions.add(this);
  }
  feed(chunk: Buffer): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.closed || this.processing) return;
      if (this.buffer.length + chunk.length > 136) throw new wire.ProtocolError('RPC request too large');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length < 8) return;
      const opcode = this.buffer.readUInt32BE(0), count = this.buffer.readUInt32BE(4);
      if (!((opcode === 0x31 && count >= 1 && count <= 2) || (opcode === 0x30 && count === 1))) throw new wire.ProtocolError('Unsupported RPC operation or batch count');
      const bytes = 8 + count * 64;
      if (this.buffer.length < bytes) return;
      if (this.buffer.length !== bytes) throw new wire.ProtocolError('Unexpected RPC trailing data');
      const names = Array.from({ length: count }, (_, index) => wire.readCString(this.buffer.subarray(8 + index * 64, 72 + index * 64)));
      this.processing = true;
      for (const name of names) {
        let info = null;
        try { info = this.server.resources.getFileInfo(name); } catch {}
        if (this.closed) return;
        await this.send(wire.fileReply(name, info?.data ?? null, info?.version ?? 0));
      }
      this.end();
    }).catch(error => {
      if (!(error instanceof wire.ProtocolError)) this.server.config.log('rpc-error', { name: error instanceof Error ? error.name : 'Error' });
      this.end();
    });
    return this.queue;
  }
  end() {
    if (this.closed) return;
    this.closed = true; this.server.sessions.delete(this); this.closeTransport();
  }
}

export class CompatibilityServer {
  readonly config: ServerConfig;
  readonly resources: ResourceProvider;
  readonly store: AccountStore;
  readonly runtime: GameRuntime | null;
  readonly worldStore: WorldStore | null;
  readonly addresses: Pick<ServerConfig, 'httpPort' | 'worldPort' | 'rpcPort'>;
  readonly sessions: Set<WorldSession | RpcSession>;
  readonly busy: Set<number>;
  readonly sockets: Set<Socket>;
  listeners: NetServer[];
  closed: boolean;
  started: boolean;
  imageArchive: Buffer | null;

  constructor(options: ServerOptions = {}) {
    this.config = makeConfig(options);
    this.config.worldProfile ??= 'region';
    if (!['region', 'empty'].includes(this.config.worldProfile)) throw new Error('worldProfile must be region or empty');
    // Validate public cache inputs before creating account state or taking a lock.
    this.resources = options.resources ?? loadServerResources(this.config);
    this.store = new AccountStore(this.config.dataDir, { clock: options.now ?? (() => Date.now()) });
    try {
      if (this.config.seedDemo && !this.store.account(this.config.demoAccount)) {
        const account = this.store.createAccount(this.config.demoAccount, this.config.demoPassword);
        this.store.createAvatar(account, this.config.demoAvatar);
      }
      this.runtime = this.config.worldProfile === 'region' && this.resources.getResource?.(0x10014) ? new GameRuntime(this) : null;
      this.worldStore = this.runtime?.worldStore ?? null;
    } catch (error) { this.store.close(); throw error; }
    this.addresses = { httpPort: this.config.httpPort, worldPort: this.config.worldPort, rpcPort: this.config.rpcPort };
    this.sessions = new Set(); this.busy = new Set(); this.sockets = new Set();
    this.listeners = []; this.closed = false; this.started = false; this.imageArchive = null;
  }
  get baseUrl() { return this.config.publicUrl ?? `http://${this.config.advertiseHost}:${this.addresses.httpPort}`; }
  createWorldSession(send: SocketSender, close: () => void = () => {}): WorldSession {
    if (this.closed) throw new Error('Server closed');
    return new WorldSession(this, send, close);
  }
  createRpcSession(send: SocketSender, close: () => void = () => {}): RpcSession {
    if (this.closed) throw new Error('Server closed');
    return new RpcSession(this, send, close);
  }
  /** Tickets are single-use; native ports may share one public multiplexing proxy. */
  connectionFile(account: AccountRecord, avatar: AvatarIdentity | null): Buffer {
    const token = this.store.issueToken(account, avatar, this.config.tokenTtlSeconds);
    const fields = { worldname: this.config.worldName, serveraddr: this.config.advertiseHost,
      loginport: this.config.advertiseWorldPort ?? this.addresses.worldPort,
      rpcport: this.config.advertiseRpcPort ?? this.addresses.rpcPort, username: account.name,
      acctname: account.name, avatarname: avatar?.name ?? '', loginregion: 1, onetimepass: token };
    const body = Buffer.from('[Message]\r\nmessagetype=Connect\r\n[Connect Info]\r\n'
      + Object.entries(fields).map(([key, value]) => `${key}=${value}\r\n`).join(''), 'ascii');
    if (body.length >= 999 || body.includes(0x25)) throw new Error('Native handoff constraints exceeded');
    return body;
  }
  async handleHttpRequest({ method = 'GET', path = '/', headers = {}, body = Buffer.alloc(0) }: HttpRequestInput = {}): Promise<HttpResponse> {
    const response = (status: number, value: string | Buffer, contentType = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): HttpResponse => ({ status,
      headers: { 'content-type': contentType, 'cache-control': 'no-store', 'connection': 'close', 'x-content-type-options': 'nosniff', ...extra },
      body: Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8') });
    try {
      if (this.closed) throw new HttpError(503, 'Server stopped');
      if (!['GET', 'POST'].includes(method)) throw new HttpError(405, 'Use GET or POST');
      if (!Buffer.isBuffer(body)) body = Buffer.from(body);
      if (body.length > this.config.maxHttpBodyBytes) throw new HttpError(413, 'Request body too large');
      // The original launcher can concatenate a trailing Webhost slash with
      // "/worlds3.php". Normalize before URL parsing so // is not a new host.
      if (typeof path !== 'string' || !path.startsWith('/') || path.length > 16384) throw new HttpError(400, 'Invalid request target');
      const url = new URL(path.replace(/^\/+/, '/'), 'http://localhost');
      const pathname = url.pathname.replace(/\/{2,}/g, '/');
      if (['/health', '/healthz'].includes(pathname)) {
        const world = this.worldStore?.snapshot();
        const surveyImports = Object.values(world?.contentMigrations ?? {}).filter(item => typeof item.id === 'string' && item.id.startsWith('altaway-avagoria-survey-'))
          .map(item => ({ namespace: item.id, regions: Object.keys(item.regionIds ?? {}).length,
            objects: Object.keys(item.objectIds ?? {}).length, portalIds: item.portalIds,
            sourceSha256: item.archives?.at(-1)?.sha256 ?? null, sourceCoverageStatus: item.sourceCoverageStatus }));
        return response(200, JSON.stringify({ status: 'ok', application: 'WorldsAway.app',
        version: '1.0.0', world: this.config.worldName, mode: this.config.worldProfile,
        registration: { enabled: this.config.allowRegistration },
        ...this.addresses, resourceProfile: this.resources.resourceProfile, resources: {
          magResources: this.resources.summary.magResources, fileAssets: this.resources.summary.fileAssets,
          sceneOverrideClasses: this.resources.summary.sceneOverrides?.map(item => item.classNumber) ?? [],
        }, worldRevision: world?.revision ?? null, surveyImports }), 'application/json');
      }
      if (pathname === '/api/capabilities' && method === 'GET') return response(200, JSON.stringify({
        application: 'WorldsAway.app', registration: { enabled: this.config.allowRegistration, endpoint: '/api/register',
          accountMaxLength: 24, passwordMaxLength: 24, avatarMaxLength: 29 },
      }), 'application/json');
      if (pathname === '/api/classes' && method === 'GET' && this.runtime) return response(200,
        JSON.stringify(this.runtime.registry.list().map(item => ({ classNumber: item.classNumber, name: item.name, capacity: item.capacity, schema: item.schema }))), 'application/json');
      if (pathname === '/api/coverage' && method === 'GET' && this.runtime) return response(200, JSON.stringify(this.runtime.coverage), 'application/json');
      if (pathname === '/worlds3.php') return response(200,
        `${this.config.worldName}|${this.baseUrl}/login|wa32.exe||worldsaway-images.zip\r\n`);
      if (['/files/localwa-images.zip', '/files/worldsaway-images.zip'].includes(pathname) && method === 'GET') {
        this.imageArchive ??= buildImageArchive(this.resources, this.config.worldName);
        return response(200, this.imageArchive, 'application/zip', { 'content-disposition': 'attachment; filename="worldsaway-images.zip"' });
      }
      if (pathname === '/' && method === 'GET') return response(200,
        `<!doctype html><html><head><meta charset="utf-8"><title>${this.config.worldName}</title></head><body>`
        + `<h1>${this.config.worldName}</h1><p>WorldsAway.app persistent multiplayer world server.</p>`
        + '<p>In the browser client, choose File → Connect → WorldsAway.app and use this service URL. Choose Create account to register, or sign in with an existing account.</p>'
        + '<form method="post" action="/connect.iv"><p><label>Account <input name="account" autocomplete="username" required></label></p>'
        + '<p><label>Password <input name="password" type="password" autocomplete="current-password" required></label></p>'
        + '<p><label>Avatar <input name="avatar"></label></p><button>Download connection file</button></form></body></html>', 'text/html; charset=utf-8');
      if (!['/login', '/connect.iv', '/connect.vz', '/api/avatars', '/api/profile', '/api/world', '/api/register'].includes(pathname)) throw new HttpError(404, 'Not found');
      if (pathname === '/api/register') {
        if (method !== 'POST') throw new HttpError(405, 'Use POST to create an account');
        if (!this.config.allowRegistration) throw new HttpError(403, 'Account creation is disabled on this server');
        if (url.search) throw new HttpError(400, 'Submit account details in the POST body');
        const origin = Object.entries(headers).find(([key]) => key.toLowerCase() === 'origin')?.[1];
        if (origin && origin !== this.baseUrl) throw new HttpError(403, 'Cross-origin account creation is not allowed');
      }
      const params = new URLSearchParams(url.search);
      if (method === 'POST') {
        const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
        if (String(lower['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Use application/x-www-form-urlencoded');
        const posted = new URLSearchParams(body.toString('utf8'));
        for (const [key, value] of posted) {
          if (params.has(key)) throw new HttpError(400, 'Repeated form parameter');
          params.append(key, value);
        }
      }
      const keys = [...params.keys()];
      if (keys.length > 32 || new Set(keys).size !== keys.length) throw new HttpError(400, 'Too many or repeated parameters');
      if (pathname === '/api/register') {
        if (keys.some(key => !['account', 'password', 'avatar'].includes(key))) throw new HttpError(400, 'Only account, password and avatar may be supplied');
        let created;
        try { created = this.store.createAccountWithAvatar(params.get('account') ?? '', params.get('password') ?? '', params.get('avatar') ?? ''); }
        catch (error) { if (error instanceof StoreConflictError) throw new HttpError(409, (error instanceof Error ? error.message : String(error))); throw error; }
        return response(201, JSON.stringify({ application: 'WorldsAway.app', account: { name: created.account.name },
          avatar: { name: created.avatar.name }, capacity: created.account.capacity }), 'application/json');
      }
      if (pathname === '/login' && params.get('action')?.toLowerCase() !== 'login') throw new HttpError(400, 'Unable: use action=Login');
      if (params.get('ws') === 'true') throw new HttpError(400, 'Unable: this local server advertises direct TCP mode');
      const name = params.get('account') ?? params.get('username') ?? '';
      const account = this.store.authenticate(name, params.get('password') ?? '');
      if (!account) throw new HttpError(pathname === '/login' ? 403 : 401, 'Unable: invalid account or password');
      if (pathname === '/api/profile' || pathname === '/api/world') {
        if (method !== 'POST') throw new HttpError(405, 'Use POST for authenticated world/profile requests');
        const result = this.runtime ? await this.runtime.run(() => handleWorldApi(this, account, params, pathname))
          : await handleWorldApi(this, account, params, pathname);
        return response(200, JSON.stringify(result), 'application/json');
      }
      if (pathname === '/api/avatars') {
        if (params.get('action') === 'create') {
          if (method !== 'POST') throw new HttpError(405, 'Use POST to create an avatar');
          const avatar = this.store.createAvatar(account, params.get('name') ?? '');
          return response(201, JSON.stringify({ name: avatar.name }), 'application/json');
        }
        return response(200, JSON.stringify({ capacity: account.capacity, avatars: this.store.listAvatars(account).map(a => a.name) }), 'application/json');
      }
      const requested = params.get('avatar') ?? '';
      const avatar = requested ? this.store.findAvatar(account, requested) : null;
      if (requested && !avatar) throw new HttpError(403, 'Unable: avatar does not belong to account');
      if (!this.store.listAvatars(account).length) throw new HttpError(403, 'Unable: create an avatar before connecting');
      return response(200, this.connectionFile(account, avatar), 'application/x-worldsaway', { 'content-disposition': 'attachment; filename="worldsaway.iv"' });
    } catch (error) {
      if (error instanceof HttpError || error instanceof WorldApiError) return response(error.status, (error instanceof Error ? error.message : String(error)));
      if (error instanceof StoreError) return response(400, (error instanceof Error ? error.message : String(error)));
      if (error instanceof TypeError || error instanceof URIError) return response(400, 'Malformed request');
      this.config.log('http-error', { name: error instanceof Error ? error.name : 'Error' });
      return response(500, 'Server could not complete the request');
    }
  }
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > this.config.maxHttpBodyBytes) {
          res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
          res.end('Request body too large'); return;
        }
        chunks.push(chunk);
      }
      const result = await this.handleHttpRequest({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(result.status, { ...result.headers, 'content-length': result.body.length }); res.end(result.body);
    } catch {
      if (!res.headersSent) res.writeHead(400, { connection: 'close' });
      res.end('Invalid request');
    }
  }
  attachSocket(socket: Socket, dedicatedRpc: boolean): void {
    this.sockets.add(socket); socket.setNoDelay(true); socket.setTimeout(15000, () => socket.destroy());
    let session: WorldSession | RpcSession | null = null; let prefix: Buffer = Buffer.alloc(0);
    // Pause input until each decoded batch finishes, preserving backpressure and request order.
    const send = (data: Buffer) => sendToSocket(socket, data);
    const close = () => socket.end();
    socket.on('data', (chunk: Buffer) => {
      socket.pause();
      const run = async () => {
        if (!session) {
          prefix = Buffer.concat([prefix, chunk]);
          if (prefix.length < 8) return;
          const opcode = prefix.readUInt32BE(0);
          const rpc = dedicatedRpc || opcode === 0x31 || opcode === 0x30;
          session = rpc ? this.createRpcSession(send, close) : this.createWorldSession(send, close);
          chunk = prefix; prefix = Buffer.alloc(0);
        }
        await session.feed(chunk);
        if (session instanceof WorldSession && session.account) socket.setTimeout(this.config.sessionTimeoutSeconds * 1000);
      };
      run().catch(() => socket.destroy()).finally(() => { if (!socket.destroyed) socket.resume(); });
    });
    socket.on('error', () => {});
    socket.on('close', () => { session?.end(); this.sockets.delete(socket); });
  }
  async start() {
    if (this.started || this.closed) throw new Error('Server already started or closed');
    const web = http.createServer({ maxHeaderSize: 16384 }, (req, res) => this.handleHttp(req, res));
    web.requestTimeout = 15000; web.headersTimeout = 10000; web.keepAliveTimeout = 1000; web.maxRequestsPerSocket = 1;
    web.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    const world = net.createServer(socket => this.attachSocket(socket, false));
    const rpc = net.createServer(socket => this.attachSocket(socket, true));
    try {
      const bindings: [NetServer, keyof typeof this.addresses][] = [[web, 'httpPort'], [world, 'worldPort'], [rpc, 'rpcPort']];
      for (const [listener, portName] of bindings) {
        listener.maxConnections = 128;
        this.listeners.push(listener);
        await new Promise<void>((resolve, reject) => {
          listener.once('error', reject);
          listener.listen(this.addresses[portName], this.config.host, () => { listener.off('error', reject); resolve(); });
        });
        listener.on('error', error => this.config.log('listener-error', { code: (error as NodeJS.ErrnoException).code }));
        this.addresses[portName] = (listener.address() as AddressInfo).port;
      }
      this.started = true;
      this.runtime?.start();
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  /** Stop accepting work, drain mutations, and only then release the single-writer lock. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const session of [...this.sessions]) session.end();
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(this.listeners.map(listener => new Promise<void>(resolve => {
      if (listener.listening) listener.close(() => resolve()); else resolve();
    })));
    this.listeners = [];
    try { await this.runtime?.close(); } finally { this.store.close(); }
  }
}

export function createCompatibilityServer(options: ServerOptions = {}) { return new CompatibilityServer(options); }

// Preferred application names; the compatibility export remains usable by existing clients.
export { CompatibilityServer as WorldsAwayServer };
export const createWorldsAwayServer = createCompatibilityServer;
