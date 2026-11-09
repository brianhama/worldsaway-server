#!/usr/bin/env node
/** Independent synthetic WA protocol client. It never executes a Windows binary. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import type { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

export interface SmokeConnection { host: string; worldPort: number; rpcPort: number; account: string; avatar: string; token: string; region: number; }
interface SmokeFrame { noid: number; message: number; body: Buffer; }
interface ByteWaiter { size: number; resolve: (data: Buffer) => void; reject: (error: Error) => void; }
interface IncomingResource { version: number; size: number; chunks: Buffer[]; received: number; }
interface SmokeArgs { httpUrl: string; account: string; avatar: string; timeout: number; files: string[]; passwordStdin?: boolean; connectFile?: string; }

const MAX_BODY = 16 * 1024 * 1024;

function field(value: string, width: number): Buffer {
  if (!/^[\x20-\x7e]*$/.test(value) || Buffer.byteLength(value, 'ascii') >= width) {
    throw new Error(`Value does not fit ${width - 1} printable ASCII bytes`);
  }
  const output = Buffer.alloc(width);
  output.write(value, 'ascii');
  return output;
}

function frame(noid: number, message: number, body: Buffer = Buffer.alloc(0)): Buffer {
  // This independent fixture deliberately avoids the server codec: a matching
  // mistake in the producer and consumer must not make a smoke check pass.
  const header = Buffer.alloc(8);
  header.writeUInt16BE(noid, 0);
  header.writeUInt16BE(message, 2);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

export function parseConnect(body: Buffer): SmokeConnection {
  if (body.length > 4096 || !body.subarray(0, 9).equals(Buffer.from('[Message]')) || body.some(byte => byte > 127)) {
    throw new Error('Invalid native Connect file');
  }
  const sections = new Map<string, Map<string, string>>();
  let section: string | undefined;
  for (const line of body.toString('ascii').split(/\r?\n/)) {
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      if (sections.has(section)) throw new Error('Repeated Connect section');
      sections.set(section, new Map());
    } else if (line.includes('=') && section) {
      const equals = line.indexOf('=');
      const key = line.slice(0, equals);
      if (sections.get(section)!.has(key)) throw new Error('Repeated Connect field');
      sections.get(section)!.set(key, line.slice(equals + 1));
    }
  }
  if (sections.get('Message')?.get('messagetype') !== 'Connect') throw new Error('Response is not a Connect message');
  const values = sections.get('Connect Info');
  if (!values) throw new Error('Missing Connect Info');
  const number = (key: string): number => {
    const value = values.get(key);
    if (!/^\d+$/.test(value ?? '')) throw new Error(`Invalid ${key}`);
    return Number(value);
  };
  const result = {
    host: values.get('serveraddr'), worldPort: number('loginport'), rpcPort: number('rpcport'),
    account: values.get('acctname'), avatar: values.get('avatarname'),
    token: values.get('onetimepass'), region: number('loginregion'),
  };
  if (!result.host || !result.account || !result.avatar || !/^[A-Za-z0-9_-]{15}$/.test(result.token ?? '')) {
    throw new Error('Connect response lacks bounded account, avatar, host or ticket');
  }
  for (const port of [result.worldPort, result.rpcPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Connect port outside 1..65535');
  }
  return result as SmokeConnection;
}

/** Ordered bounded reads prevent TCP fragmentation from becoming packet ambiguity. */
class ByteReader {
  socket: Socket;
  buffer: Buffer;
  waiters: ByteWaiter[];
  failure: Error | null;
  constructor(socket: Socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.failure = null;
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
    socket.on('end', () => { this.failure = new Error('Unexpected end of stream'); this.flush(); });
    socket.on('error', error => { this.failure = error; this.flush(); });
  }
  flush(): void {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      if (this.buffer.length >= waiter.size) {
        this.waiters.shift();
        const data = this.buffer.subarray(0, waiter.size);
        this.buffer = this.buffer.subarray(waiter.size);
        waiter.resolve(data);
      } else if (this.failure) {
        this.waiters.shift()!.reject(this.failure);
      } else break;
    }
  }
  read(size: number): Promise<Buffer> {
    if (!Number.isInteger(size) || size < 0 || size > MAX_BODY) return Promise.reject(new Error('Read exceeds smoke client limit'));
    return new Promise((resolve, reject) => { this.waiters.push({ size, resolve, reject }); this.flush(); });
  }
  async frame(): Promise<SmokeFrame> {
    const header = await this.read(8);
    const size = header.readUInt32BE(4);
    return { noid: header.readUInt16BE(0), message: header.readUInt16BE(2), body: await this.read(size) };
  }
}

async function connect(host: string, port: number, timeout: number): Promise<{ socket: Socket; reader: ByteReader }> {
  const socket = net.createConnection({ host, port });
  const reader = new ByteReader(socket);
  socket.setTimeout(timeout, () => socket.destroy(new Error('Socket timeout')));
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return { socket, reader };
}

