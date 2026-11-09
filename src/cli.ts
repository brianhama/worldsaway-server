#!/usr/bin/env node
import type { Role, ServerConfig } from './types.js';
import type { RequestContract } from './action-types.js';
import { pathToFileURL } from 'node:url';
import { makeConfig, environmentConfig } from './config.js';
import { AccountStore } from './store.js';
import { loadServerResources } from './resource-pack.js';
import { createCompatibilityServer } from './server.js';
import { WorldStore } from './world-store.js';
import { ClassRegistry } from './classes.js';
import { buildFeatureCoverage } from './coverage.js';
import { SUPPORTED_REQUESTS as objectRequests } from './object-actions.js';
import { SUPPORTED_REQUESTS as socialRequests } from './social-actions.js';
import { SUPPORTED_REQUESTS as builderRequests } from './builder-actions.js';
import { SUPPORTED_REQUESTS as specialRequests } from './special-actions.js';
import { SUPPORTED_REQUESTS as systemRequests } from './system-actions.js';
import { readPassword, passwordFromStdin } from '../scripts/launch-client.js';

const help = `WorldsAway.app server 1.0.0 (Node.js 20 or newer)

Usage: node dist/src/cli.js [options]
  --host ADDRESS             Listen address (default 127.0.0.1)
  --advertise-host HOST      Address reachable from Windows (default 127.0.0.1)
  --advertise-world-port N   Public native TCP port (defaults to bound world port)
  --advertise-rpc-port N     Public filename RPC port (defaults to bound RPC port)
  --public-url ORIGIN        Public HTTPS origin for launcher/authentication URLs
  --http-port PORT           HTTP port (default 8080)
  --world-port PORT          Native world / multiplexed RPC (default 1701)
  --rpc-port PORT            Native filename RPC (default 1702)
  --resource-pack-dir PATH  Portable resource pack (default server/resources)
  --client-dir PATH          Original WA cache directory (default project/wa)
  --data-dir PATH            Writable account state (default server/data)
  --world-name NAME          Local world name (default WorldsAway.app)
  --world-profile PROFILE    region (persistent shared world) or empty diagnostic
  --keepalive-seconds N      Heartbeat interval (default 30)
  --token-ttl-seconds N      Login-ticket lifetime (default 300)
  --session-timeout-seconds N  Idle connection timeout (default 180)
  --no-demo                  Do not seed the demo account
  --no-districts             Keep only the small starter town on a new world
  --debug                    Log unimplemented message identifiers
  --check                    Validate caches offline and exit
  --coverage                 Print the class/action coverage ledger
  --add-account NAME         Create a local account and exit
  --avatar NAME              Initial avatar for --add-account (default account name)
  --capacity N               Avatar slots for --add-account (default 3, maximum 8)
  --password-stdin           Read new account password from standard input
  --set-role AVATAR          Set a local avatar's role (stop the server first)
  --role ROLE                player, builder or admin (with --set-role)
  --help                     Show this help

Default login: demo / demo; avatar Demo.
Windows: scripts\\launch-client.cmd --demo --server http://HOST:8080
`;

