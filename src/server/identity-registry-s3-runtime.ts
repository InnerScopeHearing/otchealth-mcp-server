/** Production S3 transport and immutable-storage preflight for the source
 * identity registry. This module owns no credentials and never logs headers. */
import { createHash } from 'node:crypto';
import { canonicalQueryString, canonicalUri, resolveAwsCredentials, signRequest, type AwsCredentials, type SignedRequest } from '../search/sigv4.js';
import { createIdentityRegistryS3SnapshotStore } from './identity-registry-s3-store.mjs';

const SHA = /^[a-f0-9]{64}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const PREFIX = /^[a-z0-9][a-z0-9/_-]{0,511}$/;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

export type IdentityRegistryS3PolicyEvidence = Readonly<{
  bucket: string;
  prefix: string;
  canonical_policy_sha256: string;
}>;

export interface IdentityRegistryS3RuntimeDeps {
  bucket: string;
  prefix: string;
  region: string;
  approvedPolicyCanonicalSha256: string;
  approvedStorageScopeSha256: string;
  resolveCredentials?: () => Promise<AwsCredentials | null>;
  signRequest?: (input: Parameters<typeof signRequest>[0]) => SignedRequest;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

export interface IdentityRegistryS3Runtime {
  preflight(signal: AbortSignal): Promise<IdentityRegistryS3PolicyEvidence>;
  request(input: { method: 'GET' | 'PUT'; key: string; versionId?: string; headers?: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{ status: number; headers: Headers; body: Buffer }>;
}
export type IdentityRegistrySse = { algorithm: 'AES256' } | { algorithm: 'aws:kms'; kmsKeyId: string };
export interface RuntimeIdentityRegistryS3StoreConfig extends IdentityRegistryS3RuntimeDeps { sse: IdentityRegistrySse; }
export interface RuntimeIdentityRegistryS3Store {
  preflight(signal: AbortSignal): Promise<IdentityRegistryS3PolicyEvidence>;
  snapshots: {
    publish(input: { registry_id: string; version: string; envelope: unknown }, options: { signal: AbortSignal }): Promise<boolean>;
    read(input: { registry_id: string; version: string }, options: { signal: AbortSignal }): Promise<{ status: 'active'; envelope: unknown } | { status: 'revoked' | 'missing' }>;
    revoke(input: { registry_id: string; version: string; reason?: string }, options: { signal: AbortSignal }): Promise<boolean>;
  };
}

function fail(code: string): never { throw new Error(code); }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) return fail('identity_registry_policy_invalid'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return fail('identity_registry_policy_invalid');
  return '{' + Object.keys(value as Record<string, unknown>).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
}
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function checked(config: IdentityRegistryS3RuntimeDeps): Required<Pick<IdentityRegistryS3RuntimeDeps, 'bucket'|'prefix'|'region'|'approvedPolicyCanonicalSha256'|'approvedStorageScopeSha256'>> & IdentityRegistryS3RuntimeDeps {
  if (!LABEL.test(config.bucket) || !PREFIX.test(config.prefix) || config.prefix.endsWith('/') || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(config.region) || !SHA.test(config.approvedPolicyCanonicalSha256) ||
      !SHA.test(config.approvedStorageScopeSha256) || config.requestTimeoutMs !== undefined && (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1 || config.requestTimeoutMs > 120000)) fail('identity_registry_s3_runtime_configuration');
  if (digest(canonical({ bucket: config.bucket, prefix: config.prefix, policy_sha256: config.approvedPolicyCanonicalSha256 })) !== config.approvedStorageScopeSha256) fail('identity_registry_s3_runtime_scope_mismatch');
  return Object.freeze({ ...config });
}
async function bounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) fail('identity_registry_s3_response_too_large');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try { for (;;) { if (signal.aborted) fail('identity_registry_s3_deadline'); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) fail('identity_registry_s3_response_too_large'); chunks.push(Buffer.from(part.value)); } }
  catch (error) { cancel(); throw error; } finally { signal.removeEventListener('abort', cancel); }
  if (signal.aborted || (length !== null && Number(length) !== size)) fail('identity_registry_s3_response_length_invalid');
  return Buffer.concat(chunks, size);
}
async function timed<T>(work: (signal: AbortSignal) => Promise<T>, source: AbortSignal, timeout: number): Promise<T> {
  if (source.aborted) fail('identity_registry_s3_deadline');
  const controller = new AbortController();
  const relay = () => controller.abort();
  source.addEventListener('abort', relay, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach: () => void = () => undefined;
  const stop = new Promise<never>((_, reject) => {
    const abort = () => reject(new Error('identity_registry_s3_deadline'));
    controller.signal.addEventListener('abort', abort, { once: true });
    detach = () => controller.signal.removeEventListener('abort', abort);
    timer = setTimeout(relay, timeout);
  });
  try {
    const result = await Promise.race([stop, Promise.resolve().then(() => {
      if (source.aborted || controller.signal.aborted) fail('identity_registry_s3_deadline');
      return work(controller.signal);
    })]);
    if (source.aborted || controller.signal.aborted) fail('identity_registry_s3_deadline');
    return result;
  } finally { clearTimeout(timer); detach(); source.removeEventListener('abort', relay); }
}

/** Requires actual bucket Versioning=Enabled and an exact canonical hash of the
 * reviewed immutable-prefix policy. An application boolean is not accepted. */
export function createIdentityRegistryS3Runtime(config: IdentityRegistryS3RuntimeDeps): IdentityRegistryS3Runtime {
  const fixed = checked(config), credentials = fixed.resolveCredentials ?? resolveAwsCredentials, signer = fixed.signRequest ?? signRequest, fetcher = fixed.fetch ?? fetch;
  const timeout = fixed.requestTimeoutMs ?? 15000, host = `${fixed.bucket}.s3.${fixed.region}.amazonaws.com`;
  async function request(input: { method: 'GET' | 'PUT'; key: string; versionId?: string; headers?: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{ status: number; headers: Headers; body: Buffer }> {
    if (input.method !== 'GET' && input.method !== 'PUT') fail('identity_registry_s3_request_invalid');
    if (input.method === 'PUT' && new Headers(input.headers).get('if-none-match') !== '*') fail('identity_registry_s3_conditional_create_required');
    if (input.signal.aborted || !input.key.startsWith(fixed.prefix + '/') || input.key.split('/').some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9_.:-]+$/.test(part))) fail('identity_registry_s3_request_invalid');
    for (const [name, value] of Object.entries(input.headers ?? {})) if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n]/.test(value) || ['host','authorization','content-length','x-amz-date','x-amz-content-sha256'].includes(name.toLowerCase())) fail('identity_registry_s3_request_headers_invalid');
    const creds = await timed(() => credentials(), input.signal, timeout); if (!creds) fail('identity_registry_s3_credentials_unavailable');
    const query = input.versionId ? { versionId: input.versionId } : undefined;
    const body = input.body === undefined ? undefined : Buffer.from(input.body, 'utf8');
    const extraHeaders = { 'x-amz-content-sha256': digest(body ?? Buffer.alloc(0)), ...(input.headers ?? {}) };
    const signed = signer({ method: input.method, host, path: '/' + input.key, query, region: fixed.region, service: 's3', credentials: creds, ...(body ? { body } : {}), extraHeaders });
    const url = `https://${host}${canonicalUri('/' + input.key)}${query ? '?' + canonicalQueryString(query) : ''}`;
    const response = await timed(signal => fetcher(url, { method: input.method, headers: signed.headers, ...(input.body !== undefined ? { body: input.body } : {}), signal, redirect: 'error' }), input.signal, timeout);
    const responseBody = await timed(signal => bounded(response, MAX_RESPONSE_BYTES, signal), input.signal, timeout);
    return { status: response.status, headers: response.headers, body: responseBody };
  }
  async function preflight(signal: AbortSignal): Promise<IdentityRegistryS3PolicyEvidence> {
    if (signal.aborted) fail('identity_registry_s3_deadline');
    const raw = async (query: Record<string, string>, limit: number): Promise<Buffer> => {
      const creds = await timed(() => credentials(), signal, timeout); if (!creds) fail('identity_registry_s3_credentials_unavailable');
      const signed = signer({ method: 'GET', host, path: '/', query, region: fixed.region, service: 's3', credentials: creds, extraHeaders: { 'x-amz-content-sha256': digest(Buffer.alloc(0)) } });
      const url = `https://${host}/?${canonicalQueryString(query)}`;
      const result = await timed(s => fetcher(url, { method: 'GET', headers: signed.headers, signal: s, redirect: 'error' }), signal, timeout);
      if (result.status !== 200) fail('identity_registry_s3_preflight_unavailable'); return timed(s => bounded(result, limit, s), signal, timeout);
    };
    const versioning = (await raw({ versioning: '' }, 16 * 1024)).toString('utf8');
    if (!/<Status>Enabled<\/Status>/.test(versioning)) fail('identity_registry_s3_versioning_required');
    const policyBytes = await raw({ policy: '' }, MAX_POLICY_BYTES); let policy: unknown;
    try { policy = JSON.parse(policyBytes.toString('utf8')); } catch { fail('identity_registry_s3_policy_invalid'); }
    if (digest(canonical(policy)) !== fixed.approvedPolicyCanonicalSha256) fail('identity_registry_s3_policy_mismatch');
    const resource = `arn:aws:s3:::${fixed.bucket}/${fixed.prefix}/identity-registries/*`;
    const statements = (policy as { Statement?: unknown }).Statement;
    if (!Array.isArray(statements) || !statements.some(statement => {
      if (!statement || typeof statement !== 'object') return false;
      const row = statement as Record<string, unknown>;
      const actions = Array.isArray(row.Action) ? row.Action : [row.Action], resources = Array.isArray(row.Resource) ? row.Resource : [row.Resource];
      return row.Effect === 'Deny' && row.Principal === '*' && row.Condition === undefined && row.NotPrincipal === undefined && row.NotAction === undefined && row.NotResource === undefined && actions.includes('s3:DeleteObject') && actions.includes('s3:DeleteObjectVersion') && resources.includes(resource);
    })) fail('identity_registry_s3_immutable_scope_required');
    if (!statements.some(statement => {
      if (!statement || typeof statement !== 'object') return false;
      const row = statement as Record<string, unknown>;
      const actions = Array.isArray(row.Action) ? row.Action : [row.Action];
      const resources = Array.isArray(row.Resource) ? row.Resource : [row.Resource];
      return row.Effect === 'Deny' && row.Principal === '*' && row.NotPrincipal === undefined && row.NotAction === undefined && row.NotResource === undefined &&
        actions.includes('s3:PutObject') && resources.includes(resource) && row.Condition !== undefined &&
        canonical(row.Condition) === canonical({ Null: { 's3:if-none-match': 'true' } });
    })) fail('identity_registry_s3_create_only_policy_required');
    return Object.freeze({ bucket: fixed.bucket, prefix: fixed.prefix, canonical_policy_sha256: fixed.approvedPolicyCanonicalSha256 });
  }
  return Object.freeze({ preflight, request });
}

