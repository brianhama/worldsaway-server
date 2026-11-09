import type { ResourceProvider } from './resources.js';

/** A lexical observation is deliberately separate from an executable/authorized request contract. */
export interface RequestCandidate {
  resourceId: string | null; requestId: number; replyId: number | null; targetExpression: string;
  line: number; commentedLine: boolean; bodyKind: 'braced' | 'command-substitution' | 'dynamic';
  observation: 'lexical-literal-candidate';
}
export interface HandlerDeclaration {
  id?: number; ids?: readonly number[]; requestIds?: readonly number[]; name?: string; family?: string; admin?: boolean;
  classNumbers?: readonly number[] | null; classes?: readonly number[] | null; replyId?: number | null;
}
export interface NormalizedHandler {
  id: number; name: string; family: string; admin: boolean; classNumbers: readonly number[] | null; replyId: number | null;
}
interface MethodObservation { resourceId: string; messageId: number; requests: RequestCandidate[]; }
interface LibraryObservation { resourceId: string; requests: RequestCandidate[]; }
export interface FeatureContract extends RequestCandidate {
  methodId: number; receiverClass: number | null; implementedId: boolean; status: string; handlers: string[];
}
export interface FeatureClass {
  classNumber: number; name: string; resourceId: string; version: number; family: string; capacity: number;
  instanceSchema: string; structuralStatus: string; methodCount: number; methodResources: string[];
  missingDependencies: string[]; authoredOmissions: string[]; emittedRequestIds: number[]; contracts: FeatureContract[]; behaviorComplete: boolean;
}
export interface BrowserRequestCatalogEntry { id: number; name: string; classes?: readonly number[]; replyId?: number | null; schema: string; }

/**
 * A bounded, static feature ledger for the supplied client resource snapshot.
 * Literal Tcl requests are observations, not an execution trace or server source.
 */
const text = (bytes: Buffer): string => bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('latin1');
const hex = (value: number): string => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

export const CLASS_FAMILIES = Object.freeze({
  core: [0, 1, 2, 3, 4, 10, 11, 20],
  actors: [21, 22, 23, 24, 34, 40, 200, 201, 206],
  inventory: [25, 27, 30, 31, 32, 36, 42, 44, 45, 48, 55, 59, 98, 203],
  economy: [26, 33, 47, 49, 51, 57, 58, 205, 210, 213],
  information: [35, 37, 43, 50, 52, 54, 61],
  travel: [38, 39, 53, 56, 204, 209],
  authoring: [41, 46, 60, 215],
});

function bodyEnd(source: string, offset: number): number | null {
  const opening = source[offset];
  const closing = opening === '{' ? '}' : opening === '[' ? ']' : null;
  if (!closing) return null;
  let depth = 0;
  for (let i = offset; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === opening) depth++;
    else if (source[i] === closing && --depth === 0) return i + 1;
  }
  return null;
}

/** Recover literal `request TARGET NUMBER BODY REPLY` candidates with line refs. */
export function extractRequestCandidates(source: string, resourceId: string | null = null): RequestCandidate[] {
  if (typeof source !== 'string' || source.length > 16 * 1024 * 1024) throw new Error('Invalid script source');
  const result: RequestCandidate[] = [];
  const pattern = /\brequest\s+(\S+)\s+(0x[0-9a-fA-F]+|[0-9]+)(?=\s)/g;
  for (const match of source.matchAll(pattern)) {
    const requestId = Number(match[2]);
    if (!Number.isInteger(requestId) || requestId < 0 || requestId > 65535) continue;
    const bodyStart = match.index + match[0].length + (source.slice(match.index + match[0].length).match(/^\s*/)?.[0].length ?? 0);
    const end = bodyEnd(source, bodyStart);
    const reply = end === null ? null : /^\s+(0x[0-9a-fA-F]+|[0-9]+)(?=\s|$)/.exec(source.slice(end));
    const replyId = reply ? Number(reply[1]) : null;
    const line = source.slice(0, match.index).split('\n').length;
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const prefix = source.slice(lineStart, match.index);
    result.push({ resourceId, requestId, replyId: replyId !== null && replyId <= 65535 ? replyId : null,
      targetExpression: match[1], line, commentedLine: /^\s*#/.test(prefix),
      bodyKind: source[bodyStart] === '{' ? 'braced' : source[bodyStart] === '[' ? 'command-substitution' : 'dynamic',
      observation: 'lexical-literal-candidate' });
  }
  return result;
}