function zeroRLE(blob: Buffer): Buffer {
  if (blob.length < 4) throw new Error('Region has no zero-RLE length');
  const size = blob.readUInt32BE(0);
  if (size > MAX_BODY) throw new Error('Region expansion exceeds smoke client limit');
  const output = Buffer.alloc(size);
  let position = 0;
  for (let index = 4; index < blob.length; index += 1) {
    const value = blob[index];
    if (value !== 255) {
      if (position >= size) throw new Error('Region expansion overflow');
      output[position++] = value;
    } else {
      if (++index >= blob.length) throw new Error('Truncated RLE escape');
      const count = blob[index];
      if (count === 255) {
        if (position >= size) throw new Error('Region expansion overflow');
        output[position++] = 255;
      } else {
        if (position + count > size) throw new Error('Region expansion overflow');
        position += count;
      }
    }
  }
  if (position !== size) throw new Error('Region expansion length mismatch');
  return output;
}

export async function checkWorld(connection: SmokeConnection, { timeout = 15000 }: { timeout?: number } = {}): Promise<{ resources: number; resourceBytes: number; cvRecords: number }> {
  const { socket, reader } = await connect(connection.host, connection.worldPort, timeout);
  try {
    const login = Buffer.alloc(288);
    field(connection.account, 256).copy(login);
    field(connection.token, 16).copy(login, 256);
    login.writeUInt16BE(0, 276); // The WA sender uses locale 0.
    login.writeUInt16BE(2, 278);
    login.writeUInt16BE(325, 280);
    socket.write(frame(10, 11, login));
    let configuration = false;
    let advertised = false;
    for (let count = 0; count < 32 && !(configuration && advertised); count += 1) {
      const packet = await reader.frame();
      if (packet.noid === 10 && packet.message === 15) throw new Error('World login rejected');
      if (packet.noid === 10 && packet.message === 10) {
        assert.equal(packet.body.length, 16, 'configuration must be four words');
        configuration = true;
      }
      if (packet.noid === 10 && packet.message === 12) {
        assert(packet.body.length >= 276, 'avatar list is shorter than native fixed fields');
        const count = packet.body.readUInt32BE(4);
        const capacity = packet.body.readUInt32BE(8);
        assert(count >= 1 && count <= capacity && capacity <= 8, 'invalid avatar count/capacity');
        const names = Array.from({ length: capacity }, (_, index) => packet.body.subarray(18 + 32 * index, 50 + 32 * index).toString('ascii').split('\0', 1)[0]);
        assert(names.includes(connection.avatar), 'requested avatar was not advertised');
        advertised = true;
      }
    }
    assert(configuration && advertised, 'login did not finish configuration/avatar advertisement');
    const entry = Buffer.alloc(72);
    field(connection.avatar, 32).copy(entry);
    entry.writeUInt32BE(connection.region, 32);
    socket.write(frame(10, 13, entry));
    const resources = new Map<number, IncomingResource>();
    let announced: { count: number; bytes: number } | undefined;
    let ended = false;
    let region = false;
    let records = 0;
    for (let index = 0; index < 20000 && !(ended && region); index += 1) {
      const packet = await reader.frame();
      const body = packet.body;
      if (packet.noid === 10 && packet.message === 15) throw new Error('Avatar entry rejected');
      if (packet.noid === 10 && packet.message === 16) {
        assert.equal(body.length, 8);
        assert.equal(announced, undefined, 'repeated resource start');
        announced = { count: body.readUInt32BE(0), bytes: body.readUInt32BE(4) };
      } else if (packet.noid === 10 && packet.message === 17) {
        assert(announced && !ended && body.length >= 16, 'resource outside active update');
        const id = body.readUInt32BE(0);
        const version = body.readUInt32BE(4);
        const fullSize = body.readUInt32BE(8);
        const size = body.readUInt32BE(12);
        assert.equal(body.length, size + 16, 'resource fragment size');
        let resource = resources.get(id);
        if (!resource) {
          assert(fullSize >= size && fullSize !== 0xffffffff, 'invalid first resource fragment');
          resource = { version, size: fullSize, chunks: [], received: 0 };
          resources.set(id, resource);
        } else {
          assert.equal(version, resource.version);
          assert(fullSize === 0 || fullSize === 0xffffffff, 'invalid continuation marker');
        }
        resource.chunks.push(body.subarray(16));
        resource.received += size;
        assert(resource.received <= resource.size);
      } else if (packet.noid === 10 && packet.message === 18) {
        assert(announced, 'resource end without start');
        assert.equal(resources.size, announced.count);
        assert.equal([...resources.values()].reduce((sum, item) => sum + item.received, 0), announced.bytes);
        for (const item of resources.values()) assert.equal(item.received, item.size);
        for (const id of [0x000a0005, 0x00050001, 0x00050002]) assert(resources.has(id), `missing original bootstrap ${id.toString(16)}`);
        ended = true;
      } else if (packet.noid === 0 && packet.message === 101) {
        assert(body.length >= 116, 'short RegionHereIs');
        const size = body.readUInt32BE(108);
        assert.equal(body.length, size + 112);
        const contents = zeroRLE(body.subarray(112));
        let position = 0;
        while (position < contents.length) {
          assert(position + 2 <= contents.length, 'partial CV length');
          const length = contents.readUInt16BE(position);
          position += 2;
          assert(length >= 2 && position + length <= contents.length, 'invalid CV record');
          position += length;
          records += 1;
        }
        region = true;
      }
    }
    assert(ended && region, 'bootstrap/region exchange did not finish');
    socket.write(Buffer.concat([frame(10, 19, Buffer.alloc(1)), frame(10, 20, Buffer.alloc(1))]));
    if (!socket.readableEnded) await new Promise<void>((resolve, reject) => { socket.once('end', resolve); socket.once('error', reject); });
    return { resources: resources.size, resourceBytes: announced!.bytes, cvRecords: records };
  } finally {
    socket.destroy();
  }
}

