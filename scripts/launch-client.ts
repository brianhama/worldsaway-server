#!/usr/bin/env node
/** Obtain a local WA Connect file and launch an isolated original client copy. */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { serverRoot } from '../src/paths.js';

export interface LaunchArgs {
  server: string; account: string; avatar: string; clientDir: string; runtimeDir?: string; output?: string;
  editor: boolean; demo: boolean; passwordStdin: boolean; downloadOnly: boolean; help?: boolean;
}
/** Connect files are bounded native strings, not URLs or shell argument fragments. */
export interface ConnectInfo extends Record<string, string> {
  worldname: string; serveraddr: string; acctname: string; onetimepass: string; loginport: string; rpcport: string;
}
export interface PasswordInput extends Pick<Readable, 'setEncoding' | 'resume' | 'pause' | 'isPaused' | 'on' | 'once' | 'removeListener'> {
  isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown;
}
interface ResponseLike {
  statusCode?: number; resume?: () => unknown; destroy: () => unknown;
  on(event: 'error', callback: (error: Error) => void): unknown;
  on(event: 'data', callback: (chunk: Buffer) => void): unknown;
  on(event: 'end', callback: () => void): unknown;
}
interface RequestLike { on(event: 'error', callback: (error: Error) => void): unknown; end(body?: Uint8Array): unknown; }
export type RequestFactory = (url: URL, options: http.RequestOptions, callback: (response: ResponseLike) => void) => RequestLike;
export interface RequestBufferOptions { timeoutMs?: number; request?: RequestFactory; }
export interface LaunchDependencies {
  platform?: NodeJS.Platform; request?: (url: string, body?: Buffer) => Promise<Buffer>;
  passwordFromStdin?: () => Promise<string>; readPassword?: (account: string) => Promise<string>;
  launch?: (executable: string, args: string[], options: { cwd: string }) => Promise<unknown>;
}
export type LauncherResult = { help: true } | { help?: false; output: string; info: ConnectInfo; executable?: string; runtimeDirectory?: string };


const SCRIPT = fileURLToPath(import.meta.url);
const DEFAULT_CLIENT = path.resolve(serverRoot, '../wa');
const MARKER = 'wa-compat-runtime.json';
const PROFILE = 'wa-original-v19';
const MAX_RESPONSE = 4096;

export class LaunchError extends Error {}

export function serverUrl(value: string): string {
  let parsed;
  try { parsed = new URL(value); } catch { throw new LaunchError('Use an HTTP or HTTPS server URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LaunchError('The server URL must use HTTP or HTTPS without credentials, query, or fragment.');
  }
  return parsed.href.replace(/\/+$/, '');
}

export function parseArgs(argv: readonly string[]): LaunchArgs {
  const result: LaunchArgs = { server: 'http://127.0.0.1:8080', account: 'demo', avatar: 'Demo',
    clientDir: DEFAULT_CLIENT, runtimeDir: undefined, editor: false,
    demo: false, passwordStdin: false, downloadOnly: false, output: undefined };
  const values: Record<string, 'server' | 'account' | 'avatar' | 'clientDir' | 'runtimeDir' | 'output'> = { '--server': 'server', '--account': 'account', '--avatar': 'avatar',
    '--client-dir': 'clientDir', '--runtime-dir': 'runtimeDir', '--output': 'output' };
  const switches: Record<string, 'editor' | 'demo' | 'passwordStdin' | 'downloadOnly' | 'help'> = { '--editor': 'editor', '--demo': 'demo',
    '--password-stdin': 'passwordStdin', '--download-only': 'downloadOnly', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (Object.hasOwn(values, option)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new LaunchError('Missing value for ' + option + '.');
      result[values[option]] = argv[++i];
    } else if (Object.hasOwn(switches, option)) {
      result[switches[option]] = true;
    } else {
      throw new LaunchError('Unknown option: ' + option + '. Use --help.');
    }
  }
  if (result.demo && result.passwordStdin) throw new LaunchError('Use --demo or --password-stdin, not both.');
  result.server = serverUrl(result.server);
  return result;
}

export function validateConnection(input: Buffer | Uint8Array | string): ConnectInfo {
  const body = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (body.length > MAX_RESPONSE || !body.subarray(0, 9).equals(Buffer.from('[Message]')) ||
      body.some(byte => byte > 126 || (byte < 32 && byte !== 10 && byte !== 13)) ||
      body.includes(37)) {
    throw new LaunchError('The server did not return a bounded ASCII WA Connect file.');
  }
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of body.toString('ascii').split(/\r\n|\n|\r/)) {
    if (!line) continue;
    if (/^\[[^\]]+\]$/.test(line)) {
      if (sections.has(line)) throw new LaunchError('The Connect file contains a repeated section.');
      current = new Map();
      sections.set(line, current);
      continue;
    }
    const split = line.indexOf('=');
    if (!current || split < 1) throw new LaunchError('The Connect file contains an invalid line.');
    const key = line.slice(0, split);
    if (current.has(key)) throw new LaunchError('The Connect file contains a repeated field.');
    current.set(key, line.slice(split + 1));
  }
  if (sections.get('[Message]')?.get('messagetype') !== 'Connect') {
    throw new LaunchError('The server response is not a Connect handoff.');
  }
  const info = Object.fromEntries(sections.get('[Connect Info]') ?? []);
  for (const [key, limit] of Object.entries({ worldname: 63, serveraddr: 63, acctname: 255, onetimepass: 15 })) {
    if (!info[key] || info[key].length > limit || /[\[\]]/.test(info[key])) {
      throw new LaunchError('The Connect file has an invalid ' + key + ' field.');
    }
  }
  for (const [key, limit] of Object.entries({ username: 31, avatarname: 31 })) {
    if ((info[key] ?? '').length > limit || /[\[\]]/.test(info[key] ?? '')) {
      throw new LaunchError('The Connect file has an invalid ' + key + ' field.');
    }
  }
  for (const key of ['loginport', 'rpcport']) {
    if (!/^\d{1,5}$/.test(info[key] ?? '') || +info[key] < 1 || +info[key] > 65535) {
      throw new LaunchError('The Connect file has an invalid ' + key + ' field.');
    }
  }
  if (info.loginregion !== undefined && !/^\d{1,10}$/.test(info.loginregion)) {
    throw new LaunchError('The Connect file has an invalid loginregion field.');
  }
  return info as ConnectInfo;
}