/** Parsed CLI options remain separate from runtime config and are validated before use. */
export interface CliOptions extends Partial<ServerConfig> {
  help?: boolean; version?: boolean; check?: boolean; coverage?: boolean; debug?: boolean;
  addAccount?: string; avatar?: string; capacity?: number; passwordStdin?: boolean;
  setRole?: string; role?: Role;
}
export function parseArgs(argv: string[]): CliOptions {
  const values: Record<string, keyof CliOptions> = { '--host': 'host', '--advertise-host': 'advertiseHost', '--http-port': 'httpPort',
    '--advertise-world-port': 'advertiseWorldPort', '--advertise-rpc-port': 'advertiseRpcPort', '--public-url': 'publicUrl',
    '--world-port': 'worldPort', '--rpc-port': 'rpcPort', '--client-dir': 'clientDir', '--data-dir': 'dataDir', '--resource-pack-dir': 'resourcePackDir',
    '--world-name': 'worldName', '--world-profile': 'worldProfile', '--keepalive-seconds': 'keepaliveSeconds',
    '--token-ttl-seconds': 'tokenTtlSeconds', '--session-timeout-seconds': 'sessionTimeoutSeconds',
    '--add-account': 'addAccount', '--avatar': 'avatar', '--capacity': 'capacity', '--set-role': 'setRole', '--role': 'role' };
  const numeric = new Set(['httpPort', 'worldPort', 'rpcPort', 'advertiseWorldPort', 'advertiseRpcPort', 'keepaliveSeconds', 'tokenTtlSeconds', 'sessionTimeoutSeconds', 'capacity']);
  const result: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') result.help = true;
    else if (flag === '--version') result.version = true;
    else if (flag === '--no-demo') result.seedDemo = false;
    else if (flag === '--no-districts') result.seedDistricts = false;
    else if (flag === '--check') result.check = true;
    else if (flag === '--coverage') result.coverage = true;
    else if (flag === '--debug') result.debug = true;
    else if (flag === '--password-stdin') result.passwordStdin = true;
    else if (values[flag]) {
      const key = values[flag], value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      (result as Record<string, unknown>)[key] = numeric.has(key) ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(help); return; }
  if (options.version) { console.log('1.0.0'); return; }
  const { help: ignoredHelp, version, check, coverage, debug, addAccount, avatar, capacity, passwordStdin, setRole, role, ...settings } = options;
  const config = makeConfig({ ...environmentConfig(), ...settings });
  if (setRole) {
    if (!role || !['player', 'builder', 'admin'].includes(role)) throw new Error('Use --role player, builder or admin');
    if (addAccount) throw new Error('Use --add-account and --set-role separately');
    const accounts = new AccountStore(config.dataDir); let world;
    try {
      const selected = accounts.state.avatars.find(item => item.name.toLowerCase() === setRole.toLowerCase());
      if (!selected) throw new Error('Avatar does not exist in the local account store');
      world = new WorldStore(config.dataDir);
      world.ensureAvatar(selected);
      world.transaction(draft => { draft.avatars[selected.id].role = role; delete draft.avatars[selected.id].permissionLevel; }, { actorId: selected.id, action: 'local-role-grant', details: { role } });
      console.log(`Set ${selected.name} role to ${role}.`);
    } finally { world?.close(); accounts.close(); }
    return;
  }
  if (role) throw new Error('--role requires --set-role');
  if (addAccount) {
    const store = new AccountStore(config.dataDir);
    try {
      let password: string | undefined = passwordStdin ? await passwordFromStdin() : await readPassword(addAccount);
      const account = store.createAccount(addAccount, password, { capacity: capacity ?? 3 });
      password = undefined;
      const createdAvatar = store.createAvatar(account, avatar ?? addAccount);
      console.log(`Created account ${account.name} and avatar ${createdAvatar.name}.`);
    } finally { store.close(); }
    return;
  }
  if (passwordStdin || avatar !== undefined || capacity !== undefined) throw new Error('Account options require --add-account');
  if (check || coverage) {
    const resources = loadServerResources(config);
    if (coverage) {
      const handlers = ([...objectRequests, ...socialRequests, ...builderRequests, ...specialRequests, ...systemRequests] as readonly RequestContract[])
        .map(item => ({ ...item, classNumbers: item.classNumbers ?? item.classes ?? null }));
      console.log(JSON.stringify(buildFeatureCoverage(resources, { handlers }), null, 2)); return;
    }
    console.log(JSON.stringify({ status: 'ok', resourcePackDir: resources.directory ?? null,
      clientDir: resources.clientDir ?? null, resourceProfile: resources.resourceProfile,
      worldProfile: config.worldProfile, classes: new ClassRegistry(resources).summary, resources: resources.summary }, null, 2));
    return;
  }
  config.log = (event, details) => {
    if (event === 'entered' || event.endsWith('error') || debug) console.log(`${event}: ${JSON.stringify(details)}`);
  };
  const server = createCompatibilityServer(config);
  try {
    await server.start();
    console.log(`WorldsAway.app server 1.0.0: ${config.worldProfile} world`);
    console.log(`HTTP: ${server.baseUrl}`);
    console.log(`World TCP: ${config.advertiseHost}:${server.addresses.worldPort}`);
    console.log(`File RPC: ${config.advertiseHost}:${server.addresses.rpcPort}`);
    console.log(`Assets: ${server.resources.summary.resources ?? server.resources.bootstrapResources().length} MAG resources, ${server.resources.listFileNames().length} filename images`);
    console.log('Press Ctrl+C to stop.');
    await new Promise<void>(resolve => {
      const stop = () => resolve();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally { await server.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`WorldsAway.app: ${(error instanceof Error ? error.message : String(error))}`); process.exitCode = 1; });
}
