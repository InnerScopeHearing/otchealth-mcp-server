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
const PREFIX = 'graph-trial/20260908/workers/cfo';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024 + 1024;
const REQUEST_DEADLINE_MS = 15_000;
const RUN = /^run_[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
// Authorization of a particular producer is a route policy decision. The
// transport still accepts only the route's narrow producer identifier grammar.
const PRODUCER = /^[a-z][a-z0-9-]{0,63}$/;

export type RelationshipArtifactS3Request = {
  method: 'GET' | 'PUT';
  key: string;
  versionId?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
  maxBytes?: number;
};

export type RelationshipArtifactS3Response = {
  status: number;
  headers: Headers;
  body: Buffer;
};

export type RelationshipArtifactS3 = (
  request: RelationshipArtifactS3Request,
) => Promise<RelationshipArtifactS3Response>;

export interface RelationshipArtifactS3Deps {
  resolveCredentials?: () => Promise<AwsCredentials | null>;
  signRequest?: (input: Parameters<typeof signRequest>[0]) => SignedRequest;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function validVersionId(value: string): boolean {
  // Version IDs are opaque S3 values. Allow printable Unicode, including +, /, =,
  // but exclude controls and NUL so logging and canonical signing stay unambiguous.
  return value !== 'null' && value.length > 0 && value.length <= 1024 &&
    !/\s/u.test(value) && /^[^\p{C}]+$/u.test(value);
}

function validKey(key: string): boolean {
  const parts = key.split('/');
  if (parts.length < 5 || parts.slice(0, 4).join('/') !== PREFIX) return false;
  const run = parts[4];
  if (!RUN.test(run)) return false;
  const rest = parts.slice(5);
  if (rest.length === 2 && rest[0] === 'active-runs') {
    return SHA256.test(rest[1]?.replace(/\.json$/, '') ?? '') && rest[1] === rest[1]?.replace(/\.json$/, '') + '.json';
  }
  if (rest.length !== 6 || rest[0] !== 'relationship-producers' ||
      !PRODUCER.test(rest[1] ?? '') || rest[2] !== 'resolution-artifacts' ||
      rest[3] !== 'sha256' || !/^[a-f0-9]{2}$/.test(rest[4] ?? '')) return false;
  const file = rest[5];
  // There must be no trailing component and the shard must correspond to the hash.
  return SHA256.test(file?.replace(/\.json$/, '') ?? '') && file === file?.replace(/\.json$/, '') + '.json' &&
    file.startsWith(rest[4] ?? '');
}

function activeRunKey(key: string): boolean {
  const parts = key.split('/');
  return parts.length === 7 && parts.slice(0, 4).join('/') === PREFIX &&
    RUN.test(parts[4] ?? '') && parts[5] === 'active-runs' &&
    SHA256.test(parts[6]?.replace(/\.json$/, '') ?? '') &&
    parts[6] === parts[6]?.replace(/\.json$/, '') + '.json';
}

function requestLimit(value: number | undefined): number {
  if (value === undefined) return MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RESPONSE_BYTES) {
    throw new Error('response_size');
  }
  return value;
}

function contentLength(headers: Headers): number | null {
  const value = headers.get('content-length');
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) throw new Error('response_size');
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new Error('response_size');
  return size;
}

function safeHeaders(headers: Record<string, string> | undefined, body: Buffer | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (typeof value !== 'string' || Object.hasOwn(result, lower) ||
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n]/.test(value) ||
        ['host', 'authorization', 'content-length', 'x-amz-date', 'x-amz-content-sha256'].includes(lower)) {
      throw new Error('headers');
    }
    result[lower] = value;
  }
  result['x-amz-content-sha256'] = digest(body ?? Buffer.alloc(0));
  return result;
}

function immutablePutHeaders(headers: Record<string, string> | undefined): boolean {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (typeof value !== 'string' || Object.hasOwn(normalized, lower)) return false;
    normalized[lower] = value;
  }
  return normalized['if-none-match'] === '*' && !Object.hasOwn(normalized, 'if-match');
}

async function cancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reader.cancel().catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withDeadline(signal: AbortSignal, now: () => number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const due = now() + REQUEST_DEADLINE_MS;
  const timer = setTimeout(() => controller.abort(), Math.max(0, due - now()));
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('deadline');
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('deadline'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** A fixed-bucket transport for immutable CFO relationship artifacts only. */
export function createRelationshipArtifactS3(deps: RelationshipArtifactS3Deps = {}): RelationshipArtifactS3 {
  const credentialsOf = deps.resolveCredentials ?? resolveAwsCredentials;
  const signer = deps.signRequest ?? signRequest;
  const fetcher = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  return async (input) => {
    if (input.signal.aborted) throw new Error('deadline');
    if ((input.method !== 'GET' && input.method !== 'PUT') || !validKey(input.key)) throw new Error('key');
    if (input.method === 'PUT' && input.versionId !== undefined) throw new Error('version');
    if (input.versionId !== undefined && !validVersionId(input.versionId)) throw new Error('version');
    if (input.method === 'GET' && input.body !== undefined) throw new Error('body');
    if (input.method === 'PUT' && (!input.body || input.body.length > MAX_RESPONSE_BYTES)) throw new Error('body');
    if (input.method === 'PUT' && (activeRunKey(input.key) || !immutablePutHeaders(input.headers))) {
      throw new Error('precondition');
    }
    const limit = requestLimit(input.maxBytes);
    const deadline = withDeadline(input.signal, now);
    try {
      const credentials = await abortable(credentialsOf(), deadline.signal);
      if (!credentials || deadline.signal.aborted) throw new Error('credentials');
      const host = `${BUCKET}.s3.${REGION}.amazonaws.com`;
      const path = `/${input.key}`;
      const query = input.versionId === undefined ? undefined : { versionId: input.versionId };
      const body = input.body;
      const signed = signer({
        method: input.method, host, path, query, region: REGION, service: 's3', credentials,
        ...(body === undefined ? {} : { body }), extraHeaders: safeHeaders(input.headers, body),
      });
      const queryText = canonicalQueryString(query);
      const url = `https://${host}${canonicalUri(path)}${queryText ? `?${queryText}` : ''}`;
      const response = await abortable(fetcher(url, {
        method: input.method, headers: signed.headers,
        // Node accepts Buffer as a fetch body; its ambient fetch typings differ
        // between the bundled Node versions, so avoid depending on DOM BodyInit.
        ...(body === undefined ? {} : { body: body as never }),
        signal: deadline.signal, redirect: 'error',
      }), deadline.signal);
      const declared = contentLength(response.headers);
      if (declared !== null && declared > limit) {
        if (response.body) await cancel(response.body.getReader());
        throw new Error('response_size');
      }
      if (!response.body) return { status: response.status, headers: response.headers, body: Buffer.alloc(0) };
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await abortable(reader.read(), deadline.signal);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > limit) throw new Error('response_size');
          chunks.push(Buffer.from(next.value));
        }
      } catch (error) {
        await cancel(reader);
        throw error;
      }
      if (deadline.signal.aborted) throw new Error('deadline');
      if (declared !== null && declared !== size) throw new Error('response_size');
      return { status: response.status, headers: response.headers, body: Buffer.concat(chunks, size) };
    } finally {
      deadline.close();
    }
  };
}

export const relationshipArtifactS3Test = {
  BUCKET, REGION, PREFIX, MAX_RESPONSE_BYTES, REQUEST_DEADLINE_MS, validKey, validVersionId,
  activeRunKey,
};