export function validateWindowsConnectionPath(filename: string): void {
  // Keep the sole raw argument within the older loader's bounded command line,
  // including quotes. ASCII avoids a lossy conversion in the native ANSI API.
  if (!/^[\x20-\x7e]+$/.test(filename) || /["\r\n]/.test(filename)) {
    throw new LaunchError('Use a short ASCII --output path supported by the native Windows client.');
  }
  if (Buffer.byteLength(filename, 'ascii') + 2 >= 280) {
    throw new LaunchError('The quoted connection path must be shorter than 280 bytes. Choose a shorter --output path.');
  }
}

export async function requestBuffer(url: string, body?: Buffer, { timeoutMs = 10000, request }: RequestBufferOptions = {}): Promise<Buffer> {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  const makeRequest: RequestFactory = request ?? ((url, options, callback) => transport.request(url, options, callback));
  return await new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { Accept: 'application/octet-stream, application/json, text/plain' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = makeRequest(parsed, { method: body === undefined ? 'GET' : 'POST',
      headers, signal: AbortSignal.timeout(timeoutMs) }, response => {
      if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
        // A Connect request carries a password. Following redirects could resend
        // it to another origin, so operators must supply the final service URL.
        response.resume?.();
        reject(new LaunchError('The server redirected the request; use its direct local URL.'));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume?.();
        reject(new LaunchError([401, 403].includes(response.statusCode ?? 0)
          ? 'Login was rejected. Check the account, password, and avatar.'
          : 'The server returned HTTP ' + response.statusCode + '.'));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_RESPONSE) {
          response.destroy();
          reject(new LaunchError('The server response exceeds the 4096-byte handoff limit.'));
        } else {
          chunks.push(chunk);
        }
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', error => reject(error instanceof LaunchError ? error :
      new LaunchError('Cannot reach the local server. Start it and check the URL and ports.')));
    req.end(body);
  });
}

function hash(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }

export function defaultRuntimeDirectory(clientHash: string, environment: NodeJS.ProcessEnv = process.env, resourceProfile = ''): string {
  return path.join(environment.LOCALAPPDATA || os.tmpdir(), 'WACompat', clientHash.slice(0, 12),
    ...(resourceProfile ? [hash(Buffer.from(resourceProfile)).slice(0, 12)] : []), 'Client');
}

