/** Validate deployment flags once so every listener and handoff uses the same configuration. */
import path from 'node:path';
import { serverRoot } from './paths.js';
import type { ServerConfig } from './types.js';

export function environmentConfig(env: NodeJS.ProcessEnv = process.env): Partial<ServerConfig> {
  const result: Partial<ServerConfig> = {};
  if (env.WORLDSAWAY_ALLOW_REGISTRATION !== undefined) {
    if (!['true', 'false'].includes(env.WORLDSAWAY_ALLOW_REGISTRATION)) throw new Error('WORLDSAWAY_ALLOW_REGISTRATION must be true or false');
    result.allowRegistration = env.WORLDSAWAY_ALLOW_REGISTRATION === 'true';
  }
  // Environment values start as strings. Keep numeric ports separate from
  // textual endpoints so configuration consumers never receive a string port.
  const portKeys = { HTTP_PORT: 'httpPort', WORLD_PORT: 'worldPort', RPC_PORT: 'rpcPort',
    ADVERTISE_WORLD_PORT: 'advertiseWorldPort', ADVERTISE_RPC_PORT: 'advertiseRpcPort' } as const;
  for (const [suffix, key] of Object.entries(portKeys)) {
    const value = env[`WORLDSAWAY_${suffix}`];
    if (value === undefined) continue;
    if (!/^\d+$/.test(value)) throw new Error(`WORLDSAWAY_${suffix} must be an integer port`);
    result[key] = Number(value);
  }
  const textKeys = { HOST: 'host', ADVERTISE_HOST: 'advertiseHost', DATA_DIR: 'dataDir',
    PUBLIC_URL: 'publicUrl', RESOURCE_PACK_DIR: 'resourcePackDir', CLIENT_DIR: 'clientDir', WORLD_NAME: 'worldName', SURVEY_IMPORT_FILE: 'surveyImportFile' } as const;
  for (const [suffix, key] of Object.entries(textKeys)) {
    const value = env[`WORLDSAWAY_${suffix}`];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function makeConfig(input: Partial<ServerConfig> = {}): ServerConfig {
  const config: ServerConfig = {
    host: '127.0.0.1', advertiseHost: '127.0.0.1',
    httpPort: 8080, worldPort: 1701, rpcPort: 1702,
    advertiseWorldPort: null, advertiseRpcPort: null, publicUrl: null,
    worldName: 'WorldsAway.app', clientDir: path.resolve(serverRoot, '../wa'),
    resourcePackDir: Object.hasOwn(input, 'clientDir') ? null : path.join(serverRoot, 'resources'),
    dataDir: path.join(serverRoot, 'data'), surveyImportFile: null, demoAccount: 'demo',
    demoPassword: 'demo', demoAvatar: 'Demo', seedDemo: true, seedDistricts: true, allowRegistration: true, worldProfile: 'region', tokenTtlSeconds: 300,
    keepaliveSeconds: 30, sessionTimeoutSeconds: 180,
    maxFrameBytes: 1024 * 1024, maxFileBytes: 16 * 1024 * 1024,
    maxHttpBodyBytes: 8192, maxBufferedBytes: 2 * 1024 * 1024,
    log: () => {}, ...input,
  };
  for (const name of ['httpPort', 'worldPort', 'rpcPort'] as const) {
    if (!Number.isInteger(config[name]) || config[name] < 0 || config[name] > 65535) {
      throw new Error(`${name} must be an integer from 0 to 65535`);
    }
  }
  const fixedPorts = [config.httpPort, config.worldPort, config.rpcPort].filter(Boolean);
  if (new Set(fixedPorts).size !== fixedPorts.length) throw new Error('Nonzero listener ports must differ');
  for (const name of ['advertiseWorldPort', 'advertiseRpcPort'] as const) {
    const value = config[name];
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 65535)) throw new Error(`${name} must be null or an integer from 1 to 65535`);
  }
  if (config.publicUrl !== null) {
    let url; try { url = new URL(config.publicUrl); } catch { throw new Error('publicUrl must be an HTTP or HTTPS origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('publicUrl must be an HTTP or HTTPS origin without credentials, path, query or fragment');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('publicUrl requires HTTPS outside loopback development');
    config.publicUrl = url.origin;
  }
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(config.advertiseHost)) throw new Error('Use an IPv4 address or ASCII hostname for advertiseHost');
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,62}$/.test(config.worldName) || /[. ]$/.test(config.worldName)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(config.worldName)) {
    throw new Error('worldName must be a safe Windows cache basename of 1..63 ASCII characters');
  }
  for (const name of ['tokenTtlSeconds', 'sessionTimeoutSeconds', 'maxHttpBodyBytes', 'maxFileBytes', 'maxBufferedBytes'] as const) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) throw new Error(`${name} must be a positive integer`);
  }
  for (const name of ['seedDemo', 'seedDistricts', 'allowRegistration'] as const) if (typeof config[name] !== 'boolean') throw new Error(`${name} must be boolean`);
  if (!['region', 'empty'].includes(config.worldProfile)) throw new Error('worldProfile must be region or empty');
  if (!Number.isSafeInteger(config.maxFrameBytes) || config.maxFrameBytes < 288) throw new Error('maxFrameBytes must be at least 288');
  if (!Number.isInteger(config.keepaliveSeconds) || config.keepaliveSeconds < 0 || config.keepaliveSeconds > 3600) throw new Error('keepaliveSeconds must be 0..3600');
  config.clientDir = path.resolve(config.clientDir);
  if (config.resourcePackDir !== null) config.resourcePackDir = path.resolve(config.resourcePackDir);
  config.dataDir = path.resolve(config.dataDir);
  if (config.surveyImportFile !== null) {
    if (typeof config.surveyImportFile !== 'string' || !config.surveyImportFile.trim()) throw new Error('surveyImportFile must be a nonempty filename or null');
    config.surveyImportFile = path.resolve(config.surveyImportFile);
  }
  return config;
}
