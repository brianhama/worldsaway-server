import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const compiled = path.basename(path.dirname(moduleDirectory)) === 'dist';

/**
 * Resources and mutable data belong to the package, outside generated output.
 * Resolve the same root in a source tsx session and a compiled Node deployment;
 * otherwise a build could accidentally initialize an empty world in dist/data.
 */
export const serverRoot = path.resolve(moduleDirectory, compiled ? '../..' : '..');
