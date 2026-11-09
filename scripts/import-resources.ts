#!/usr/bin/env node
import path from 'node:path';
import { serverRoot } from '../src/paths.js';
import { ResourceStore } from '../src/resources.js';
import { exportResourcePack } from '../src/resource-pack.js';

const root = serverRoot;
const source = path.resolve(process.argv[2] ?? path.join(root, '../wa'));
const destination = path.resolve(process.argv[3] ?? path.join(root, 'resources'));
// Import only admitted resources; saved accounts, logs and native executables stay outside the pack.
const resources = new ResourceStore({ clientDir: source, filterClassDependencies: 'all' });
console.log(JSON.stringify({ destination, ...exportResourcePack(resources, destination) }, null, 2));