export async function prepareRuntime(clientDirectory: string, runtimeDirectory?: string, { editor = false, resourceProfile = PROFILE }: { editor?: boolean; resourceProfile?: string } = {}): Promise<{ executable: string; runtimeDirectory: string; clientHash: string }> {
  let source;
  try { source = await fs.realpath(path.resolve(clientDirectory)); }
  catch { throw new LaunchError('Cannot find the original client folder. Use --client-dir.'); }
  const executableName = editor ? 'reno32.exe' : 'wa32.exe';
  let executableData;
  try {
    executableData = await fs.readFile(path.join(source, executableName));
    const font = await fs.stat(path.join(source, 'worldsaw.fon'));
    if (!font.isFile() || executableData.length < 2 || executableData.toString('ascii', 0, 2) !== 'MZ') throw new Error();
  } catch {
    throw new LaunchError('The client folder must contain ' + executableName + ' and worldsaw.fon. Use --client-dir.');
  }
  const clientHash = hash(executableData);
  const destinationPath = path.resolve(runtimeDirectory ?? defaultRuntimeDirectory(clientHash, process.env, resourceProfile));
  await fs.mkdir(destinationPath, { recursive: true });
  const destination = await fs.realpath(destinationPath);
  if (source === destination) throw new LaunchError('The runtime directory must differ from the original client directory.');
  const expected = { format: 1, executable: executableName, clientSha256: clientHash, resourceProfile };
  const entries = await fs.readdir(destination);
  if (entries.length) {
    let previous;
    try { previous = JSON.parse(await fs.readFile(path.join(destination, MARKER), 'utf8')); } catch {}
    if (!previous || (Object.keys(expected) as (keyof typeof expected)[]).some(key => previous[key] !== expected[key])) {
      throw new LaunchError('The runtime directory contains other files or a different cache profile. Choose a new --runtime-dir.');
    }
  }
  const allowed = [executableName, 'worldsaw.fon', 'postmort.exe'];
  if (editor) allowed.push('sbtadd32.sdt', 'sbtaffin.sdt', 'sbtcls32.sdt', 'sbtdream.sdt',
    'sbthall.sdt', 'sbtlist.sdt', 'sbtpride.sdt', 'sbtsty32.sdt');
  for (const name of allowed) {
    const original = path.join(source, name);
    let sourceData;
    try {
      if (!(await fs.stat(original)).isFile()) continue;
      sourceData = await fs.readFile(original);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try {
      if ((await fs.readFile(path.join(destination, name))).equals(sourceData)) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = path.join(destination, name + '.' + randomBytes(6).toString('hex') + '.tmp');
    try {
      await fs.copyFile(original, temporary);
      await fs.rename(temporary, path.join(destination, name));
    } finally { await fs.rm(temporary, { force: true }); }
  }
  // A marker is written only after copying; an interrupted unowned directory
  // is intentionally not reused silently on the next run.
  const temporaryMarker = path.join(destination, MARKER + '.' + randomBytes(6).toString('hex') + '.tmp');
  try {
    await fs.writeFile(temporaryMarker, JSON.stringify(expected, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporaryMarker, path.join(destination, MARKER));
  } finally { await fs.rm(temporaryMarker, { force: true }); }
  return { executable: path.join(destination, executableName), runtimeDirectory: destination, clientHash };
}

export async function writeConnection(body: Uint8Array, filename: string, { platform = process.platform }: { platform?: NodeJS.Platform } = {}): Promise<void> {
  if (platform === 'win32') validateWindowsConnectionPath(filename);
  if (path.extname(filename).toLowerCase() !== '.iv') throw new LaunchError('The connection output must use the .iv extension.');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  // The file contains a short-lived login ticket; do not replace an existing file.
  await fs.writeFile(filename, body, { flag: 'wx', mode: 0o600 });
}

export async function readPassword(account: string, { input = process.stdin, output = process.stderr }: { input?: PasswordInput; output?: { write: (text: string) => unknown } } = {}): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new LaunchError('Use an interactive terminal, --demo, or --password-stdin to supply a password.');
  }
  const setRawMode = input.setRawMode.bind(input);
  output.write('Password for ' + account + ': ');
  const previousRaw = Boolean(input.isRaw);
  const previouslyPaused = input.isPaused();
  input.setEncoding('utf8');
  setRawMode(true);
  input.resume();
  return await new Promise((resolve, reject) => {
    let password = '';
    const cleanup = () => {
      // Restore the caller's terminal on every completion path, including Ctrl+C
      // and EOF; leaving raw mode enabled would break the surrounding shell.
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      setRawMode(previousRaw);
      if (previouslyPaused) input.pause();
      output.write('\n');
    };
    const onEnd = () => { cleanup(); reject(new LaunchError('No password was supplied.')); };
    const onData = (data: string) => {
      for (const char of data) {
        if (char === '\u0003') { cleanup(); reject(new LaunchError('Login cancelled.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(password); return; }
        if (char === '\u007f' || char === '\b') {
          if (password) { password = Array.from(password).slice(0, -1).join(''); output.write('\b \b'); }
        } else if (char >= ' ' && password.length < 1024) {
          password += char;
          output.write('*');
        }
      }
    };
    input.on('data', onData);
    input.once('end', onEnd);
  });
}

export async function passwordFromStdin(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of lines) {
      if (line.length > 1024) throw new LaunchError('The supplied password is too long.');
      return line;
    }
    throw new LaunchError('No password was supplied on standard input.');
  } finally { lines.close(); }
}

async function launchDetached(executable: string, args: string[], options: { cwd: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { ...options, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function runLauncher(argv: readonly string[] = process.argv.slice(2), dependencies: LaunchDependencies = {}): Promise<LauncherResult> {
  const args = parseArgs(argv);
  if (args.help) return { help: true };
  const platform = dependencies.platform ?? process.platform;
  if (!args.downloadOnly && platform !== 'win32') {
    throw new LaunchError('The original WA client requires Windows. Use --download-only to obtain its handoff here.');
  }
  const request = dependencies.request ?? requestBuffer;
  let health;
  try { health = JSON.parse((await request(args.server + '/health')).toString('utf8')); }
  catch (error) {
    if (error instanceof LaunchError) throw error;
    throw new LaunchError('The server did not return a valid health response.');
  }
  if (!health || health.status !== 'ok') throw new LaunchError('The compatibility server is not ready.');
  const resourceProfile = health.resourceProfile ?? PROFILE;
  if (typeof resourceProfile !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(resourceProfile)) {
    throw new LaunchError('The server returned an invalid resource profile.');
  }
  const runtime = args.downloadOnly ? undefined : await prepareRuntime(args.clientDir, args.runtimeDir,
    { editor: args.editor, resourceProfile });
  let password: string | undefined;
  if (args.demo) password = 'demo';
  else if (args.passwordStdin) password = await (dependencies.passwordFromStdin ?? passwordFromStdin)();
  else password = await (dependencies.readPassword ?? readPassword)(args.account);
  let form: string | undefined = new URLSearchParams({ account: args.account, password, avatar: args.avatar }).toString();
  // Credentials travel in one POST body, never the command line or handoff URL.
  // Releasing these references is not a promise of secure string-memory erasure.
  const body = await request(args.server + '/connect.iv', Buffer.from(form, 'utf8'));
  password = undefined;
  form = undefined;
  const info = validateConnection(body);
  const directory = runtime?.runtimeDirectory ?? path.join(os.tmpdir(), 'wa-compat');
  const output = path.resolve(args.output ?? path.join(directory, randomBytes(8).toString('hex') + '.iv'));
  await writeConnection(body, output, { platform });
  if (runtime) await (dependencies.launch ?? launchDetached)(runtime.executable, [output], { cwd: runtime.runtimeDirectory });
  return { output, info, executable: runtime?.executable, runtimeDirectory: runtime?.runtimeDirectory };
}

const HELP = [
  'Usage: node dist/scripts/launch-client.js [options]',
  '',
  '--server URL            Server HTTP URL (default http://127.0.0.1:8080)',
  '--client-dir PATH       Original WA files (default project/wa)',
  '--runtime-dir PATH      New or owned isolated client/cache directory',
  '--account NAME          Account (default demo)',
  '--avatar NAME           Avatar (default Demo)',
  '--demo                  Use the default demo password',
  '--password-stdin        Read one password line from stdin',
  '--editor                Launch reno32.exe instead of wa32.exe',
  '--download-only         Obtain a handoff without starting Windows',
  '--output PATH.iv        New connection file; never overwritten',
  '--help                  Show these options',
].join('\n');

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const result = await runLauncher(argv);
    if (result.help) { console.log(HELP); return 0; }
    if (result.executable) {
      console.log('Started ' + path.basename(result.executable) + ' for ' + result.info.worldname + '.');
      console.log('Client runtime: ' + result.runtimeDirectory);
    }
    console.log('Connection file: ' + result.output);
    console.log('World endpoint: ' + result.info.serveraddr + ':' + result.info.loginport + ' (RPC ' + result.info.rpcport + ')');
    return 0;
  } catch (error) {
    console.error('WA: ' + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) process.exitCode = await main();
