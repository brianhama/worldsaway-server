#!/usr/bin/env node
/** Prepare a single Railway volume, then run the game as its unprivileged owner. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serverRoot } from '../src/paths.js';
import { main } from '../src/cli.js';

export interface HostedStorageOptions { dataDir: string; recoverStaleLock?: boolean }
export function prepareHostedStorage({ dataDir, recoverStaleLock = false }: HostedStorageOptions): string {
  const directory = path.resolve(dataDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Hosted data must be a real directory');
  const lockPath = path.join(directory, 'server.lock');
  if (recoverStaleLock && fs.existsSync(lockPath)) {
    const contents = fs.readFileSync(lockPath, 'utf8').trim();
    if (!/^\d+$/.test(contents)) throw new Error('Unknown server lock format; preserve the volume for inspection');
    const pid = Number(contents);
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid server lock owner');
    if (pid !== process.pid) {
      try { process.kill(pid, 0); throw new Error('Another process still owns the world data'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    fs.unlinkSync(lockPath);
  }
  if (process.getuid?.() === 0) {
    fs.chownSync(directory, 1000, 1000);
    for (const name of ['accounts.json', 'world.json', 'world.json.bak']) {
      const filename = path.join(directory, name);
      if (!fs.existsSync(filename)) continue;
      const info = fs.lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Hosted world state must contain regular files');
      fs.chownSync(filename, 1000, 1000);
    }
    process.setgroups!([]); process.setgid!(1000); process.setuid!(1000);
  }
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const directory = prepareHostedStorage({ dataDir: process.env.WORLDSAWAY_DATA_DIR ?? path.join(serverRoot, 'data'),
      // Enable only for the explicitly configured single-replica, exclusive volume deployment.
      recoverStaleLock: process.env.WORLDSAWAY_RECOVER_STALE_LOCK === 'true' });
    process.env.WORLDSAWAY_DATA_DIR = directory;
    await main(process.argv.slice(2));
  } catch (error) { console.error(`WorldsAway.app: ${(error instanceof Error ? error.message : String(error))}`); process.exitCode = 1; }
}
