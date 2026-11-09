import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildBrowserCoverage } from '../dist/src/coverage.js';
import { makeConfig } from '../dist/src/config.js';
import { loadServerResources } from '../dist/src/resource-pack.js';
import { SUPPORTED_REQUESTS as objects } from '../dist/src/object-actions.js';
import { SUPPORTED_REQUESTS as social } from '../dist/src/social-actions.js';
import { SUPPORTED_REQUESTS as builder } from '../dist/src/builder-actions.js';
import { SUPPORTED_REQUESTS as special } from '../dist/src/special-actions.js';
import { SUPPORTED_REQUESTS as system } from '../dist/src/system-actions.js';
const catalog = JSON.parse(readFileSync(new URL('../protocol/browser-requests.json', import.meta.url), 'utf8')).requests;
const handlers = [...objects, ...social, ...builder, ...special, ...system].map(handler => ({ ...handler, classNumbers: handler.classNumbers ?? handler.classes ?? null }));

test('all browser gameplay requests retain exact native schemas and required receiver contracts', () => {
  const resources = loadServerResources(makeConfig());
  const coverage = buildBrowserCoverage(resources, catalog, handlers);
  assert.equal(coverage.summary.catalogRequests, 204);
  assert.deepEqual(coverage.summary.missingHandlerIds, []);
  assert.deepEqual(coverage.summary.missingSchemaIds, []);
  assert.deepEqual(coverage.summary.schemaMismatchIds, []);
  assert.deepEqual(coverage.summary.receiverGapIds, []);
  assert.deepEqual(coverage.summary.conditionalReceiverIds, [2730]);
  assert.equal(coverage.allOriginalBehaviorImplemented, false);
  assert.equal(coverage.requests.find(request => request.id === 2730).status, 'guarded-inherited-method');
});

test('coverage exposes missing schemas, incompatible schemas and receiver gaps independently', () => {
  const schema = Buffer.from('bu1unused;;\0');
  const resources = { bootstrapResources: () => [{ id: 0x0004004c, data: schema }] };
  const missing = buildBrowserCoverage(resources, [{ id: 76, name: 'describe', classes: [23], schema: 'bu1unused;;', replyId: 77 }], []);
  assert.deepEqual(missing.summary.missingHandlerIds, [76]);
  const receiver = buildBrowserCoverage(resources, [{ id: 76, classes: [23], schema: 'bu1unused;;' }], [{ id: 76, classNumbers: [27] }]);
  assert.deepEqual(receiver.summary.receiverGapIds, [76]);
  const wrongSchema = buildBrowserCoverage(resources, [{ id: 76, classes: [23], schema: 'bu2unused;;' }], [{ id: 76, classNumbers: [23] }]);
  assert.deepEqual(wrongSchema.summary.schemaMismatchIds, [76]);
  const absent = buildBrowserCoverage(resources, [{ id: 999, classes: [23], schema: 'bu1unused;;' }], [{ id: 999, classNumbers: [23] }]);
  assert.deepEqual(absent.summary.missingSchemaIds, [999]);
});