/** Binds the exact reviewed low-level receipt/pinned-version algorithm to the
 * production SigV4 transport and runs live policy preflight for every action. */
export function createRuntimeIdentityRegistryS3SnapshotStore(config: RuntimeIdentityRegistryS3StoreConfig): RuntimeIdentityRegistryS3Store {
  config = Object.freeze({ ...config, sse: Object.freeze({ ...config.sse }) });
  if (config.sse?.algorithm !== 'AES256' && (config.sse?.algorithm !== 'aws:kms' ||
      !new RegExp(`^arn:aws:kms:${config.region}:900915535335:key/[a-f0-9-]{36}$`).test(config.sse.kmsKeyId))) fail('identity_registry_s3_sse_configuration');
  const runtime = createIdentityRegistryS3Runtime(config);
  const core = createIdentityRegistryS3SnapshotStore({
    bucket: config.bucket, prefix: config.prefix, region: config.region, requestTimeoutMs: config.requestTimeoutMs ?? 15000,
    immutableTombstonePolicyAttested: true, sse: config.sse,
    signRequest: async (input: { url: string; headers: Record<string, string> }) => ({ url: input.url, headers: input.headers }),
    fetchImpl: async (urlText: string, init: RequestInit) => {
      const url = new URL(urlText); const expected = `${config.bucket}.s3.${config.region}.amazonaws.com`;
      if (url.protocol !== 'https:' || url.hostname !== expected || url.port || !url.pathname.startsWith('/' + config.prefix + '/')) throw new Error('identity_registry_s3_route_invalid');
      const versionId = url.searchParams.get('versionId') ?? undefined;
      const result = await runtime.request({ method: init.method as 'GET' | 'PUT', key: url.pathname.slice(1), ...(versionId ? { versionId } : {}), headers: Object.fromEntries(new Headers(init.headers).entries()), ...(typeof init.body === 'string' ? { body: init.body } : {}), signal: init.signal as AbortSignal });
      return new Response(result.body, { status: result.status, headers: result.headers });
    },
  });
  const wrap = <T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> => runtime.preflight(signal).then(call);
  const snapshots: RuntimeIdentityRegistryS3Store['snapshots'] = {
    publish: (input, options) => wrap(() => core.publish(input, options), options.signal),
    read: async (input, options) => {
      const result = await wrap(() => core.read(input, options), options.signal);
      if (result.status === 'active') return { status: 'active', envelope: result.envelope };
      if (result.status === 'missing' || result.status === 'revoked') return { status: result.status };
      return fail('identity_registry_s3_read_unknown');
    },
    revoke: (input, options) => wrap(() => core.revoke(input, options), options.signal),
  };
  return Object.freeze({ preflight: runtime.preflight, snapshots: Object.freeze(snapshots) });
}
