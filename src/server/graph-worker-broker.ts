import { createHash, createPublicKey, verify } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireConnectorAuth, type AuthContext } from '../auth/bearer.js';
import { loadEnv } from '../config/env.js';
import { isLaneAllowed } from '../tools/kb/search-privileged.js';
import { canonicalUri, resolveAwsCredentials, signRequest } from '../search/sigv4.js';
import {
  createCfoTextSnapshotReader,
  type CfoTextSnapshotResult,
  type CfoTextSource,
} from '../graph/cfo-text-snapshot.js';
import { createCfoTextPreparationController } from '../graph/cfo-text-preparation.js';
import {
  isSubscriptionReviewOperationSpec,
  SUBSCRIPTION_REVIEW_PROVIDER,
  validSubscriptionReviewOutput,
} from './subscription-review-broker.js';

const BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
const REGION = 'us-east-1';
const SOURCE_PREFIX = 'graph-trial/20260908/source-pilot/snapshots';
const STATE_BASE = 'graph-trial/20260908/workers';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const CFO_TEXT_CANARY_MAX_BYTES = 256 * 1024;
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
const PREPARED_AUTH_SCHEMA = 'company-prepared-text-gateway-authorization-v1';
const PREPARED_BINDING_SCHEMA = 'cfo-prepared-chunk-binding-v1';
const PREPARED_SOURCE_SCHEMA = 'cfo-prepared-chunk-source-v1';
const PREPARED_SOURCE_ID = /^cfotext_[a-f0-9]{64}$/;
const PREPARED_SOURCE_VERSION = /^txtchunk_[a-f0-9]{64}$/;
const PREPARED_SNAPSHOT_ID = /^txtsnap_[a-f0-9]{64}$/;
const IDENTITY_REGISTRY_SCHEMA = 'source-identity-registry-v1';
const IDENTITY_AUTHORITY_SCHEMA = 'authenticated-structured-identity-authority-v1';
const IDENTITY_PAGE_SCHEMA = 'structured-identity-source-page-v1';
const IDENTITY_AUTH_SCHEMA = 'source-identity-registry-authorization-v1';
const MAX_IDENTITY_ENVELOPE_BYTES = 256 * 1024;
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
type PreparedBinding = {
  schema: 'cfo-prepared-chunk-binding-v1';
  run_id: string;
  room: 'finance';
  source_index: 'finance-cfo-source-docs';
  catalog_manifest_sha256: string;
  document_ordinal: number;
  source_document_version: string;
  catalog_source_sha256: string;
  snapshot_id: string;
  prepared_manifest_sha256: string;
  sidecar_content_sha256: string;
  chunk_ordinal: number;
  chunk_sha256: string;
};
type OperationSource =
  | { kind: 'metadata'; item: ManifestItem }
  | { kind: 'prepared'; item: ManifestItem; sourceBinding: PreparedBinding };
