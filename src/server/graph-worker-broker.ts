import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireConnectorAuth, type AuthContext } from '../auth/bearer.js';
import { loadEnv } from '../config/env.js';
import { isLaneAllowed } from '../tools/kb/search-privileged.js';
import { canonicalUri, resolveAwsCredentials, signRequest } from '../search/sigv4.js';

const BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
const REGION = 'us-east-1';
const SOURCE_PREFIX = 'graph-trial/20260908/source-pilot/snapshots';
const STATE_BASE = 'graph-trial/20260908/workers';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const SUBOP = /^subop_[a-f0-9]{64}$/;
const LABEL = /^[a-z0-9][a-z0-9_.:-]{0,95}$/;
const ROOM = Object.freeze({
  finance: Object.freeze({ seat: 'cfo', index: 'finance-cfo-source-docs' }),
  legal_company: Object.freeze({ seat: 'clo', index: 'legal-company' }),
});
const SOURCE_SCHEMA = 'catalog-mention-snapshot-v1';
const MANIFEST_SCHEMA = 'graph-backfill-runner-v1';
const COMPANY_SCHEMA = 'company-metadata-subscription-source-v1';
const AUTH_SCHEMA = 'company-metadata-gateway-authorization-v1';
const ROW_FIELDS = new Set(['path','sha256','sidecar','enriched','enriched_sha256','err',
  'doc_date','entity','entities','named_entities_orgs','named_entities_people',
  'signatories','counterparty']);

