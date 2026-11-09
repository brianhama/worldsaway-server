#!/usr/bin/env node
/** Prepare the exact Docker inputs, including local assets, without uploading a checkout. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serverRoot } from '../src/paths.js';
import { PackedResourceStore } from '../src/resource-pack.js';

const requiredFiles = [
  'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json',
  'resources/manifest.json', 'resources/payload.bin', 'content/altaway-regions-2026-11-08.json',
];
const sourceDirectories = [['src', '.ts'], ['scripts', '.ts'], ['protocol', '.json']] as const;
const requiredDirectories = ['src', 'scripts', 'protocol', 'resources', 'content'];

function requiredInput(root: string, relative: string, directory = false) {
  const filename = path.join(root, relative);
  let info: fs.Stats;
  try { info = fs.lstatSync(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const hint = relative.startsWith('resources') ? 'Provide a prepared resource pack (npm run resources:import) first.'
      : relative.startsWith('content') ? 'Restore the local survey file from the prepared deployment inputs first.'
        : 'Run this command from a complete server checkout.';
    throw Error(`Missing deployment input: ${relative}. ${hint}`);
  }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw Error(`Deployment input must be a regular ${directory ? 'directory' : 'file'}, without symlinks: ${relative}`);
  }
  return filename;
}

function canonicalDestination(destination: string): string {
  let ancestor = path.resolve(destination);
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw Error(`Cannot resolve deployment destination: ${destination}`);
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function inside(root: string, filename: string) {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export interface DeploymentFile { path: string; bytes: number; sha256: string; }

/** The destination must be a new directory outside the checkout. No remote changes occur. */
export function prepareDeploymentContext(destination: string, sourceRoot = serverRoot) {
  const root = fs.realpathSync(sourceRoot);
  const contextDirectory = canonicalDestination(destination);
  const manifestFile = `${contextDirectory}.manifest.json`;
  if (inside(root, contextDirectory)) throw Error('Deployment destination must be outside the repository. Choose a new directory under /tmp, for example.');
  if (fs.existsSync(contextDirectory) || fs.existsSync(manifestFile)) throw Error(`Deployment destination or its manifest already exists; choose a fresh destination: ${contextDirectory}`);

  for (const relative of requiredDirectories) requiredInput(root, relative, true);
  for (const relative of requiredFiles) requiredInput(root, relative);
  const selected = new Set(requiredFiles);
  const collect = (relative: string, extension: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      // Dotfiles and non-source files are never deployment inputs, even inside source directories.
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw Error(`Symlinks are not allowed in deployment source directories: ${child}`);
      if (entry.isDirectory()) collect(child, extension);
      else if (entry.isFile() && entry.name.endsWith(extension)) selected.add(child);
    }
  };
  for (const [relative, extension] of sourceDirectories) collect(relative, extension);

  let resources: PackedResourceStore;
  try { resources = new PackedResourceStore(path.join(root, 'resources')); }
  catch (error) { throw Error(`Invalid deployment resource pack: ${(error as Error).message}. Restore a valid local resources/ pack before preparing deployment.`); }
  let survey: { schemaVersion?: number; regions?: unknown[]; schemaCatalog?: unknown };
  try { survey = JSON.parse(fs.readFileSync(path.join(root, 'content/altaway-regions-2026-11-08.json'), 'utf8')); }
  catch (error) { throw Error(`Invalid deployment survey JSON: ${(error as Error).message}`); }
  if (survey?.schemaVersion !== 1 || !Array.isArray(survey.regions) || survey.regions.length === 0
      || !survey.schemaCatalog || typeof survey.schemaCatalog !== 'object' || Array.isArray(survey.schemaCatalog)) {
    throw Error('Invalid deployment survey: expected schemaVersion 1, a nonempty regions array and a schemaCatalog object.');
  }

  // Snapshot before creating the destination so missing/unreadable inputs leave no partial context.
  const snapshot = [...selected].sort().map(relative => ({ relative, bytes: fs.readFileSync(requiredInput(root, relative)) }));
  const files: DeploymentFile[] = snapshot.map(({ relative, bytes }) => ({
    path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  const manifest = { format: 'worldsaway-deployment-context-1', files, fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0), resourceProfile: resources.resourceProfile,
    surveyRegions: survey.regions.length };
  fs.mkdirSync(path.dirname(contextDirectory), { recursive: true });
  fs.mkdirSync(contextDirectory, { mode: 0o700 });
  try {
    for (const { relative, bytes } of snapshot) {
      const target = path.join(contextDirectory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    // Keep inventory evidence beside the context, so it is not sent to the image builder.
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.rmSync(contextDirectory, { recursive: true, force: true });
    throw error;
  }
  return { contextDirectory, manifestFile, ...manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] === '--help') {
    console.log('Usage: npm run deploy:prepare -- /absolute/path/to/new/context\nCreates an allowlisted Docker context outside the checkout and an adjacent SHA-256 manifest.');
    if (process.argv[2] !== '--help') process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(prepareDeploymentContext(process.argv[2]), null, 2)); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  }
}