type RawResponse = { status: number; headers: Headers; body: Buffer };
type RawRequest = {
  method: 'GET' | 'PUT'; key: string; headers?: Record<string, string>;
  body?: Buffer; signal: AbortSignal;
};
type IdentityAuthority = {
  schema: 'authenticated-structured-identity-authority-v1';
  adapter_id: string; source_system: string; scope: 'cfo'; version: string;
};
type IdentityRegistryConfig = {
  registry_id: string;
  authority: IdentityAuthority;
  binding: Binding;
  /** Deployment-owned Ed25519 public key. Its private counterpart never enters this process. */
  public_key: string | Buffer;
  source: {
    page: (request: { cursor: string | null; source_version: string | null; page_size: number },
      options: { signal: AbortSignal }) => Promise<unknown>;
    current: (request: { source_version: string }, options: { signal: AbortSignal }) => Promise<boolean>;
  };
  /** The store is the current revocation authority. Immutable signatures alone do not authorize old pins. */
  snapshots: {
    publish: (request: { registry_id: string; version: string; envelope: unknown },
      options: { signal: AbortSignal }) => Promise<boolean>;
    read: (request: { registry_id: string; version: string }, options: { signal: AbortSignal }) =>
      Promise<{ status: 'active'; envelope: unknown } | { status: 'revoked' | 'missing' }>;
  };
};
type IdentityRegistryResolver = {
  resolve: (request: { registry_id: string; caller: AuthContext }, options: { signal: AbortSignal }) =>
    Promise<IdentityRegistryConfig | null>;
};
export interface GraphWorkerBrokerDeps {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<AuthContext | undefined>;
  bindingsJson: () => string;
  now: () => number;
  s3: (request: RawRequest) => Promise<RawResponse>;
  readCfoText: (
    source: CfoTextSource, callerContext: AuthContext, signal: AbortSignal,
  ) => Promise<CfoTextSnapshotResult>;
  /** A dark cohort can supply a binding only from its durable server-issued receipt. */
  resolveCohortBinding: (ctx: AuthContext, runId: string, signal: AbortSignal) => Promise<{ policy: Policy; binding: Binding } | null>;
  /**
   * Optional, deployment-owned bridge for source-version-bound explicit identity IDs.
   * Absent configuration intentionally leaves identity-registry routes unavailable.
   */
  identityRegistry?: IdentityRegistryResolver;
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
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('deadline'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('deadline'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
async function boundedCancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => reader.cancel()).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function defaultS3(input: RawRequest): Promise<RawResponse> {
  if (input.signal.aborted) throw new Error('deadline');
  const credentials = await abortable(resolveAwsCredentials(), input.signal);
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
  const response = await abortable(fetch('https://' + host + canonicalUri(rawPath), {
    method: input.method, headers: signed.headers, ...(body ? { body } : {}),
    signal: input.signal, redirect: 'error',
  }), input.signal);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    if (response.body) await boundedCancel(response.body.getReader());
    throw new Error('response_size');
  }
  if (!response.body) return { status: response.status, headers: response.headers, body: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), input.signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('response_size');
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    await boundedCancel(reader);
    throw error;
  }
  if (input.signal.aborted) throw new Error('deadline');
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks, size) };
}
function depsOf(injected?: Partial<GraphWorkerBrokerDeps>): GraphWorkerBrokerDeps {
  const s3 = injected?.s3 ?? defaultS3;
  const resolveCohortBinding = injected?.resolveCohortBinding ?? (async (ctx, runId, signal) => {
    // The controller owns the durable control-pointer schema. Keep this bridge a
    // delegation so a broker deployment cannot accidentally accept a stale or
    // weaker receipt format.
    const controller = await import('./graph-catalog-controller.js');
    return controller.resolveCatalogCohortBinding(ctx, runId, signal, {
      s3, configs: () => loadEnv().GRAPH_CATALOG_COHORTS_JSON, now: injected?.now ?? Date.now,
    });
  });
  return {
    authenticate: injected?.authenticate ?? requireConnectorAuth,
    bindingsJson: injected?.bindingsJson ?? (() => loadEnv().GRAPH_WORKER_BINDINGS_JSON),
    now: injected?.now ?? Date.now,
    s3,
    readCfoText: injected?.readCfoText ?? ((source, callerContext, signal) =>
      createCfoTextSnapshotReader({
        callerContext,
        maxSourceBytes: CFO_TEXT_CANARY_MAX_BYTES,
      }).readVersionPinnedPage(source, { signal })),
    resolveCohortBinding,
    identityRegistry: injected?.identityRegistry,
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
const PREPARED_BINDING_KEYS = [
  'schema','run_id','room','source_index','catalog_manifest_sha256',
  'document_ordinal','source_document_version','catalog_source_sha256',
  'snapshot_id','prepared_manifest_sha256','sidecar_content_sha256',
  'chunk_ordinal','chunk_sha256',
];
function preparedBinding(
  value: unknown, binding: Binding, manifest: Manifest,
): { binding: PreparedBinding; item: ManifestItem } | null {
  if (!exact(value, PREPARED_BINDING_KEYS)) return null;
  const prepared = value as unknown as PreparedBinding;
  if (prepared.schema !== PREPARED_BINDING_SCHEMA ||
      prepared.run_id !== binding.run.run_id ||
      prepared.room !== 'finance' || binding.room !== 'finance' ||
      prepared.source_index !== 'finance-cfo-source-docs' ||
      binding.source_index !== prepared.source_index ||
      prepared.catalog_manifest_sha256 !== binding.run.manifest_sha256 ||
      prepared.document_ordinal !== 0 ||
      !/^docv_[a-f0-9]{64}$/.test(prepared.source_document_version) ||
      !SHA.test(prepared.catalog_source_sha256) ||
      !PREPARED_SNAPSHOT_ID.test(prepared.snapshot_id) ||
      !SHA.test(prepared.prepared_manifest_sha256) ||
      !SHA.test(prepared.sidecar_content_sha256) ||
      !Number.isSafeInteger(prepared.chunk_ordinal) ||
      prepared.chunk_ordinal < 0 || prepared.chunk_ordinal >= 100 ||
      !SHA.test(prepared.chunk_sha256)) return null;
  const item = manifest.documents[prepared.document_ordinal];
  if (!item || item.ordinal !== prepared.document_ordinal ||
      item.document_version_id !== prepared.source_document_version ||
      item.source_version !== prepared.catalog_source_sha256) return null;
  return { binding: Object.freeze({ ...prepared }), item };
}
function preparedSourceVersion(sourceBinding: PreparedBinding): string {
  return 'txtchunk_' + digest(canonical(sourceBinding));
}
function preparedSourceId(purpose: string, sourceBinding: PreparedBinding): string {
  return 'cfotext_' + digest(canonical({
    schema: PREPARED_SOURCE_SCHEMA, purpose, source_binding: sourceBinding,
  }));
}
function preparedAuthorizationRequest(
  binding: Binding, sourceBinding: PreparedBinding,
  sourceIdValue: string, sourceVersion: string, inputSha256: string,
) {
  return {
    schema: PREPARED_AUTH_SCHEMA,
    phase: 'model_source_access',
    authenticated_caller: binding.authenticated_caller,
    run: binding.run,
    source: {
      source_id: sourceIdValue,
      subscription_source_version: sourceVersion,
      purpose: binding.run.purpose,
      canonical_input_sha256: inputSha256,
      source_binding: sourceBinding,
    },
  };
}

function findItem(manifest: Manifest, source: Record<string, unknown>): ManifestItem | null {
  if (!Number.isSafeInteger(source.document_ordinal) ||
      (source.document_ordinal as number) < 0) return null;
  const item = manifest.documents[source.document_ordinal as number];
  return item && item.document_version_id === source.document_version_id &&
    item.source_version === source.source_version ? item : null;
}
type ParsedAuthorization =
  | { kind: 'metadata'; request: Record<string, unknown>; source: Record<string, unknown> }
  | {
      kind: 'prepared'; request: Record<string, unknown>;
      source: Record<string, unknown>; sourceBinding: unknown;
    };
function parseAuthorization(
  value: unknown, ctx: AuthContext, binding: Binding,
): ParsedAuthorization | null {
  if (!exact(value, ['schema','phase','authenticated_caller','run','source'])) return null;
  const request = value as Record<string, unknown>;
  if (request.authenticated_caller !== ctx.caller_agent ||
      !sameRun(request.run, binding.run)) return null;
  if (request.schema === AUTH_SCHEMA) {
    if (!['before_metadata_read','model_source_access'].includes(String(request.phase)) ||
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
    return { kind: 'metadata', request, source };
  }
  if (request.schema !== PREPARED_AUTH_SCHEMA ||
      request.phase !== 'model_source_access' ||
      ctx.caller_agent !== 'cfo' || binding.authenticated_caller !== 'cfo' ||
      binding.room !== 'finance' ||
      !exact(request.source, ['source_id','subscription_source_version','purpose',
        'canonical_input_sha256','source_binding'])) return null;
  const source = request.source as Record<string, unknown>;
  if (!PREPARED_SOURCE_ID.test(String(source.source_id)) ||
      !PREPARED_SOURCE_VERSION.test(String(source.subscription_source_version)) ||
      source.purpose !== binding.run.purpose ||
      !SHA.test(String(source.canonical_input_sha256))) return null;
  return {
    kind: 'prepared', request, source, sourceBinding: source.source_binding,
  };
}
function decisionRef(policyVersion: string, request: unknown): string {
  return 'gateway_' + digest(canonical({
    policy_version: policyVersion, request_sha256: digest(canonical(request)),
  }));
}
function sameIdentityAuthority(value: unknown, expected: IdentityAuthority): boolean {
  return canonical(value) === canonical(expected);
}
function validIdentityAuthority(value: unknown): value is IdentityAuthority {
  return exact(value, ['adapter_id','schema','scope','source_system','version']) &&
    value.schema === IDENTITY_AUTHORITY_SCHEMA && value.scope === 'cfo' &&
    bounded(value.adapter_id) && bounded(value.source_system) && bounded(value.version);
}
function validIdentityRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !bounded((value as Record<string, unknown>).source_record_id) ||
      !bounded((value as Record<string, unknown>).source_document_version) ||
      !SHA.test(String((value as Record<string, unknown>).source_sha256)) ||
      !bounded((value as Record<string, unknown>).mention)) return false;
  const row = value as Record<string, unknown>;
  if (row.disposition === 'unresolved') {
    return exact(row, ['source_record_id','source_document_version','source_sha256','mention','disposition']);
  }
  if (row.disposition === 'revoked') {
    return exact(row, ['source_record_id','source_document_version','source_sha256','mention','disposition','revocation_id']) &&
      bounded(row.revocation_id);
  }
  if (row.disposition !== 'resolved' || !exact(row, [
    'source_record_id','source_document_version','source_sha256','mention','disposition','endpoint',
  ])) return false;
  const endpoint = row.endpoint as Record<string, unknown>;
  if (!exact(endpoint, ['display_name','entity_type','identifier']) || endpoint.display_name !== row.mention ||
      !bounded(endpoint.display_name) || !bounded(endpoint.entity_type) || !endpoint.identifier ||
      typeof endpoint.identifier !== 'object' || Array.isArray(endpoint.identifier)) return false;
  const identifier = endpoint.identifier as Record<string, unknown>;
  return exact(identifier, ['namespace','scope','value']) &&
    bounded(identifier.namespace) && bounded(identifier.scope) && bounded(identifier.value);
}
function validIdentityPage(value: unknown, config: IdentityRegistryConfig,
  requested: { cursor: string | null; source_version: string | null; page_size: number },
): value is Record<string, unknown> {
  if (!exact(value, ['authority','current','next_cursor','records','schema','source_version']) ||
      value.schema !== IDENTITY_PAGE_SCHEMA || value.current !== true ||
      !sameIdentityAuthority(value.authority, config.authority) || !bounded(value.source_version) ||
      (requested.source_version !== null && value.source_version !== requested.source_version) ||
      !(value.next_cursor === null || bounded(value.next_cursor)) ||
      (requested.cursor !== null && value.next_cursor === requested.cursor) ||
      !Array.isArray(value.records) || value.records.length > 100 || !value.records.every(validIdentityRecord)) return false;
  return true;
}
function identityRecordKey(record: Record<string, unknown>) {
  return canonical({ source_document_version: record.source_document_version,
    source_sha256: record.source_sha256, mention: record.mention });
}
function validIdentityEnvelope(value: unknown, config: IdentityRegistryConfig, expectedVersion?: string): boolean {
  if (!exact(value, ['signature','snapshot']) || typeof value.signature !== 'string' ||
      value.signature.length !== 88 || !value.snapshot || typeof value.snapshot !== 'object') return false;
  const snapshot = value.snapshot as Record<string, unknown>;
  if (!exact(snapshot, ['entries','public_key_sha256','registry_id','revocations','schema',
    'source_authority','source_version','version']) || snapshot.schema !== IDENTITY_REGISTRY_SCHEMA ||
      snapshot.registry_id !== config.registry_id || !bounded(snapshot.version) ||
      (expectedVersion !== undefined && snapshot.version !== expectedVersion) ||
      !sameIdentityAuthority(snapshot.source_authority, config.authority) || !bounded(snapshot.source_version) ||
      !SHA.test(String(snapshot.public_key_sha256)) || !Array.isArray(snapshot.entries) ||
      !Array.isArray(snapshot.revocations) || snapshot.entries.length > 1000 || snapshot.revocations.length > 1000 ||
      Buffer.byteLength(canonical(value), 'utf8') > MAX_IDENTITY_ENVELOPE_BYTES) return false;
  let publicKey;
  try { publicKey = createPublicKey(config.public_key); } catch { return false; }
  if (publicKey.asymmetricKeyType !== 'ed25519' ||
      digest(publicKey.export({ type: 'spki', format: 'der' })) !== snapshot.public_key_sha256) return false;
  const entries = snapshot.entries as Record<string, unknown>[];
  const revocations = snapshot.revocations as Record<string, unknown>[];
  const entryKeys = new Set<string>();
  for (const entry of entries) {
    if (!exact(entry, ['endpoint','mention','source_document_version','source_sha256']) ||
        !validIdentityRecord({ ...entry, source_record_id: 'snapshot', disposition: 'resolved' }) ||
        entryKeys.has(identityRecordKey(entry))) return false;
    entryKeys.add(identityRecordKey(entry));
  }
  const revocationKeys = new Set<string>();
  for (const revocation of revocations) {
    if (!exact(revocation, ['mention','revocation_id','source_document_version','source_record_id','source_sha256']) ||
        !validIdentityRecord({ ...revocation, disposition: 'revoked' }) ||
        revocationKeys.has(identityRecordKey(revocation)) || entryKeys.has(identityRecordKey(revocation))) return false;
    revocationKeys.add(identityRecordKey(revocation));
  }
  const version = 'sirv_' + digest(canonical({ registry_id: snapshot.registry_id,
    source_authority: snapshot.source_authority, source_version: snapshot.source_version,
    entries: snapshot.entries, revocations: snapshot.revocations }));
  if (snapshot.version !== version) return false;
  const signature = Buffer.from(value.signature, 'base64');
  return signature.length === 64 && verify(null, Buffer.from(canonical(snapshot), 'utf8'), publicKey, signature);
}
const SPEC_KEYS = ['authorization_ref','authorization_sha256','extractor_bundle_sha256',
  'extractor_version','input_sha256','login_before_model_contract','model','provider',
  'purpose','source_id','source_version'];
const PREPARED_SPEC_KEYS = [...SPEC_KEYS, 'source_binding'];
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
function operationSource(
  operation: unknown, manifest: Manifest, binding: Binding, policyVersion: string,
): OperationSource | null {
  if (!operation || typeof operation !== 'object') return null;
  const value = operation as Record<string, unknown>;
  const state = String(value.state);
  if (!Object.hasOwn(OP_STATE_KEYS, state) || !exact(value, OP_STATE_KEYS[state]) ||
      !SUBOP.test(String(value.operation_id)) || !STATES.has(state) ||
      !bounded(value.claim_token, 128) || (value.claim_token as string).length < 16 ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return null;
  const spec = value.spec as Record<string, unknown>;
  if (!spec || Object.getPrototypeOf(spec) !== Object.prototype) return null;
  const specKeySet = Object.keys(spec).sort().join('\0');
  const isMetadata = specKeySet === [...SPEC_KEYS].sort().join('\0');
  const isPrepared = specKeySet === [...PREPARED_SPEC_KEYS].sort().join('\0');
  if ((!isMetadata && !isPrepared) ||
      value.operation_id !== 'subop_' + digest(canonical(spec)) ||
      ![spec.authorization_sha256,spec.extractor_bundle_sha256,spec.input_sha256]
        .every((entry) => SHA.test(String(entry))) ||
      spec.login_before_model_contract !== 'codex-login-status-before-model-exec-v1' ||
      !['codex-chatgpt-subscription', SUBSCRIPTION_REVIEW_PROVIDER].includes(String(spec.provider)) ||
      ![spec.authorization_ref,spec.extractor_version,spec.model,spec.purpose,
        spec.source_id,spec.source_version].every((entry) => bounded(entry)) ||
      spec.purpose !== binding.run.purpose) return null;
  if (spec.provider === SUBSCRIPTION_REVIEW_PROVIDER &&
      !isSubscriptionReviewOperationSpec(spec, isPrepared)) return null;
  if (Object.hasOwn(value, 'dispatched_at') && !utc(value.dispatched_at)) return null;
  if (Object.hasOwn(value, 'outcome_code') && !bounded(value.outcome_code)) return null;
  if (Object.hasOwn(value, 'result_sha256') && !SHA.test(String(value.result_sha256))) return null;
  if (isMetadata) {
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
      ? { kind: 'metadata', item } : null;
  }
  const prepared = preparedBinding(spec.source_binding, binding, manifest);
  if (!prepared) return null;
  const sourceVersion = preparedSourceVersion(prepared.binding);
  const sourceIdValue = preparedSourceId(binding.run.purpose, prepared.binding);
  if (spec.source_id !== sourceIdValue || spec.source_version !== sourceVersion) return null;
  const request = preparedAuthorizationRequest(
    binding, prepared.binding, sourceIdValue, sourceVersion, String(spec.input_sha256),
  );
  const ref = decisionRef(policyVersion, request);
  const authorization = {
    authorized: true, decision_ref: ref, source_binding: prepared.binding,
  };
  return spec.authorization_ref === ref &&
    spec.authorization_sha256 === digest(canonical(authorization))
    ? { kind: 'prepared', item: prepared.item, sourceBinding: prepared.binding } : null;
}
function parseOperationEnvelope(
  value: unknown, id: string, manifest: Manifest, binding: Binding, policyVersion: string,
): {
  envelope: Record<string, unknown>; operation: Record<string, unknown>;
  source: OperationSource;
} | null {
  if (!exact(value, ['schema','operation_id','operation_sha256','operation']) ||
      value.schema !== 'subscription-model-operation-v1' || value.operation_id !== id ||
      value.operation_sha256 !== digest(canonical(value.operation))) return null;
  const operation = value.operation as Record<string, unknown>;
  if (operation.operation_id !== id) return null;
  const source = operationSource(operation, manifest, binding, policyVersion);
  return source ? { envelope: value, operation, source } : null;
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
export function registerGraphWorkerBrokerRoutes(
  app: FastifyInstance, injected?: Partial<GraphWorkerBrokerDeps>,
): void {
  const deps = depsOf(injected);
  type BrokerControl = {
    ctx: AuthContext; policy: Policy; binding: Binding; signal: AbortSignal; cohort: boolean;
  };
  async function context(request: FastifyRequest, reply: FastifyReply, runId: string) {
    const ctx = await authenticate(request, reply, deps);
    if (!ctx) return null;
    let policy = parsePolicy(deps.bindingsJson(), deps.now());
    let binding = policy?.bindings.find((item) =>
      item.authenticated_caller === ctx.caller_agent && item.run.run_id === runId);
    let cohort = false;
    if (!binding) {
      const dynamic = await deps.resolveCohortBinding(ctx, runId, AbortSignal.timeout(15_000));
      if (dynamic) { policy = dynamic.policy; binding = dynamic.binding; cohort = true; }
    }
    if (!policy) { await fail(reply, 503, 'graph_worker_unconfigured'); return null; }
    if (!binding || ROOM[binding.room].seat !== ctx.caller_agent ||
        !isLaneAllowed(binding.source_index, ctx.caller_agent)) {
      await fail(reply, 403, 'graph_worker_forbidden');
      return null;
    }
    return { ctx, policy, binding, signal: AbortSignal.timeout(15_000), cohort };
  }
  async function recheck(control: {
    policy: Policy; binding: Binding; signal: AbortSignal; cohort?: boolean; ctx?: AuthContext;
  }): Promise<void> {
    if (control.cohort && control.ctx) {
      const latest = await deps.resolveCohortBinding(control.ctx, control.binding.run.run_id, control.signal);
      if (!latest || canonical(latest.binding) !== canonical(control.binding)) throw new Error('policy_changed');
    } else {
      const current = parsePolicy(deps.bindingsJson(), deps.now());
      if (!current || canonical(current) !== canonical(control.policy)) throw new Error('policy_changed');
    }
    await assertActive(deps, control.binding, control.signal);
  }

  async function identityContext(request: FastifyRequest, reply: FastifyReply, registryId: string) {
    const ctx = await authenticate(request, reply, deps);
    if (!ctx) return null;
    if (ctx.caller_agent !== 'cfo' || !deps.identityRegistry || !LABEL.test(registryId)) {
      await fail(reply, deps.identityRegistry ? 403 : 503,
        deps.identityRegistry ? 'graph_worker_forbidden' : 'identity_registry_unavailable');
      return null;
    }
    const signal = AbortSignal.timeout(15_000);
    let config: IdentityRegistryConfig | null;
    try { config = await deps.identityRegistry.resolve({ registry_id: registryId, caller: ctx }, { signal }); }
    catch { await fail(reply, 503, 'identity_registry_unavailable'); return null; }
    if (!config || config.registry_id !== registryId || !validIdentityAuthority(config.authority) ||
        config.authority.scope !== 'cfo' || !validRun(config.binding.run) ||
        config.binding.authenticated_caller !== 'cfo' || config.binding.room !== 'finance' ||
        config.binding.source_index !== ROOM.finance.index || typeof config.source?.page !== 'function' ||
        typeof config.source?.current !== 'function' || typeof config.snapshots?.publish !== 'function' ||
        typeof config.snapshots?.read !== 'function') {
      await fail(reply, 503, 'identity_registry_unavailable'); return null;
    }
    let publicKey;
    try { publicKey = createPublicKey(config.public_key); } catch {
      await fail(reply, 503, 'identity_registry_unavailable'); return null;
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      await fail(reply, 503, 'identity_registry_unavailable'); return null;
    }
    let policy = parsePolicy(deps.bindingsJson(), deps.now());
    let binding = policy?.bindings.find((item) => canonical(item) === canonical(config!.binding));
    let cohort = false;
    if (!binding) {
      try {
        const dynamic = await deps.resolveCohortBinding(ctx, config.binding.run.run_id, signal);
        if (dynamic && canonical(dynamic.binding) === canonical(config.binding)) {
          policy = dynamic.policy; binding = dynamic.binding; cohort = true;
        }
      } catch { /* treated as unavailable below */ }
    }
    if (!policy || !binding || !isLaneAllowed(binding.source_index, ctx.caller_agent)) {
      await fail(reply, 503, 'identity_registry_unavailable'); return null;
    }
    try { await assertActive(deps, binding, signal); }
    catch { await fail(reply, 503, 'identity_registry_unavailable'); return null; }
    return { ctx, policy, binding, signal, cohort, config };
  }
  function identityAuthorization(request: unknown, control: NonNullable<Awaited<ReturnType<typeof identityContext>>>,
    action: 'read_page' | 'assert_current',
  ): boolean {
    if (!exact(request, ['action','authenticated_caller','authority','cursor','schema','source_version']) ||
        request.schema !== IDENTITY_AUTH_SCHEMA || request.action !== action ||
        request.authenticated_caller !== control.ctx.caller_agent ||
        !sameIdentityAuthority(request.authority, control.config.authority) ||
        !(request.cursor === null || bounded(request.cursor)) ||
        !(request.source_version === null || bounded(request.source_version))) return false;
    return action === 'read_page' || (request.cursor === null && typeof request.source_version === 'string');
  }
  function identityReceipt(request: unknown, control: NonNullable<Awaited<ReturnType<typeof identityContext>>>) {
    return {
      allowed: true,
      authorization_request_sha256: digest(canonical(request)),
      decision_ref: decisionRef(control.policy.policy_version, request),
      policy_version: control.policy.policy_version,
      provenance: { authenticated_caller: control.ctx.caller_agent, decision_source: 'authenticated_gateway' },
    };
  }
  function hasIdentityReceipt(value: unknown, request: unknown,
    control: NonNullable<Awaited<ReturnType<typeof identityContext>>>,
  ): boolean {
    return exact(value, ['decision_ref','policy_version']) &&
      value.policy_version === control.policy.policy_version &&
      value.decision_ref === decisionRef(control.policy.policy_version, request);
  }

  app.post('/graph-worker/v1/identity-registry/:registryId/authorize', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const c = await identityContext(request, reply, String((request.params as { registryId?: string }).registryId));
    if (!c) return;
    const action = (request.body as Record<string, unknown> | undefined)?.action;
    if (action !== 'read_page' && action !== 'assert_current' || !identityAuthorization(request.body, c, action)) {
      return fail(reply, 403, 'graph_worker_forbidden');
    }
    try { await recheck(c); return reply.send(identityReceipt(request.body, c)); }
    catch { return fail(reply, 503, 'identity_registry_unavailable'); }
  });

  app.post('/graph-worker/v1/identity-registry/:registryId/page', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const c = await identityContext(request, reply, String((request.params as { registryId?: string }).registryId));
    if (!c || !exact(request.body, ['authority','authorization','cursor','page_size','source_version']) ||
        !sameIdentityAuthority(request.body.authority, c.config.authority) ||
        !(request.body.cursor === null || bounded(request.body.cursor)) ||
        !(request.body.source_version === null || bounded(request.body.source_version)) ||
        !Number.isSafeInteger(request.body.page_size) || request.body.page_size < 1 || request.body.page_size > 100) {
      return c ? fail(reply, 403, 'graph_worker_forbidden') : undefined;
    }
    const authorization = { schema: IDENTITY_AUTH_SCHEMA, action: 'read_page',
      authenticated_caller: c.ctx.caller_agent, authority: c.config.authority,
      cursor: request.body.cursor, source_version: request.body.source_version };
    if (!hasIdentityReceipt(request.body.authorization, authorization, c)) return fail(reply, 403, 'graph_worker_forbidden');
    try {
      const page = await c.config.source.page({ cursor: request.body.cursor as string | null,
        source_version: request.body.source_version as string | null, page_size: request.body.page_size as number }, { signal: c.signal });
      if (!validIdentityPage(page, c.config, { cursor: request.body.cursor as string | null,
        source_version: request.body.source_version as string | null, page_size: request.body.page_size as number })) {
        return fail(reply, 503, 'identity_registry_unavailable');
      }
      await recheck(c); return reply.send(page);
    } catch { return fail(reply, 503, 'identity_registry_unavailable'); }
  });

  app.post('/graph-worker/v1/identity-registry/:registryId/current', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const c = await identityContext(request, reply, String((request.params as { registryId?: string }).registryId));
    if (!c || !exact(request.body, ['authority','authorization','source_version']) ||
        !sameIdentityAuthority(request.body.authority, c.config.authority) || !bounded(request.body.source_version)) {
      return c ? fail(reply, 403, 'graph_worker_forbidden') : undefined;
    }
    const authorization = { schema: IDENTITY_AUTH_SCHEMA, action: 'assert_current',
      authenticated_caller: c.ctx.caller_agent, authority: c.config.authority,
      cursor: null, source_version: request.body.source_version };
    if (!hasIdentityReceipt(request.body.authorization, authorization, c)) return fail(reply, 403, 'graph_worker_forbidden');
    try {
      if (await c.config.source.current({ source_version: request.body.source_version as string }, { signal: c.signal }) !== true) {
        return fail(reply, 503, 'identity_registry_unavailable');
      }
      await recheck(c);
      return reply.send({ authority: c.config.authority, current: true, source_version: request.body.source_version });
    } catch { return fail(reply, 503, 'identity_registry_unavailable'); }
  });

  app.put('/graph-worker/v1/identity-registry/:registryId/snapshots/:version', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const registryId = String((request.params as { registryId?: string }).registryId);
    const version = String((request.params as { version?: string }).version);
    const c = await identityContext(request, reply, registryId);
    if (!c) return;
    if (!LABEL.test(version) || request.headers['if-none-match'] !== '*' ||
        Buffer.byteLength(canonical(request.body), 'utf8') > MAX_IDENTITY_ENVELOPE_BYTES ||
        !validIdentityEnvelope(request.body, c.config, version)) return fail(reply, 403, 'graph_worker_forbidden');
    const snapshot = (request.body as Record<string, unknown>).snapshot as Record<string, unknown>;
    try {
      // Publish only while the exact source version remains current. This check is repeated
      // after store I/O so a source change cannot race an otherwise valid signature.
      if (await c.config.source.current({ source_version: snapshot.source_version as string }, { signal: c.signal }) !== true) {
        return fail(reply, 503, 'identity_registry_unavailable');
      }
      await recheck(c);
      const published = await c.config.snapshots.publish({ registry_id: registryId, version, envelope: request.body }, { signal: c.signal });
      if (!published) return fail(reply, 412, 'identity_registry_publication_conflict');
      if (await c.config.source.current({ source_version: snapshot.source_version as string }, { signal: c.signal }) !== true) {
        return fail(reply, 503, 'identity_registry_unavailable');
      }
      await recheck(c);
      return reply.code(201).send({ published: true, registry_id: registryId, version,
        snapshot_sha256: digest(canonical(snapshot)) });
    } catch { return fail(reply, 503, 'identity_registry_publication_unavailable'); }
  });

  app.get('/graph-worker/v1/identity-registry/:registryId/snapshots/:version', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const registryId = String((request.params as { registryId?: string }).registryId);
    const version = String((request.params as { version?: string }).version);
    const c = await identityContext(request, reply, registryId);
    if (!c) return;
    if (!LABEL.test(version)) return fail(reply, 400, 'graph_worker_request_invalid');
    try {
      const stored = await c.config.snapshots.read({ registry_id: registryId, version }, { signal: c.signal });
      // A revocation is current authorization state. It takes precedence over an immutable,
      // otherwise-valid signed envelope and is deliberately not inferred from source currentness.
      if (stored.status === 'revoked') return fail(reply, 410, 'identity_registry_version_revoked');
      if (stored.status === 'missing') return fail(reply, 404, 'identity_registry_version_missing');
      if (!validIdentityEnvelope(stored.envelope, c.config, version)) return fail(reply, 503, 'identity_registry_unavailable');
      await recheck(c);
      return reply.send(stored.envelope);
    } catch { return fail(reply, 503, 'identity_registry_unavailable'); }
  });

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
      if (parsed.kind === 'metadata') {
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
      } else {
        const prepared = preparedBinding(
          parsed.sourceBinding, c.binding, manifest,
        );
        if (!prepared) return fail(reply, 403, 'graph_worker_forbidden');
        const sourceVersion = preparedSourceVersion(prepared.binding);
        const sourceIdValue = preparedSourceId(
          c.binding.run.purpose, prepared.binding,
        );
        const expected = preparedAuthorizationRequest(
          c.binding, prepared.binding, sourceIdValue, sourceVersion,
          String(parsed.source.canonical_input_sha256),
        );
        const proof = await resolvePreparedChunk(c, prepared.binding);
        if (!proof ||
            proof.inputSha256 !== parsed.source.canonical_input_sha256 ||
            parsed.source.source_id !== sourceIdValue ||
            parsed.source.subscription_source_version !== sourceVersion ||
            canonical(expected) !== canonical(parsed.request)) {
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

  async function resolveBoundCfoTextSource(
    control: BrokerControl, ordinal: number, signal: AbortSignal,
  ): Promise<CfoTextSource> {
    if (signal !== control.signal || control.ctx.caller_agent !== 'cfo' ||
        control.binding.authenticated_caller !== 'cfo' ||
        control.binding.room !== 'finance' ||
        control.binding.source_index !== 'finance-cfo-source-docs' ||
        ordinal !== 0) throw new Error('cfo_text_forbidden');
    await assertActive(deps, control.binding, signal);
    const { manifest } = await loadManifest(deps, control.binding, signal);
    const item = manifest.documents[ordinal];
    if (!item || item.ordinal !== ordinal) throw new Error('cfo_text_source_missing');
    const loaded = await loadRow(deps, control.binding, item, signal);
    const source = Object.freeze({
      room: 'finance' as const,
      source_index: 'finance-cfo-source-docs' as const,
      path: loaded.value.row.path as string,
      source_path_hash: item.source_path_hash,
      document_version_id: item.document_version_id,
      source_version: item.source_version,
    });
    await recheck({ ...control, signal });
    return source;
  }
  function cfoTextStore(control: BrokerControl) {
    const prefix = statePrefix(control.binding) + '/text-snapshots/';
    return async (input: RawRequest): Promise<RawResponse> => {
      if (input.signal !== control.signal || !input.key.startsWith(prefix)) {
        throw new Error('cfo_text_store_scope');
      }
      const suffix = input.key.slice(prefix.length);
      const allowed = /^txtsnap_[a-f0-9]{64}\/(?:manifest\.json|bundles\/(?:0|[1-9]\d?)-[a-f0-9]{64}\.json)$/.test(suffix);
      if (!allowed) throw new Error('cfo_text_store_scope');
      if (input.method === 'GET') {
        if (input.headers !== undefined || input.body !== undefined) {
          throw new Error('cfo_text_store_scope');
        }
      } else if (input.method === 'PUT') {
        if (!input.body || input.body.length > MAX_REQUEST_BYTES ||
            !exact(input.headers, ['content-type','if-none-match']) ||
            input.headers['content-type'] !== 'application/json' ||
            input.headers['if-none-match'] !== '*') {
          throw new Error('cfo_text_store_scope');
        }
        await recheck(control);
      } else {
        throw new Error('cfo_text_store_scope');
      }
      return deps.s3(input);
    };
  }
  function cfoTextController(control: BrokerControl) {
    return createCfoTextPreparationController({
      runId: control.binding.run.run_id,
      sourceReader: Object.freeze({
        readVersionPinnedPage: (
          source: CfoTextSource, options: { signal: AbortSignal },
        ) => deps.readCfoText(source, control.ctx, options.signal),
      }),
      resolveSource: (ordinal, options) =>
        resolveBoundCfoTextSource(control, ordinal, options.signal),
      recheck: (options) => recheck({ ...control, signal: options.signal }),
      store: cfoTextStore(control),
      maxPreparedBytes: CFO_TEXT_CANARY_MAX_BYTES,
    });
  }

  async function resolvePreparedChunk(
    control: BrokerControl, sourceBinding: PreparedBinding,
  ): Promise<{ inputSha256: string; textSha256: string; text: string } | null> {
    const result = await cfoTextController(control).readChunk({
      snapshot_id: sourceBinding.snapshot_id,
      ordinal: sourceBinding.chunk_ordinal,
    }, { signal: control.signal });
    if (!exact(result, ['schema','snapshot_id','source_document_version',
      'manifest_sha256','sidecar_content_sha256','ordinal','start_utf16',
      'end_utf16','start_byte','end_byte','text_sha256','text']) ||
      result.schema !== 'cfo-text-prepared-chunk-v1' ||
      result.snapshot_id !== sourceBinding.snapshot_id ||
      result.source_document_version !== sourceBinding.source_document_version ||
      result.manifest_sha256 !== sourceBinding.prepared_manifest_sha256 ||
      result.sidecar_content_sha256 !== sourceBinding.sidecar_content_sha256 ||
      result.ordinal !== sourceBinding.chunk_ordinal ||
      result.text_sha256 !== sourceBinding.chunk_sha256 ||
      typeof result.text !== 'string' || result.text.length < 1 ||
      result.text.length > 16_000 || Buffer.byteLength(result.text, 'utf8') > 16 * 1024 ||
      digest(result.text) !== sourceBinding.chunk_sha256) return null;
    const sourceVersion = preparedSourceVersion(sourceBinding);
    const document = {
      text: result.text, document_version_id: sourceVersion, room: 'finance',
    };
    return {
      inputSha256: digest(canonical(document)),
      textSha256: digest(result.text),
      text: result.text,
    };
  }
  async function resolveOperationSourceProof(
    control: BrokerControl, manifest: Manifest,
    operation: Record<string, unknown>, source: OperationSource,
  ): Promise<{ inputSha256: string; textSha256: string | null; text: string | null } | null> {
    const spec = operation.spec as Record<string, unknown>;
    if (source.kind === 'metadata') {
      const loaded = await loadRow(
        deps, control.binding, source.item, control.signal,
      );
      const actual = metadataInputSha(
        loaded.value.row, source.item, control.binding.room,
      );
      return actual !== null && actual === spec.input_sha256
        ? { inputSha256: actual, textSha256: null, text: null } : null;
    }
    const current = preparedBinding(source.sourceBinding, control.binding, manifest);
    if (!current ||
        canonical(current.binding) !== canonical(source.sourceBinding)) return null;
    const actual = await resolvePreparedChunk(control, current.binding);
    return actual && actual.inputSha256 === spec.input_sha256 ? actual : null;
  }
  async function readStoredOperation(
    control: BrokerControl, id: string, manifest: Manifest,
  ) {
    const key = statePrefix(control.binding) +
      '/subscription-jobs/operations/' + id + '.json';
    const response = await deps.s3({
      method: 'GET', key, signal: control.signal,
    });
    if (response.status !== 200 ||
        response.body.length > MAX_RESPONSE_BYTES) return null;
    let value: unknown;
    try { value = JSON.parse(response.body.toString('utf8')); }
    catch { return null; }
    const parsed = parseOperationEnvelope(
      value, id, manifest, control.binding, control.policy.policy_version,
    );
    const etag = response.headers.get('etag');
    if (!parsed || !bounded(etag, 160)) return null;
    const sourceProof = await resolveOperationSourceProof(
      control, manifest, parsed.operation, parsed.source,
    );
    return sourceProof ? { ...parsed, sourceProof, etag, response } : null;
  }

  function resultMatchesOperationSource(
    result: Record<string, unknown>,
    operation: Awaited<ReturnType<typeof readStoredOperation>>,
  ): boolean {
    if (!operation) return false;
    const spec = operation.operation.spec as Record<string, unknown>;
    const inner = result.result as Record<string, unknown>;
    const output = inner.output as Record<string, unknown>;
    if (spec.provider === SUBSCRIPTION_REVIEW_PROVIDER) {
      return isSubscriptionReviewOperationSpec(spec, operation.source.kind === 'prepared') &&
        validSubscriptionReviewOutput(output, spec,
          operation.sourceProof.textSha256 && operation.sourceProof.text
            ? { textSha256: operation.sourceProof.textSha256, text: operation.sourceProof.text }
            : null);
    }
    if (operation.source.kind === 'metadata') return true;
    return output.source_sha256 === operation.sourceProof.textSha256 &&
      output.source_sha256 === operation.source.sourceBinding.chunk_sha256;
  }

  app.post('/graph-worker/v1/source/:runId/cfo-text-snapshots', {
    config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!exact(request.body, ['run','document_ordinal']) ||
        !validRun(request.body.run) ||
        request.body.document_ordinal !== 0) {
      return fail(reply, 400, 'graph_worker_request_invalid');
    }
    const params = request.params as { runId: string };
    const c = await context(request, reply, params.runId);
    if (!c) return;
    if (!sameRun(request.body.run, c.binding.run) ||
        c.binding.authenticated_caller !== 'cfo' ||
        c.binding.room !== 'finance') {
      return fail(reply, 403, 'graph_worker_forbidden');
    }
    try {
      const result = await cfoTextController(c).prepare(
        { document_ordinal: request.body.document_ordinal },
        { signal: c.signal },
      );
      reply.header('cache-control', 'no-store');
      return reply.send(result);
    } catch {
      return fail(reply, 503, 'graph_worker_text_unavailable');
    }
  });

  app.get(
    '/graph-worker/v1/source/:runId/cfo-text-snapshots/:snapshotId/chunks/:ordinal',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = request.params as {
        runId: string; snapshotId: string; ordinal: string;
      };
      if (!/^(?:0|[1-9]\d?)$/.test(params.ordinal)) {
        return fail(reply, 400, 'graph_worker_request_invalid');
      }
      const c = await context(request, reply, params.runId);
      if (!c) return;
      if (c.binding.authenticated_caller !== 'cfo' ||
          c.binding.room !== 'finance') {
        return fail(reply, 403, 'graph_worker_forbidden');
      }
      try {
        const result = await cfoTextController(c).readChunk({
          snapshot_id: params.snapshotId,
          ordinal: Number(params.ordinal),
        }, { signal: c.signal });
        reply.header('cache-control', 'no-store');
        return reply.send(result);
      } catch {
        return fail(reply, 503, 'graph_worker_text_unavailable');
      }
    },
  );

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
          const stored = await readStoredOperation(c, params.id, manifest);
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
        const operation = await readStoredOperation(c, params.id, manifest);
        if (!result || !operation ||
            (result.result as Record<string, unknown>).spec_sha256 !==
              digest(canonical(operation.operation.spec)) ||
            !resultMatchesOperationSource(result, operation) ||
            (operation.operation.state === 'complete' &&
              operation.operation.result_sha256 !== result.result_sha256)) {
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
        const incomingProof = incoming && await resolveOperationSourceProof(
          c, manifest, incoming.operation, incoming.source,
        );
        if (!incoming || !incomingProof) {
          return fail(reply, 403, 'graph_worker_state_invalid');
        }
        if (create) {
          if (incoming.operation.state !== 'claimed' || incoming.operation.revision !== 0 ||
              Object.keys(incoming.operation).some((entry) => !OP_KEYS.includes(entry))) {
            return fail(reply, 403, 'graph_worker_state_invalid');
          }
        } else {
          const prior = await readStoredOperation(c, params.id, manifest);
          if (!prior || !legalTransition(
            prior.operation, incoming.operation, ifMatch as string, prior.etag,
          )) return fail(reply, 412, 'graph_worker_state_conflict');
          if (incoming.operation.state === 'complete') {
            const resultKey = statePrefix(c.binding) +
              '/subscription-jobs/results/' + params.id + '.json';
            const storedResult = await deps.s3({
              method: 'GET', key: resultKey, signal: c.signal,
            });
            if (storedResult.status === 404) {
              return fail(reply, 412, 'graph_worker_state_conflict');
            }
            if (storedResult.status !== 200 ||
                storedResult.body.length > MAX_RESPONSE_BYTES) {
              return fail(reply, 503, 'graph_worker_state_unavailable');
            }
            let storedValue: unknown;
            try { storedValue = JSON.parse(storedResult.body.toString('utf8')); }
            catch { return fail(reply, 503, 'graph_worker_state_unavailable'); }
            const result = parseResultEnvelope(storedValue, params.id);
            if (!result ||
                result.result_sha256 !== incoming.operation.result_sha256 ||
                (result.result as Record<string, unknown>).spec_sha256 !==
                  digest(canonical(incoming.operation.spec)) ||
                !resultMatchesOperationSource(result, prior)) {
              return fail(reply, 412, 'graph_worker_state_conflict');
            }
          }
        }
      } else {
        if (!create) return fail(reply, 400, 'graph_worker_precondition_required');
        const result = parseResultEnvelope(value, params.id);
        const operation = await readStoredOperation(c, params.id, manifest);
        if (!result || !operation ||
            !['dispatched','complete'].includes(String(operation.operation.state)) ||
            (result.result as Record<string, unknown>).spec_sha256 !==
              digest(canonical(operation.operation.spec)) ||
            !resultMatchesOperationSource(result, operation)) {
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
  abortable, boundedCancel,
};