function normalizedHandlers(handlers: readonly HandlerDeclaration[] | undefined): NormalizedHandler[] {
  const output: NormalizedHandler[] = [];
  for (const handler of handlers ?? []) {
    const ids = handler.ids ?? handler.requestIds ?? (handler.id === undefined ? [] : [handler.id]);
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id > 65535) throw new Error('Invalid handler request id');
      output.push({ id, name: handler.name ?? `request-${id}`, family: handler.family ?? 'unspecified', admin: Boolean(handler.admin),
        classNumbers: handler.classNumbers ?? handler.classes ?? null, replyId: handler.replyId ?? null });
    }
  }
  return output;
}

export function buildFeatureCoverage(resources: Pick<ResourceProvider, 'bootstrapResources' | 'summary' | 'resourceProfile'>, { handlers = [], runtimeVerified = false }: { handlers?: readonly HandlerDeclaration[]; runtimeVerified?: boolean } = {}) {
  if (!resources || typeof resources.bootstrapResources !== 'function') throw new TypeError('Resource store required');
  const raw = resources.bootstrapResources();
  if (!Array.isArray(raw) || raw.length > 65536) throw new Error('Resource inventory exceeds ledger bound');
  const map = new Map(raw.map(resource => [resource.id >>> 0, resource]));
  const methods = new Map<number, MethodObservation>(), libraries: LibraryObservation[] = [], schemas: { id: number; resourceId: string; descriptor: string }[] = [];
  for (const resource of raw) {
    const type = (resource.id >>> 16) & 255;
    if (type === 4) schemas.push({ id: resource.id & 65535, resourceId: hex(resource.id), descriptor: text(resource.data) });
    if (type === 5) {
      if (resource.data.length < 8 || resource.data.readUInt16BE(6) !== resource.data.length - 8) throw new Error(`Invalid method ${hex(resource.id)}`);
      const source = text(resource.data.subarray(8));
      methods.set(resource.id, { resourceId: hex(resource.id), messageId: resource.data.readUInt32BE(0),
        requests: extractRequestCandidates(source, hex(resource.id)) });
    } else if (type === 12) libraries.push({ resourceId: hex(resource.id), requests: extractRequestCandidates(text(resource.data), hex(resource.id)) });
  }
  const declared = normalizedHandlers(handlers);
  const classes: FeatureClass[] = [];
  for (const resource of raw.filter(item => ((item.id >>> 16) & 255) === 1).sort((a, b) => a.id - b.id)) {
    const data = resource.data;
    if (data.length < 56) throw new Error('Short class record');
    const classNumber = data.readUInt16BE(0), count = data.readUInt16BE(48), schemaBytes = data.readUInt32BE(52);
    if (56 + count * 4 + schemaBytes !== data.length) throw new Error('Invalid class extent');
    const references = Array.from({ length: count }, (_, i) => data.readUInt32BE(56 + i * 4));
    const classMethods = references.map(id => methods.get(id)).filter((method): method is MethodObservation => method !== undefined);
    const candidates = classMethods.flatMap(method => method.requests.map(candidate => {
      const implementation = declared.filter(handler => handler.id === candidate.requestId);
      const matches = candidate.targetExpression === '$self' ? implementation.filter(handler =>
        handler.classNumbers === null || handler.classNumbers.includes(classNumber)) : [];
      return { ...candidate, methodId: method.messageId, receiverClass: candidate.targetExpression === '$self' ? classNumber : null,
        implementedId: implementation.length !== 0,
        status: candidate.commentedLine ? 'comment-only' : candidate.targetExpression !== '$self' ? 'receiver-unresolved'
          : matches.length ? 'handler-declared' : 'unimplemented',
        handlers: matches.map(handler => handler.name) };
    }));
    const omission = resources.summary?.sceneOverrides?.find(item => item.classNumber === classNumber);
    classes.push({ classNumber, name: text(data.subarray(8, 40)), resourceId: hex(resource.id), version: resource.version,
      family: Object.entries(CLASS_FAMILIES).find(([, numbers]) => numbers.includes(classNumber))?.[0] ?? 'unclassified',
      capacity: data[2], instanceSchema: text(data.subarray(56 + count * 4)),
      structuralStatus: 'schema-present', methodCount: classMethods.length, methodResources: classMethods.map(method => method.resourceId),
      missingDependencies: references.filter(id => !map.has(id)).map(hex), authoredOmissions: (omission?.removed ?? []).map(hex),
      emittedRequestIds: [...new Set(candidates.map(candidate => candidate.requestId))].sort((a, b) => a - b),
      contracts: candidates, behaviorComplete: false });
  }
  const allCandidates = [...methods.values(), ...libraries].flatMap(script => script.requests);
  const uniqueIds = [...new Set(allCandidates.filter(candidate => !candidate.commentedLine).map(candidate => candidate.requestId))].sort((a, b) => a - b);
  const classEmittedIds = [...new Set(classes.flatMap(item => item.contracts).filter(item => !item.commentedLine).map(item => item.requestId))].sort((a, b) => a - b);
  const referencedMethods = new Set(classes.flatMap(item => item.methodResources));
  const unattachedMethods = [...methods.values()].filter(item => !referencedMethods.has(item.resourceId));
  return {
    format: 1, resourceProfile: resources.resourceProfile ?? null,
    summary: { classes: classes.length, methods: methods.size, libraries: libraries.length, messageSchemas: schemas.length,
      literalRequestCandidates: allCandidates.length, uniqueLiteralRequestIds: uniqueIds.length,
      classEmittedRequestIds: classEmittedIds,
      unattachedMethodResourceIds: unattachedMethods.map(item => item.resourceId),
      unattachedMethodRequestIds: [...new Set(unattachedMethods.flatMap(item => item.requests).filter(item => !item.commentedLine).map(item => item.requestId))].sort((a, b) => a - b),
      declaredHandlerIds: new Set(declared.map(handler => handler.id)).size,
      unimplementedLiteralIds: uniqueIds.filter(id => !declared.some(handler => handler.id === id)) },
    classes, handlers: declared, libraries, messageSchemas: schemas, runtimeVerified,
    allOriginalBehaviorImplemented: false,
    limitations: [
      'Every class has structural metadata, but that does not imply every behavior is implemented.',
      'Tcl requests/replies are literal lexical candidates; substitutions, comments and dynamic control flow are not executed.',
      'Some method resources are not directly referenced by a class header; they are not automatically classified as live features or dead code.',
      'A self target only suggests the emitting class is the receiver; runtime identity and authorization still need verification.',
      'Handler declarations are implementation coverage, not proof of Windows UI behavior or equivalence to original server rules.',
      'Original server-side persistence rules, economy policies and privileges cannot be recovered completely from client code alone.',
    ],
  };
}