export async function checkRpc(connection: SmokeConnection, filenames: readonly string[], { timeout = 15000 }: { timeout?: number } = {}): Promise<{ filename: string; bytes: number }[]> {
  if (filenames.length < 1 || filenames.length > 2) throw new Error('WA RPC supports one or two filenames per request');
  const { socket, reader } = await connect(connection.host, connection.rpcPort, timeout);
  try {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0x31, 0);
    header.writeUInt32BE(filenames.length, 4);
    socket.write(Buffer.concat([header, ...filenames.map(name => field(name, 64))]));
    const result = [];
    for (const expected of filenames) {
      const reply = await reader.read(76);
      assert.equal(reply.readUInt32BE(0), 0, `RPC rejected ${expected}`);
      assert.equal(reply.subarray(4, 68).toString('ascii').split('\0', 1)[0], expected);
      const size = reply.readUInt32BE(68);
      const data = await reader.read(size);
      result.push({ filename: expected, bytes: data.length });
    }
    return result;
  } finally {
    socket.destroy();
  }
}

async function fetchConnect(url: string, account: string, password: string, avatar: string, timeout: number): Promise<SmokeConnection> {
  const response = await fetch(new URL('connect.iv', url.endsWith('/') ? url : url + '/'), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account, password, avatar }),
  });
  if (!response.ok) throw new Error(`Connection request failed: HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let length = 0;
  if (!response.body) throw new Error('Connection response has no body');
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 4096) throw new Error('Connect response exceeds client limit');
    chunks.push(Buffer.from(chunk));
  }
  return parseConnect(Buffer.concat(chunks));
}

function usage(): string {
  return `Usage: node dist/scripts/smoke-client.js [options]\n\n` +
    `  --http-url URL       Compatibility server (default http://127.0.0.1:8080)\n` +
    `  --account NAME      Account (default demo)\n` +
    `  --avatar NAME       Avatar (default Demo)\n` +
    `  --password-stdin    Read one password line; otherwise use demo password\n` +
    `  --connect-file PATH Use an existing fresh .iv file instead of HTTP login\n` +
    `  --rpc-file NAME     Also fetch this image; may be supplied twice\n` +
    `  --timeout MS        Per-operation timeout (default 15000)\n\n` +
    `Synthetic protocol verification only; this does not run the Windows client.\n`;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options: SmokeArgs = { httpUrl: 'http://127.0.0.1:8080', account: 'demo', avatar: 'Demo', timeout: 15000, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { console.log(usage()); return; }
    if (arg === '--password-stdin') { options.passwordStdin = true; continue; }
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    if (arg === '--http-url') options.httpUrl = value;
    else if (arg === '--account') options.account = value;
    else if (arg === '--avatar') options.avatar = value;
    else if (arg === '--connect-file') options.connectFile = value;
    else if (arg === '--rpc-file') options.files.push(value);
    else if (arg === '--timeout') options.timeout = Number(value);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 1) throw new Error('Timeout must be positive milliseconds');
  let connection: SmokeConnection;
  if (options.connectFile) connection = parseConnect(await readFile(options.connectFile));
  else {
    let password = 'demo';
    if (options.passwordStdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    }
    connection = await fetchConnect(options.httpUrl, options.account, password, options.avatar, options.timeout);
  }
  const result = await checkWorld(connection, options);
  console.log(`Protocol smoke passed: login, avatar, ${result.resources} resources (${result.resourceBytes} bytes), region (${result.cvRecords} CV records), keepalive and logout.`);
  if (options.files.length) {
    for (const file of await checkRpc(connection, options.files, options)) console.log(`File RPC passed: ${file.filename} (${file.bytes} bytes).`);
  }
  console.log('Original Windows client interoperability requires a separate client run.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Protocol smoke failed: ${error.message}`); process.exitCode = 1; });
}
