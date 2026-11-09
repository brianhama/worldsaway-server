/** Compile a clean, checked ESM distribution without copying accounts or media. */
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { serverRoot } from '../src/paths.js';

// Clean output prevents a deleted or renamed module from remaining executable.
await rm(path.join(serverRoot, 'dist'), { recursive: true, force: true });
const compiler = path.join(serverRoot, 'node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [compiler, '-p', path.join(serverRoot, 'tsconfig.json')], {
  cwd: serverRoot, stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Built checked TypeScript server and tools into dist/.');