export function renderFeatureCoverage(coverage: FeatureCoverage): string {
  const lines = ['# Class and feature coverage', '',
    `The active resource snapshot contains **${coverage.summary.classes} classes**, **${coverage.summary.messageSchemas} message schemas**, `
    + `**${coverage.summary.methods} methods**, and **${coverage.summary.libraries} libraries**.`, '',
    'Structural support means the class schema is available to the generic codec and durable object model. '
    + 'It does not establish complete original server behavior. Literal request candidates and declared handlers are tracked separately.', '',
    '| Class | Name | Family | Client methods | Literal request IDs | Missing dependencies |',
    '| ---: | --- | --- | ---: | --- | --- |'];
  for (const row of coverage.classes) lines.push(`| ${row.classNumber} | ${row.name.replaceAll('|', '\\|')} | ${row.family} | ${row.methodCount} | ${row.emittedRequestIds.join(', ') || '—'} | ${[...row.missingDependencies, ...(row.authoredOmissions ?? []).map(id => `${id} (omitted)`)].join(', ') || '—'} |`);
  lines.push('', '## Open request IDs', '', coverage.summary.unimplementedLiteralIds.join(', ') || 'No undeclared literal IDs remain in this static inventory.', '',
    '## Limits', '', ...coverage.limitations.map(item => `- ${item}`), '');
  return lines.join('\n');
}

/** Compare the authored browser catalog with actual request/schema declarations.
 * Receiver lists in the catalog deliberately include inherited methods. A Tcl
 * guard can narrow the effective receiver further (notably Document2730).
 */
