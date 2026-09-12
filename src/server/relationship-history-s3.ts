import { createHash } from 'node:crypto';
import {
  canonicalQueryString,
  canonicalUri,
  resolveAwsCredentials,
  signRequest,
  type AwsCredentials,
  type SignedRequest,
} from '../search/sigv4.js';

const BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
const REGION = 'us-east-1';
const ARTIFACT_PREFIX = 'graph-trial/20260908/workers/cfo';
const COHORT_PREFIX = 'graph-trial/20260908/catalog-cohorts';
const MAX_BYTES = 16 * 1024 * 1024 + 1024;
const DEADLINE_MS = 15_000;
const RUN = /^run_[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;
const PRODUCER = /^[a-z][a-z0-9-]{0,63}$/;
const COHORT = /^[a-z0-9][a-z0-9_.:-]{0,95}$/;
const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export type RelationshipHistoryRead = {
  key: string;
  versionId: string;
  signal: AbortSignal;
  maxBytes: number;
};
export type RelationshipHistoryResponse = { status: number; headers: Headers; body: Buffer };
export type RelationshipHistoryS3 = { readVersion(input: RelationshipHistoryRead): Promise<RelationshipHistoryResponse> };
export interface RelationshipHistoryS3Deps {
  resolveCredentials?: () => Promise<AwsCredentials | null>;
  signRequest?: (input: Parameters<typeof signRequest>[0]) => SignedRequest;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function jsonSha(value: string | undefined): boolean {
  return !!value && value.endsWith('.json') && SHA.test(value.slice(0, -5));
}
function artifactKey(key: string): boolean {
  const parts = key.split('/');
  if (parts.slice(0, 4).join('/') !== ARTIFACT_PREFIX || !RUN.test(parts[4] ?? '')) return false;
  const rest = parts.slice(5);
  return rest.length === 6 && rest[0] === 'relationship-producers' && PRODUCER.test(rest[1] ?? '') &&
    rest[2] === 'resolution-artifacts' && rest[3] === 'sha256' && /^[a-f0-9]{2}$/.test(rest[4] ?? '') &&
    jsonSha(rest[5]) && rest[5]!.startsWith(rest[4]!);
}
function cohortKey(key: string): boolean {
  const parts = key.split('/');
  if (parts.slice(0, 3).join('/') !== COHORT_PREFIX || !COHORT.test(parts[3] ?? '') || parts[4] !== 'server') return false;
  if (parts.length === 7 && parts[5] === 'admissions') return RUN.test(parts[6]?.slice(0, -5) ?? '') && parts[6]?.endsWith('.json') === true;
  return parts.length === 7 && parts[5] === 'proposals' && jsonSha(parts[6]);
}
function validKey(key: string): boolean { return artifactKey(key) || cohortKey(key); }
function validVersionId(value: string): boolean {
  return value !== 'null' && value.length > 0 && value.length <= 1024 && !/\s/u.test(value) && /^[^\p{C}]+$/u.test(value);
}
function limit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BYTES) throw new Error('response_size');
  return value;
}
function declaredLength(headers: Headers): number | null {
  const value = headers.get('content-length');
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) throw new Error('response_size');
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new Error('response_size');
  return size;
}
async function cancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([reader.cancel().catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('deadline');
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('deadline'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function deadline(source: AbortSignal, now: () => number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (source.aborted) abort(); else source.addEventListener('abort', abort, { once: true });
  const expires = now() + DEADLINE_MS;
  const timer = setTimeout(() => controller.abort(), Math.max(0, expires - now()));
  return { signal: controller.signal, close: () => { clearTimeout(timer); source.removeEventListener('abort', abort); } };
}

/** Read only version-pinned S3 transport for relationship history and cohort receipts. */
export function createRelationshipHistoryS3(deps: RelationshipHistoryS3Deps = {}): RelationshipHistoryS3 {
  const credentialsOf = deps.resolveCredentials ?? resolveAwsCredentials;
  const signer = deps.signRequest ?? signRequest;
  const fetcher = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  return { readVersion: async (input) => {
    if (input.signal.aborted) throw new Error('deadline');
    if (!validKey(input.key)) throw new Error('key');
    if (!validVersionId(input.versionId)) throw new Error('version');
    const maxBytes = limit(input.maxBytes);
    const bound = deadline(input.signal, now);
    try {
      const credentials = await abortable(credentialsOf(), bound.signal);
      if (!credentials || bound.signal.aborted) throw new Error('credentials');
      const host = `${BUCKET}.s3.${REGION}.amazonaws.com`;
      const path = `/${input.key}`;
      const query = { versionId: input.versionId };
      const signed = signer({ method: 'GET', host, path, query, region: REGION, service: 's3', credentials,
        extraHeaders: { 'x-amz-content-sha256': EMPTY_SHA256 } });
      const encodedQuery = canonicalQueryString(query);
      const response = await abortable(fetcher(`https://${host}${canonicalUri(path)}?${encodedQuery}`, {
        method: 'GET', headers: signed.headers, signal: bound.signal, redirect: 'error',
      }), bound.signal);
      const declared = declaredLength(response.headers);
      if (declared !== null && declared > maxBytes) {
        if (response.body) await cancel(response.body.getReader());
        throw new Error('response_size');
      }
      if (!response.body) {
        if (declared !== null && declared !== 0) throw new Error('response_size');
        return { status: response.status, headers: response.headers, body: Buffer.alloc(0) };
      }
      const reader = response.body.getReader(), chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await abortable(reader.read(), bound.signal);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBytes) throw new Error('response_size');
          chunks.push(Buffer.from(next.value));
        }
      } catch (error) { await cancel(reader); throw error; }
      if (bound.signal.aborted) throw new Error('deadline');
      if (declared !== null && declared !== size) throw new Error('response_size');
      return { status: response.status, headers: response.headers, body: Buffer.concat(chunks, size) };
    } finally { bound.close(); }
  } };
}

export const relationshipHistoryS3Test = { BUCKET, REGION, ARTIFACT_PREFIX, COHORT_PREFIX, MAX_BYTES, validKey, validVersionId };