type RunRef = {
  ref_version: string; run_id: string; purpose: string; scope: string;
  run_version: string; manifest_sha256: string;
};
type Binding = {
  authenticated_caller: 'cfo' | 'clo'; run: RunRef;
  room: 'finance' | 'legal_company'; source_index: string;
};
type Policy = {
  schema: 'graph-worker-bindings-v1'; policy_version: string;
  expires_at: string; bindings: Binding[];
};
type RawResponse = { status: number; headers: Headers; body: Buffer };
type RawRequest = {
  method: 'GET' | 'PUT'; key: string; headers?: Record<string, string>;
  body?: Buffer; signal: AbortSignal;
};
export interface GraphWorkerBrokerDeps {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<AuthContext | undefined>;
  bindingsJson: () => string;
  now: () => number;
  s3: (request: RawRequest) => Promise<RawResponse>;
}
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}';
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value as Record<string, unknown>).sort().join('\0') ===
      [...keys].sort().join('\0');
}
function bounded(value: unknown, max = 240): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= max && !value.includes('\0');
}
function utc(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function runContent(run: RunRef) {
  return {
    ref_version: run.ref_version, purpose: run.purpose, scope: run.scope,
    run_version: run.run_version, manifest_sha256: run.manifest_sha256,
  };
}
function validRun(value: unknown): value is RunRef {
  if (!exact(value, ['ref_version','run_id','purpose','scope','run_version','manifest_sha256'])) return false;
  const run = value as unknown as RunRef;
  return run.ref_version === 'neptune-trial-active-run-ref-v1' &&
    /^run_[a-f0-9]{64}$/.test(run.run_id) &&
    LABEL.test(run.purpose) && LABEL.test(run.scope) && LABEL.test(run.run_version) &&
    SHA.test(run.manifest_sha256) &&
    run.run_id === 'run_' + digest(canonical(runContent(run)));
}
function sameRun(value: unknown, run: RunRef): boolean {
  return validRun(value) && canonical(value) === canonical(run);
}
function bindingHash(run: RunRef): string {
  return digest(canonical({ purpose: run.purpose, scope: run.scope }));
}
function statePrefix(binding: Binding): string {
  return STATE_BASE + '/' + binding.authenticated_caller + '/' + binding.run.run_id;
}
function parsePolicy(text: string, now: number): Policy | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!exact(value, ['schema','policy_version','expires_at','bindings'])) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== 'graph-worker-bindings-v1' || !bounded(raw.policy_version) ||
      !utc(raw.expires_at) || Date.parse(raw.expires_at) < now + 1000 ||
      !Array.isArray(raw.bindings) || raw.bindings.length < 1 || raw.bindings.length > 8) return null;
  const bindings: Binding[] = [];
  for (const item of raw.bindings) {
    if (!exact(item, ['authenticated_caller','run','room','source_index'])) return null;
    const row = item as Record<string, unknown>;
    if (!validRun(row.run) || typeof row.room !== 'string' ||
        !Object.hasOwn(ROOM, row.room)) return null;
    const room = row.room as keyof typeof ROOM;
    const expected = ROOM[room];
    if (row.authenticated_caller !== expected.seat ||
        row.source_index !== expected.index || (row.run as RunRef).scope !== room) return null;
    bindings.push({
      authenticated_caller: expected.seat, run: row.run as RunRef,
      room, source_index: expected.index,
    });
  }
  const ids = bindings.map((item) => item.authenticated_caller + '\0' + item.run.run_id);
  if (new Set(ids).size !== ids.length) return null;
  return {
    schema: 'graph-worker-bindings-v1',
    policy_version: raw.policy_version as string,
    expires_at: raw.expires_at as string,
    bindings,
  };
}
async function defaultS3(input: RawRequest): Promise<RawResponse> {
  if (input.signal.aborted) throw new Error('deadline');
  const credentials = await resolveAwsCredentials();
  if (!credentials || input.signal.aborted) throw new Error('credentials');
  const host = BUCKET + '.s3.' + REGION + '.amazonaws.com';
  const rawPath = '/' + input.key;
  const body = input.body;
  const extraHeaders = {
    'x-amz-content-sha256': digest(body ?? Buffer.alloc(0)),
    ...(input.headers ?? {}),
  };
  const signed = signRequest({
    method: input.method, host, path: rawPath, region: REGION, service: 's3',
    credentials, ...(body ? { body } : {}), extraHeaders,
  });
  const response = await fetch('https://' + host + canonicalUri(rawPath), {
    method: input.method, headers: signed.headers, ...(body ? { body } : {}),
    signal: input.signal, redirect: 'error',
  });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response_size');
  if (!response.body) return { status: response.status, headers: response.headers, body: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      if (input.signal.aborted) throw new Error('deadline');
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('response_size');
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* bounded request signal owns cancellation */ }
    throw error;
  }
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks, size) };
}
function depsOf(injected?: Partial<GraphWorkerBrokerDeps>): GraphWorkerBrokerDeps {
  return {
    authenticate: injected?.authenticate ?? requireConnectorAuth,
    bindingsJson: injected?.bindingsJson ?? (() => loadEnv().GRAPH_WORKER_BINDINGS_JSON),
    now: injected?.now ?? Date.now,
    s3: injected?.s3 ?? defaultS3,
  };
}
function fail(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ error: code });
}
async function authenticate(
  request: FastifyRequest, reply: FastifyReply, deps: GraphWorkerBrokerDeps,
): Promise<AuthContext | null> {
  if (request.url.includes('?') || typeof request.headers.authorization !== 'string') {
    await fail(reply, 401, 'graph_worker_unauthorized');
    return null;
  }
  const ctx = await deps.authenticate(request, reply);
  if (!ctx) return null;
  if (!ctx.connector_surface || !['cfo','clo'].includes(ctx.caller_agent)) {
    await fail(reply, 403, 'graph_worker_forbidden');
    return null;
  }
  return ctx;
}
async function jsonGet(deps: GraphWorkerBrokerDeps, key: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error('deadline');
  const response = await deps.s3({ method: 'GET', key, signal });
  if (signal.aborted || response.status !== 200 ||
      response.body.length > MAX_RESPONSE_BYTES) throw new Error('read');
  let value: unknown;
  try { value = JSON.parse(response.body.toString('utf8')); }
  catch { throw new Error('corrupt'); }
  return { value, response };
}
async function assertActive(
  deps: GraphWorkerBrokerDeps, binding: Binding, signal: AbortSignal,
): Promise<void> {
  const key = statePrefix(binding) + '/active-runs/' + bindingHash(binding.run) + '.json';
  const loaded = await jsonGet(deps, key, signal);
  const value = loaded.value;
  if (!exact(value, ['schema','state_sha256','state']) ||
      value.schema !== 'neptune-trial-active-run-state-v1' ||
      !SHA.test(String(value.state_sha256 ?? '')) ||
      value.state_sha256 !== digest(canonical(value.state)) ||
      !exact(value.state, ['status','run','superseded_run','tombstone']) ||
      value.state.status !== 'active' || !sameRun(value.state.run, binding.run) ||
      value.state.tombstone !== null ||
      !bounded(loaded.response.headers.get('etag'), 160)) throw new Error('inactive');
}
type ManifestItem = {
  ordinal: number; room: string; document_version_id: string; source_version: string;
  source_path_hash: string; enrichment_row_sha256: string;
  extractor_version: string; retract_event_ids: unknown[];
};
type Manifest = {
  version: string; created_at: string; documents: ManifestItem[];
  manifest_sha256: string;
};
function validManifest(value: unknown, binding: Binding): value is Manifest {
  if (!exact(value, ['version','created_at','documents','manifest_sha256'])) return false;
  const manifest = value as unknown as Manifest;
  if (manifest.version !== MANIFEST_SCHEMA || !utc(manifest.created_at) ||
      manifest.manifest_sha256 !== binding.run.manifest_sha256 ||
      !Array.isArray(manifest.documents) || manifest.documents.length < 1 ||
      manifest.documents.length > 100 ||
      manifest.manifest_sha256 !== digest(canonical({
        version: manifest.version, created_at: manifest.created_at,
        documents: manifest.documents,
      }))) return false;
  return manifest.documents.every((item, ordinal) =>
    exact(item, ['ordinal','room','document_version_id','source_version',
      'source_path_hash','enrichment_row_sha256','extractor_version','retract_event_ids']) &&
    item.ordinal === ordinal && item.room === binding.room &&
    /^docv_[a-f0-9]{64}$/.test(item.document_version_id) &&
    [item.source_version,item.source_path_hash,item.enrichment_row_sha256]
      .every((entry) => SHA.test(entry)) &&
    item.extractor_version === SOURCE_SCHEMA && Array.isArray(item.retract_event_ids));
}
async function loadManifest(
  deps: GraphWorkerBrokerDeps, binding: Binding, signal: AbortSignal,
) {
  const loaded = await jsonGet(
    deps, SOURCE_PREFIX + '/manifests/' + binding.run.manifest_sha256 + '.json', signal,
  );
  if (!validManifest(loaded.value, binding)) throw new Error('manifest');
  return { manifest: loaded.value, response: loaded.response };
}
function normalizePath(value: unknown): string | null {
  if (!bounded(value, 4096) ||
      /^(?:\/|[a-zA-Z]:|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(value)) return null;
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (!parts.length ||
      new Set(['_text','_catalog','_review','_memory','_state','_archive'])
        .has(parts[0].toLowerCase())) return null;
  return parts.join('/');
}
function projectionSha(row: Record<string, unknown>): string {
  const pinned: Record<string, unknown> = {
    path: row.path, sha256: row.sha256, sidecar: row.sidecar,
    enriched: row.enriched, enriched_sha256: row.enriched_sha256,
    err: row.err ?? null, doc_date: row.doc_date ?? null,
  };
  for (const field of ['entity','entities','named_entities_orgs','named_entities_people',
    'signatories','counterparty']) pinned[field] = row[field] ?? null;
  return digest(canonical(pinned));
}
function validRow(value: unknown, binding: Binding, item: ManifestItem): value is {
  schema: string; room: string; document_version_id: string; row: Record<string, unknown>;
} {
  if (!exact(value, ['schema','room','document_version_id','row'])) return false;
  const saved = value as Record<string, unknown>;
  if (saved.schema !== SOURCE_SCHEMA || saved.room !== binding.room ||
      saved.document_version_id !== item.document_version_id ||
      !saved.row || Object.getPrototypeOf(saved.row) !== Object.prototype) return false;
  const row = saved.row as Record<string, unknown>;
  if (Object.keys(row).some((key) => !ROW_FIELDS.has(key))) return false;
  const path = normalizePath(row.path);
  if (!path || !SHA.test(String(row.sha256 ?? '')) || row.sidecar !== true ||
      row.enriched !== true || row.enriched_sha256 !== row.sha256 || row.err ||
      row.sha256 !== item.source_version || digest(path) !== item.source_path_hash ||
      projectionSha(row) !== item.enrichment_row_sha256) return false;
  const authority = {
    source_room: binding.room, source_index: binding.source_index,
    policy_ref: 'gateway:isLaneAllowed',
  };
  const identity = {
    authority, source_path_hash: item.source_path_hash, source_version: item.source_version,
  };
  return item.document_version_id ===
    'docv_' + digest('graph-assertion-v2\0' + canonical(identity));
}
async function loadRow(
  deps: GraphWorkerBrokerDeps, binding: Binding, item: ManifestItem, signal: AbortSignal,
) {
  const loaded = await jsonGet(
    deps, SOURCE_PREFIX + '/rows/' + binding.room + '/' + item.enrichment_row_sha256 + '.json',
    signal,
  );
  if (!validRow(loaded.value, binding, item)) throw new Error('row');
  return loaded as { value: {
    schema: string; room: string; document_version_id: string;
    row: Record<string, unknown>;
  }; response: RawResponse };
}
function metadataInputSha(
  row: Record<string, unknown>, item: ManifestItem, room: string,
): string | null {
  const selected: Record<string, unknown> = {};
  for (const field of ['doc_date','entity','counterparty']) {
    if (!Object.hasOwn(row, field)) continue;
    const value = row[field];
    if (value !== null && (typeof value !== 'string' || value.length > 4096 ||
        value.includes('\0'))) return null;
    selected[field] = value;
  }
  for (const field of ['entities','named_entities_orgs','named_entities_people','signatories']) {
    if (!Object.hasOwn(row, field)) continue;
    const value = row[field];
    if (value !== null && (!Array.isArray(value) || value.length > 256 ||
        value.some((entry) => typeof entry !== 'string' || entry.length > 4096 ||
          entry.includes('\0')))) return null;
    selected[field] = value;
  }
  const text = canonical(selected);
  if (text.length > 16_000 || Buffer.byteLength(text) > 16 * 1024) return null;
  return digest(canonical({ text, document_version_id: item.document_version_id, room }));
}
function sourceId(binding: Binding, item: ManifestItem): string {
  return 'companymeta_' + digest(canonical({
    schema: COMPANY_SCHEMA, run_id: binding.run.run_id,
    manifest_sha256: binding.run.manifest_sha256, document_ordinal: item.ordinal,
    document_version_id: item.document_version_id, source_version: item.source_version,
    room: binding.room, purpose: binding.run.purpose,
  }));
}
function findItem(manifest: Manifest, source: Record<string, unknown>): ManifestItem | null {
  if (!Number.isSafeInteger(source.document_ordinal) ||
      (source.document_ordinal as number) < 0) return null;
  const item = manifest.documents[source.document_ordinal as number];
  return item && item.document_version_id === source.document_version_id &&
    item.source_version === source.source_version ? item : null;
}
function parseAuthorization(
  value: unknown, ctx: AuthContext, binding: Binding,
): { request: Record<string, unknown>; source: Record<string, unknown> } | null {
  if (!exact(value, ['schema','phase','authenticated_caller','run','source'])) return null;
  const request = value as Record<string, unknown>;
  if (request.schema !== AUTH_SCHEMA ||
      !['before_metadata_read','model_source_access'].includes(String(request.phase)) ||
      request.authenticated_caller !== ctx.caller_agent ||
      !sameRun(request.run, binding.run) ||
      !exact(request.source, ['source_id','subscription_source_version','room','source_index',
        'manifest_sha256','document_ordinal','document_version_id','source_version','purpose',
        'canonical_input_sha256'])) return null;
  const source = request.source as Record<string, unknown>;
  if (source.room !== binding.room || source.source_index !== binding.source_index ||
      source.manifest_sha256 !== binding.run.manifest_sha256 ||
      source.purpose !== binding.run.purpose ||
      !/^companymeta_[a-f0-9]{64}$/.test(String(source.source_id)) ||
      !/^docv_[a-f0-9]{64}$/.test(String(source.subscription_source_version)) ||
      !/^docv_[a-f0-9]{64}$/.test(String(source.document_version_id)) ||
      !SHA.test(String(source.source_version))) return null;
  if (request.phase === 'before_metadata_read'
    ? source.canonical_input_sha256 !== null
    : !SHA.test(String(source.canonical_input_sha256))) return null;
  return { request, source };
}
function decisionRef(policyVersion: string, request: unknown): string {
  return 'gateway_' + digest(canonical({
    policy_version: policyVersion, request_sha256: digest(canonical(request)),
  }));
}
const SPEC_KEYS = ['authorization_ref','authorization_sha256','extractor_bundle_sha256',
  'extractor_version','input_sha256','login_before_model_contract','model','provider',
  'purpose','source_id','source_version'];
const OP_KEYS = ['operation_id','spec','state','claim_token','revision'];
const OP_STATE_KEYS: Record<string, readonly string[]> = {
  claimed: OP_KEYS,
  dispatched: [...OP_KEYS, 'dispatched_at'],
  cancelled: [...OP_KEYS, 'outcome_code'],
  unknown: [...OP_KEYS, 'dispatched_at', 'outcome_code'],
  paused: [...OP_KEYS, 'dispatched_at', 'outcome_code'],
  denied: [...OP_KEYS, 'dispatched_at', 'outcome_code'],
  complete: [...OP_KEYS, 'dispatched_at', 'result_sha256'],
};
const STATES = new Set(['claimed','dispatched','unknown','paused','denied','cancelled','complete']);
const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  claimed: new Set(['dispatched','cancelled']),
  dispatched: new Set(['unknown','paused','denied','complete']),
  unknown: new Set(), paused: new Set(), denied: new Set(),
  cancelled: new Set(), complete: new Set(),
};
function operationItem(
  operation: unknown, manifest: Manifest, binding: Binding, policyVersion: string,
): ManifestItem | null {
  if (!operation || typeof operation !== 'object') return null;
  const value = operation as Record<string, unknown>;
  const state = String(value.state);
  if (!Object.hasOwn(OP_STATE_KEYS, state) || !exact(value, OP_STATE_KEYS[state]) ||
      !SUBOP.test(String(value.operation_id)) ||
      !exact(value.spec, SPEC_KEYS) || !STATES.has(state) ||
      !bounded(value.claim_token, 128) || (value.claim_token as string).length < 16 ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return null;
  const spec = value.spec as Record<string, unknown>;
  if (value.operation_id !== 'subop_' + digest(canonical(spec)) ||
      ![spec.authorization_sha256,spec.extractor_bundle_sha256,spec.input_sha256]
        .every((entry) => SHA.test(String(entry))) ||
      spec.login_before_model_contract !== 'codex-login-status-before-model-exec-v1' ||
      spec.provider !== 'codex-chatgpt-subscription' ||
      ![spec.authorization_ref,spec.extractor_version,spec.model,spec.purpose,
        spec.source_id,spec.source_version].every((entry) => bounded(entry)) ||
      spec.purpose !== binding.run.purpose) return null;
  if (Object.hasOwn(value, 'dispatched_at') && !utc(value.dispatched_at)) return null;
  if (Object.hasOwn(value, 'outcome_code') && !bounded(value.outcome_code)) return null;
  if (Object.hasOwn(value, 'result_sha256') && !SHA.test(String(value.result_sha256))) return null;
  const item = manifest.documents.find((candidate) =>
    sourceId(binding, candidate) === spec.source_id &&
    candidate.document_version_id === spec.source_version);
  if (!item) return null;
  const request = {
    schema: AUTH_SCHEMA, phase: 'model_source_access',
    authenticated_caller: binding.authenticated_caller, run: binding.run,
    source: {
      source_id: spec.source_id, subscription_source_version: spec.source_version,
      room: binding.room, source_index: binding.source_index,
      manifest_sha256: binding.run.manifest_sha256, document_ordinal: item.ordinal,
      document_version_id: item.document_version_id, source_version: item.source_version,
      purpose: binding.run.purpose, canonical_input_sha256: spec.input_sha256,
    },
  };
  const ref = decisionRef(policyVersion, request);
  return spec.authorization_ref === ref &&
    spec.authorization_sha256 === digest(canonical({ authorized: true, decision_ref: ref }))
    ? item : null;
}
function parseOperationEnvelope(
  value: unknown, id: string, manifest: Manifest, binding: Binding, policyVersion: string,
): { envelope: Record<string, unknown>; operation: Record<string, unknown>; item: ManifestItem } | null {
  if (!exact(value, ['schema','operation_id','operation_sha256','operation']) ||
      value.schema !== 'subscription-model-operation-v1' || value.operation_id !== id ||
      value.operation_sha256 !== digest(canonical(value.operation))) return null;
  const operation = value.operation as Record<string, unknown>;
  if (operation.operation_id !== id) return null;
  const item = operationItem(operation, manifest, binding, policyVersion);
  return item ? { envelope: value, operation, item } : null;
}
function parseResultEnvelope(value: unknown, id: string) {
  if (!exact(value, ['schema','operation_id','result_sha256','result']) ||
      value.schema !== 'subscription-model-result-v1' || value.operation_id !== id ||
      value.result_sha256 !== digest(canonical(value.result)) ||
      !exact(value.result, ['operation_id','spec_sha256','output']) ||
      value.result.operation_id !== id || !SHA.test(String(value.result.spec_sha256)) ||
      !value.result.output || typeof value.result.output !== 'object') return null;
  return value as Record<string, unknown>;
}
async function currentOperationSource(
  deps: GraphWorkerBrokerDeps, binding: Binding, operation: Record<string, unknown>,
  item: ManifestItem, signal: AbortSignal,
): Promise<boolean> {
  const loaded = await loadRow(deps, binding, item, signal);
  const actual = metadataInputSha(loaded.value.row, item, binding.room);
  return actual !== null && actual === (operation.spec as Record<string, unknown>).input_sha256;
}
function legalTransition(
  prior: Record<string, unknown>, next: Record<string, unknown>, ifMatch: string, priorEtag: string,
): boolean {
  return ifMatch === priorEtag &&
    canonical(prior.spec) === canonical(next.spec) &&
    prior.operation_id === next.operation_id &&
    prior.claim_token === next.claim_token &&
    next.revision === (prior.revision as number) + 1 &&
    TRANSITIONS[String(prior.state)]?.has(String(next.state)) === true &&
    (!Object.hasOwn(prior, 'dispatched_at') || prior.dispatched_at === next.dispatched_at) &&
    (!Object.hasOwn(prior, 'outcome_code') || prior.outcome_code === next.outcome_code) &&
    (!Object.hasOwn(prior, 'result_sha256') || prior.result_sha256 === next.result_sha256);
}
async function readStoredOperation(
  deps: GraphWorkerBrokerDeps, binding: Binding, id: string, manifest: Manifest,
  policyVersion: string, signal: AbortSignal,
) {
  const key = statePrefix(binding) + '/subscription-jobs/operations/' + id + '.json';
  const response = await deps.s3({ method: 'GET', key, signal });
  if (response.status !== 200 || response.body.length > MAX_RESPONSE_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(response.body.toString('utf8')); } catch { return null; }
  const parsed = parseOperationEnvelope(value, id, manifest, binding, policyVersion);
  const etag = response.headers.get('etag');
  if (!parsed || !bounded(etag, 160) ||
      !(await currentOperationSource(deps, binding, parsed.operation, parsed.item, signal))) return null;
  return { ...parsed, etag, response };
}
export function registerGraphWorkerBrokerRoutes(
  app: FastifyInstance, injected?: Partial<GraphWorkerBrokerDeps>,
): void {
  const deps = depsOf(injected);
  async function context(request: FastifyRequest, reply: FastifyReply, runId: string) {
    const ctx = await authenticate(request, reply, deps);
    if (!ctx) return null;
    const policy = parsePolicy(deps.bindingsJson(), deps.now());
    if (!policy) { await fail(reply, 503, 'graph_worker_unconfigured'); return null; }
    const binding = policy.bindings.find((item) =>
      item.authenticated_caller === ctx.caller_agent && item.run.run_id === runId);
    if (!binding || ROOM[binding.room].seat !== ctx.caller_agent ||
        !isLaneAllowed(binding.source_index, ctx.caller_agent)) {
      await fail(reply, 403, 'graph_worker_forbidden');
      return null;
    }
    return { ctx, policy, binding, signal: AbortSignal.timeout(15_000) };
  }
  async function recheck(control: {
    policy: Policy; binding: Binding; signal: AbortSignal;
  }): Promise<void> {
    const current = parsePolicy(deps.bindingsJson(), deps.now());
    if (!current || canonical(current) !== canonical(control.policy)) throw new Error('policy_changed');
    await assertActive(deps, control.binding, control.signal);
  }

  app.post('/graph-worker/v1/control', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!exact(request.body, ['run','action']) || !validRun(request.body.run) ||
        !LABEL.test(String(request.body.action))) {
      return fail(reply, 400, 'graph_worker_request_invalid');
    }
    const c = await context(request, reply, request.body.run.run_id);
    if (!c) return;
    if (!sameRun(request.body.run, c.binding.run)) return fail(reply, 403, 'graph_worker_forbidden');
    try { await assertActive(deps, c.binding, c.signal); }
    catch { return fail(reply, 503, 'graph_worker_control_unavailable'); }
    return reply.send({
      allowed: true, run_id: c.binding.run.run_id,
      authority: { allowed: true },
      active: { allowed: true, active_run_id: c.binding.run.run_id },
    });
  });

  app.post('/graph-worker/v1/authorize', {
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const runValue = (request.body as Record<string, unknown> | undefined)?.run;
    const runId = (runValue as Record<string, unknown> | undefined)?.run_id;
    if (typeof runId !== 'string') return fail(reply, 400, 'graph_worker_request_invalid');
    const c = await context(request, reply, runId);
    if (!c) return;
    const parsed = parseAuthorization(request.body, c.ctx, c.binding);
    if (!parsed) return fail(reply, 403, 'graph_worker_forbidden');
    try {
      await assertActive(deps, c.binding, c.signal);
      const { manifest } = await loadManifest(deps, c.binding, c.signal);
      const item = findItem(manifest, parsed.source);
      if (!item || sourceId(c.binding, item) !== parsed.source.source_id ||
          item.document_version_id !== parsed.source.subscription_source_version) {
        return fail(reply, 403, 'graph_worker_forbidden');
      }
      if (parsed.request.phase === 'model_source_access') {
        const loaded = await loadRow(deps, c.binding, item, c.signal);
        const inputSha = metadataInputSha(loaded.value.row, item, c.binding.room);
        if (!inputSha || inputSha !== parsed.source.canonical_input_sha256) {
          return fail(reply, 403, 'graph_worker_forbidden');
        }
      }
      await recheck(c);
      const requestSha = digest(canonical(parsed.request));
      const ref = decisionRef(c.policy.policy_version, parsed.request);
      const expiresAt = new Date(Math.min(
        Date.parse(c.policy.expires_at), deps.now() + 60_000,
      )).toISOString();
      return reply.send({
        allowed: true, authorization_request_sha256: requestSha,
        decision_ref: ref, expires_at: expiresAt,
        policy_version: c.policy.policy_version,
        provenance: {
          allowed_roles: [c.binding.authenticated_caller],
          authenticated_caller: c.ctx.caller_agent,
          decision_source: 'authenticated_gateway',
        },
      });
    } catch {
      return fail(reply, 503, 'graph_worker_authorization_unavailable');
    }
  });

  app.get('/graph-worker/v1/source/:runId/manifests/:sha.json', async (request, reply) => {
    const params = request.params as { runId: string; sha: string };
    const c = await context(request, reply, params.runId);
    if (!c) return;
    if (params.sha !== c.binding.run.manifest_sha256) {
      return fail(reply, 403, 'graph_worker_forbidden');
    }
    try {
      await assertActive(deps, c.binding, c.signal);
      const loaded = await loadManifest(deps, c.binding, c.signal);
      await recheck(c);
      const etag = loaded.response.headers.get('etag');
      if (etag) reply.header('etag', etag);
      return reply.type('application/json').send(loaded.response.body);
    } catch {
      return fail(reply, 503, 'graph_worker_source_unavailable');
    }
  });

  app.get('/graph-worker/v1/source/:runId/rows/:room/:sha.json', async (request, reply) => {
    const params = request.params as { runId: string; room: string; sha: string };
    const c = await context(request, reply, params.runId);
    if (!c) return;
    if (params.room !== c.binding.room || !SHA.test(params.sha)) {
      return fail(reply, 403, 'graph_worker_forbidden');
    }
    try {
      await assertActive(deps, c.binding, c.signal);
      const { manifest } = await loadManifest(deps, c.binding, c.signal);
      const item = manifest.documents.find((candidate) =>
        candidate.enrichment_row_sha256 === params.sha);
      if (!item) return fail(reply, 403, 'graph_worker_forbidden');
      const loaded = await loadRow(deps, c.binding, item, c.signal);
      await recheck(c);
      const etag = loaded.response.headers.get('etag');
      if (etag) reply.header('etag', etag);
      return reply.type('application/json').send(loaded.response.body);
    } catch {
      return fail(reply, 503, 'graph_worker_source_unavailable');
    }
  });

  async function state(request: FastifyRequest, reply: FastifyReply) {
    const params = request.params as { runId: string; artifact: string; id: string };
    if (!['operations','results'].includes(params.artifact) || !SUBOP.test(params.id)) {
      return fail(reply, 404, 'graph_worker_state_not_found');
    }
    const c = await context(request, reply, params.runId);
    if (!c) return;
    const key = statePrefix(c.binding) + '/subscription-jobs/' +
      params.artifact + '/' + params.id + '.json';
    try {
      await assertActive(deps, c.binding, c.signal);
      const { manifest } = await loadManifest(deps, c.binding, c.signal);
      if (request.method === 'GET') {
        if (params.artifact === 'operations') {
          const stored = await readStoredOperation(
            deps, c.binding, params.id, manifest, c.policy.policy_version, c.signal,
          );
          if (!stored) {
            const absent = await deps.s3({ method: 'GET', key, signal: c.signal });
            return absent.status === 404 ? reply.code(404).send()
              : fail(reply, 503, 'graph_worker_state_unavailable');
          }
          await recheck(c);
          reply.header('etag', stored.etag);
          return reply.type('application/json').send(stored.response.body);
        }
        const resultResponse = await deps.s3({ method: 'GET', key, signal: c.signal });
        if (resultResponse.status === 404) return reply.code(404).send();
        if (resultResponse.status !== 200 || resultResponse.body.length > MAX_RESPONSE_BYTES) {
          return fail(reply, 503, 'graph_worker_state_unavailable');
        }
        let resultValue: unknown;
        try { resultValue = JSON.parse(resultResponse.body.toString('utf8')); }
        catch { return fail(reply, 503, 'graph_worker_state_unavailable'); }
        const result = parseResultEnvelope(resultValue, params.id);
        const operation = await readStoredOperation(
          deps, c.binding, params.id, manifest, c.policy.policy_version, c.signal,
        );
        if (!result || !operation ||
            (result.result as Record<string, unknown>).spec_sha256 !==
              digest(canonical(operation.operation.spec))) {
          return fail(reply, 503, 'graph_worker_state_unavailable');
        }
        await recheck(c);
        const resultEtag = resultResponse.headers.get('etag');
        if (!bounded(resultEtag, 160)) return fail(reply, 503, 'graph_worker_state_unavailable');
        reply.header('etag', resultEtag);
        return reply.type('application/json').send(resultResponse.body);
      }

      const raw = (request as FastifyRequest & { rawBody?: string }).rawBody;
      if (typeof raw !== 'string' || Buffer.byteLength(raw) < 2 ||
          Buffer.byteLength(raw) > MAX_REQUEST_BYTES ||
          !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return fail(reply, 400, 'graph_worker_state_invalid');
      }
      const ifNone = request.headers['if-none-match'];
      const ifMatch = request.headers['if-match'];
      const create = ifNone === '*' && ifMatch === undefined;
      const update = params.artifact === 'operations' && ifNone === undefined &&
        typeof ifMatch === 'string' && /^"[^"\r\n]{1,156}"$/.test(ifMatch);
      if (!create && !update) return fail(reply, 400, 'graph_worker_precondition_required');
      let value: unknown;
      try { value = JSON.parse(raw); }
      catch { return fail(reply, 400, 'graph_worker_state_invalid'); }
      if (canonical(value) !== raw) return fail(reply, 403, 'graph_worker_state_invalid');

      if (params.artifact === 'operations') {
        const incoming = parseOperationEnvelope(
          value, params.id, manifest, c.binding, c.policy.policy_version,
        );
        if (!incoming || !(await currentOperationSource(
          deps, c.binding, incoming.operation, incoming.item, c.signal,
        ))) return fail(reply, 403, 'graph_worker_state_invalid');
        if (create) {
          if (incoming.operation.state !== 'claimed' || incoming.operation.revision !== 0 ||
              Object.keys(incoming.operation).some((entry) => !OP_KEYS.includes(entry))) {
            return fail(reply, 403, 'graph_worker_state_invalid');
          }
        } else {
          const prior = await readStoredOperation(
            deps, c.binding, params.id, manifest, c.policy.policy_version, c.signal,
          );
          if (!prior || !legalTransition(
            prior.operation, incoming.operation, ifMatch as string, prior.etag,
          )) return fail(reply, 412, 'graph_worker_state_conflict');
        }
      } else {
        if (!create) return fail(reply, 400, 'graph_worker_precondition_required');
        const result = parseResultEnvelope(value, params.id);
        const operation = await readStoredOperation(
          deps, c.binding, params.id, manifest, c.policy.policy_version, c.signal,
        );
        if (!result || !operation ||
            !['dispatched','complete'].includes(String(operation.operation.state)) ||
            (result.result as Record<string, unknown>).spec_sha256 !==
              digest(canonical(operation.operation.spec))) {
          return fail(reply, 403, 'graph_worker_state_invalid');
        }
      }

      await recheck(c);
      const headers = {
        'content-type': 'application/json',
        ...(create ? { 'if-none-match': '*' } : { 'if-match': ifMatch as string }),
      };
      const upstream = await deps.s3({
        method: 'PUT', key, headers, body: Buffer.from(raw), signal: c.signal,
      });
      if (upstream.status === 409 || upstream.status === 412) {
        return reply.code(upstream.status).send();
      }
      if (![200,201].includes(upstream.status)) {
        return fail(reply, upstream.status === 403 ? 403 : 503, 'graph_worker_state_unavailable');
      }
      const etag = upstream.headers.get('etag');
      if (etag) reply.header('etag', etag);
      return reply.code(upstream.status).send();
    } catch {
      return fail(reply, 503, 'graph_worker_state_unavailable');
    }
  }  app.get('/graph-worker/v1/state/:runId/:artifact/:id.json', state);
  app.put('/graph-worker/v1/state/:runId/:artifact/:id.json', {
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
  }, state);
}

export const graphWorkerBrokerTest = {
  BUCKET, SOURCE_PREFIX, STATE_BASE, canonical, digest, parsePolicy,
  bindingHash, statePrefix, validManifest, validRow, sourceId, metadataInputSha,
};