export function buildBrowserCoverage(resources: Pick<ResourceProvider, 'bootstrapResources'>, catalog: readonly BrowserRequestCatalogEntry[], handlers: readonly HandlerDeclaration[]) {
  if (!Array.isArray(catalog) || catalog.length > 65536) throw new TypeError('Bounded browser request catalog required');
  const declared = normalizedHandlers(handlers);
  const schemas = new Map(resources.bootstrapResources().filter(resource => (resource.id >>> 16) === 4)
    .map(resource => [resource.id & 65535, text(resource.data)]));
  const ids = new Set<number>();
  const requests = catalog.map((request: BrowserRequestCatalogEntry) => {
    if (!Number.isInteger(request.id) || request.id < 0 || request.id > 65535 || ids.has(request.id)) throw new Error('Invalid or duplicate browser request ID');
    ids.add(request.id);
    const matches = declared.filter(handler => handler.id === request.id);
    const receiverClasses: readonly number[] = request.classes ?? [];
    const restrictedClasses = receiverClasses.filter(number => matches.length && !matches.some(handler => handler.classNumbers === null || handler.classNumbers.includes(number)));
    const conditional = request.id === 2730 && matches.some(handler => handler.classNumbers?.includes(37));
    const requestSchema = schemas.get(request.id);
    return { id: request.id, name: request.name, receiverClasses,
      serverReceiverClasses: matches.some(handler => handler.classNumbers === null) ? null : [...new Set(matches.flatMap(handler => handler.classNumbers ?? []))],
      replyId: request.replyId, schemaPresent: Boolean(requestSchema), schemaMatches: requestSchema === request.schema,
      handlerDeclared: matches.length > 0,
      status: !requestSchema ? 'missing-schema' : !matches.length ? 'missing-handler' : restrictedClasses.length && !conditional ? 'receiver-gap' : conditional ? 'guarded-inherited-method' : 'handler-declared',
      ...(restrictedClasses.length ? { restrictedClasses } : {}),
      ...(conditional ? { receiverCondition: 'Native shared pickup/container methods send request2730 only when the receiver class is Document (37).' } : {}),
      originalRulesVerified: false };
  });
  return { format: 1, summary: { catalogRequests: requests.length, declaredHandlerIds: new Set(declared.map(handler => handler.id)).size,
    missingHandlerIds: requests.filter(request => !request.handlerDeclared).map(request => request.id),
    missingSchemaIds: requests.filter(request => !request.schemaPresent).map(request => request.id),
    schemaMismatchIds: requests.filter(request => !request.schemaMatches).map(request => request.id),
    receiverGapIds: requests.filter(request => request.status === 'receiver-gap').map(request => request.id),
    conditionalReceiverIds: requests.filter(request => request.status === 'guarded-inherited-method').map(request => request.id) },
    requests, allOriginalBehaviorImplemented: false,
    limitations: ['A declared handler is not proof of every original AltAway business rule.',
      'The four staff catalog operations require a persisted administrator role.',
      'NPC and authoring scripts are declarative local policies; arbitrary historical server-side scripts and world databases are not recovered.'] };
}

export function renderBrowserCoverage(coverage: BrowserCoverage): string {
  const summary = coverage.summary;
  return ['# Browser request compatibility', '',
    `WorldsAway.app declares handlers for **${summary.catalogRequests - summary.missingHandlerIds.length} of ${summary.catalogRequests}** browser gameplay requests.`, '',
    `Missing handlers: ${summary.missingHandlerIds.join(', ') || 'none'}. Missing schemas: ${summary.missingSchemaIds.join(', ') || 'none'}. Schema mismatches: ${summary.schemaMismatchIds.join(', ') || 'none'}.`, '',
    'This verifies the recovered protocol surface. Behavioral tests exercise state changes, permissions, persistence, shared sessions and failures. Exact AltAway service rules and historical content remain unverified.', '',
    '| Request | Name | Receiver classes | Status |',
    '| ---: | --- | --- | --- |',
    ...coverage.requests.map(request => `| ${request.id} | ${request.name.replaceAll('|', '\\|')} | ${(request.serverReceiverClasses ?? ['shared']).join(', ')} | ${request.status} |`), '',
    'Request2730 is inherited by many catalog classes, but the native Tcl sends it only for Document37. The server preserves that condition.', '',
    ...coverage.limitations.map(limit => `- ${limit}`), ''].join('\n');
}

/** Report shapes stay synchronized with the builders rather than duplicating every summary field. */
export type FeatureCoverage = ReturnType<typeof buildFeatureCoverage>;
export type BrowserCoverage = ReturnType<typeof buildBrowserCoverage>;
