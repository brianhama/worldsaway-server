#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { serverRoot } from '../src/paths.js';
import type { ServerConfig } from '../src/types.js';
import type { RequestContract } from '../src/action-types.js';
import { resolve } from 'node:path';
import { makeConfig } from '../src/config.js';
import { loadServerResources } from '../src/resource-pack.js';
import { buildFeatureCoverage, renderFeatureCoverage, buildBrowserCoverage, renderBrowserCoverage } from '../src/coverage.js';
import { SUPPORTED_REQUESTS as objects } from '../src/object-actions.js';
import { SUPPORTED_REQUESTS as social } from '../src/social-actions.js';
import { SUPPORTED_REQUESTS as builder } from '../src/builder-actions.js';
import { SUPPORTED_REQUESTS as special } from '../src/special-actions.js';
import { SUPPORTED_REQUESTS as system } from '../src/system-actions.js';

const root = serverRoot;
const argv = process.argv.slice(2);
const options: Partial<ServerConfig> = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--client-dir' && argv[i + 1]) options.clientDir = resolve(argv[++i]);
  else if (argv[i] === '--resource-pack-dir' && argv[i + 1]) options.resourcePackDir = resolve(argv[++i]);
  else throw new Error(`Unknown coverage option: ${argv[i]}`);
}
const resources = loadServerResources(makeConfig(options));
const handlers = ([...objects, ...social, ...builder, ...special, ...system] as readonly RequestContract[])
  .map(handler => ({ ...handler, classNumbers: handler.classNumbers ?? handler.classes ?? null }));
const catalog = JSON.parse(readFileSync(resolve(root, 'protocol/browser-requests.json'), 'utf8')).requests;
const features = buildFeatureCoverage(resources, { handlers });
const browser = buildBrowserCoverage(resources, catalog, handlers);
mkdirSync(resolve(root, 'docs'), { recursive: true });
// Keep structural/native and browser-catalog coverage distinct: neither proves private upstream rules.
for (const entry of [
  { name: 'feature-coverage', value: features, markdown: renderFeatureCoverage(features) },
  { name: 'browser-coverage', value: browser, markdown: renderBrowserCoverage(browser) },
]) {
  writeFileSync(resolve(root, `docs/${entry.name}.json`), JSON.stringify(entry.value, null, 2) + '\n');
  writeFileSync(resolve(root, `docs/${entry.name}.md`), entry.markdown);
}
console.log(JSON.stringify({ classes: features.summary.classes, schemas: features.summary.messageSchemas, ...browser.summary }, null, 2));
if (browser.summary.missingHandlerIds.length || browser.summary.missingSchemaIds.length || browser.summary.schemaMismatchIds.length || browser.summary.receiverGapIds.length) process.exitCode = 1;
