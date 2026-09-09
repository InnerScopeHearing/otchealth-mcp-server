/** Bounded finance catalog JSONL reader. Fresh HEAD metadata pins every call; immutable rows may be cached. */
import { createHash } from 'node:crypto';
import { canonicalUri, resolveAwsCredentials, signRequest } from '../search/sigv4.js';

export const GRAPH_CATALOG_MAX_BYTES = 192 * 1024 * 1024;
export const GRAPH_CATALOG_MAX_ROWS = 100_000;
export const GRAPH_CATALOG_MAX_LINE_BYTES = 1024 * 1024;
/** Cache only modest catalogs. Larger valid catalogs keep the original fresh HEAD + GET behavior. */
export const GRAPH_CATALOG_CACHE_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const GRAPH_CATALOG_CACHE_MAX_ROWS = 20_000;
export const GRAPH_CATALOG_CACHE_MAX_ENTRIES = 2;
export const GRAPH_CATALOG_CACHE_MAX_IN_FLIGHT = 2;
export const GRAPH_CATALOG_CACHE_MAX_WAITERS = 32;
export const GRAPH_CATALOG_CACHE_MAX_SHARED_WAITERS = 32;

const BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
const REGION = 'us-east-1';

export type GraphCatalogRawRequest = Readonly<{
  method: 'HEAD' | 'GET';
  key: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
}>;
export type GraphCatalogRawResponse = Readonly<{
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}>;
export type GraphCatalogRawS3 = (request: GraphCatalogRawRequest) => Promise<GraphCatalogRawResponse>;
export type PinnedCatalog = Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
  catalogEtag: string;
  catalogSourceSha256: string;
  catalogContentSha256: string;
  catalogVersionId: string | null;
  createdAt: string;
}>;

type CatalogHead = Readonly<{
  etag: string;
  size: number;
  modified: string;
  createdAt: string;
  versionId: string | null;
}>;
type CacheEntry = Readonly<{ catalog: PinnedCatalog; sourceBytes: number; rowCount: number }>;
type LoadRelease = () => void;
type LoadWaiter = {
  signal: AbortSignal;
  resolve: (release: LoadRelease) => void;
  reject: (error: Error) => void;
  abort: () => void;
};
type SharedLoad = {
  promise: Promise<PinnedCatalog>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
};
type CacheScope = {
  entries: Map<string, CacheEntry>;
  inFlight: Map<string, SharedLoad>;
  sourceBytes: number;
  rowCount: number;
  activeLoads: number;
  loadWaiters: LoadWaiter[];
};

const cacheScopes = new WeakMap<GraphCatalogRawS3, CacheScope>();

function safeKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith('graph-trial/') && key.length <= 1024 &&
    !/[\\%?#\u0000-\u001f\u007f]/.test(key) && key === key.normalize('NFC') &&
    !key.split('/').some(part => part === '' || part === '.' || part === '..');
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('catalog_cancelled');
}

async function bounded<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  active(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new Error('catalog_cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        active(signal);
        return fn();
      })
      .then(value => {
        cleanup();
        resolve(value);
      }, error => {
        cleanup();
        reject(error);
      });
    if (signal.aborted) abort();
  });
}

async function cancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.resolve().then(() => reader.cancel()).catch(() => undefined),
    new Promise(resolve => {
      timer = setTimeout(resolve, 100);
    }),
  ]);
  clearTimeout(timer);
}

function cacheScope(s3: GraphCatalogRawS3): CacheScope {
  const existing = cacheScopes.get(s3);
  if (existing) return existing;
  const created: CacheScope = {
    entries: new Map(),
    inFlight: new Map(),
    sourceBytes: 0,
    rowCount: 0,
    activeLoads: 0,
    loadWaiters: [],
  };
  cacheScopes.set(s3, created);
  return created;
}

function releaseLoadSlot(scope: CacheScope): void {
  scope.activeLoads--;
  while (scope.activeLoads < GRAPH_CATALOG_CACHE_MAX_IN_FLIGHT) {
    const waiter = scope.loadWaiters.shift();
    if (!waiter) return;
    waiter.signal.removeEventListener('abort', waiter.abort);
    if (waiter.signal.aborted) {
      waiter.reject(new Error('catalog_cancelled'));
      continue;
    }
    scope.activeLoads++;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      releaseLoadSlot(scope);
    });
  }
}

async function acquireLoadSlot(scope: CacheScope, signal: AbortSignal): Promise<LoadRelease> {
  active(signal);
  if (scope.activeLoads < GRAPH_CATALOG_CACHE_MAX_IN_FLIGHT) {
    scope.activeLoads++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseLoadSlot(scope);
    };
  }
  if (scope.loadWaiters.length >= GRAPH_CATALOG_CACHE_MAX_WAITERS) {
    throw new Error('catalog_reader_busy');
  }
  return new Promise((resolve, reject) => {
    const waiter: LoadWaiter = {
      signal,
      resolve,
      reject,
      abort: () => {
        const index = scope.loadWaiters.indexOf(waiter);
        if (index >= 0) scope.loadWaiters.splice(index, 1);
        reject(new Error('catalog_cancelled'));
      },
    };
    signal.addEventListener('abort', waiter.abort, { once: true });
    scope.loadWaiters.push(waiter);
    if (signal.aborted) waiter.abort();
  });
}

async function withLoadSlot<T>(
  scope: CacheScope,
  signal: AbortSignal,
  load: () => Promise<T>,
): Promise<T> {
  const release = await acquireLoadSlot(scope, signal);
  try {
    return await load();
  } finally {
    release();
  }
}

async function waitForSharedLoad(load: SharedLoad, signal: AbortSignal): Promise<PinnedCatalog> {
  active(signal);
  if (load.waiters >= GRAPH_CATALOG_CACHE_MAX_SHARED_WAITERS) {
    throw new Error('catalog_reader_busy');
  }
  load.waiters++;
  try {
    const catalog = await bounded(() => load.promise, signal);
    active(signal);
    return catalog;
  } finally {
    load.waiters--;
    if (load.waiters === 0 && !load.settled) load.controller.abort();
  }
}

function identityKey(key: string, sourceSha256: string, head: CatalogHead): string {
  return JSON.stringify([
    key,
    sourceSha256,
    head.etag,
    head.versionId,
    head.size,
    head.modified,
  ]);
}

function cached(scope: CacheScope, identity: string): PinnedCatalog | null {
  const entry = scope.entries.get(identity);
  if (!entry) return null;
  scope.entries.delete(identity);
  scope.entries.set(identity, entry);
  return entry.catalog;
}

function evictOldest(scope: CacheScope): void {
  const oldest = scope.entries.entries().next().value as [string, CacheEntry] | undefined;
  if (!oldest) return;
  scope.entries.delete(oldest[0]);
  scope.sourceBytes -= oldest[1].sourceBytes;
  scope.rowCount -= oldest[1].rowCount;
}

function publish(scope: CacheScope, identity: string, catalog: PinnedCatalog, sourceBytes: number): void {
  const rowCount = catalog.rows.length;
  if (sourceBytes > GRAPH_CATALOG_CACHE_MAX_SOURCE_BYTES || rowCount > GRAPH_CATALOG_CACHE_MAX_ROWS) return;
  const prior = scope.entries.get(identity);
  if (prior) {
    scope.entries.delete(identity);
    scope.sourceBytes -= prior.sourceBytes;
    scope.rowCount -= prior.rowCount;
  }
  const entry: CacheEntry = { catalog, sourceBytes, rowCount };
  scope.entries.set(identity, entry);
  scope.sourceBytes += sourceBytes;
  scope.rowCount += rowCount;
  while (
    scope.entries.size > GRAPH_CATALOG_CACHE_MAX_ENTRIES ||
    scope.sourceBytes > GRAPH_CATALOG_CACHE_MAX_SOURCE_BYTES ||
    scope.rowCount > GRAPH_CATALOG_CACHE_MAX_ROWS
  ) {
    evictOldest(scope);
  }
}

function freezeJson(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) continue;
    Object.freeze(current);
    const children = Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>);
    for (const child of children) pending.push(child);
  }
  return value;
}

function parseHead(response: GraphCatalogRawResponse): CatalogHead {
  const etag = response.headers.get('etag');
  const size = Number(response.headers.get('content-length'));
  const modified = response.headers.get('last-modified');
  const versionId = response.headers.get('x-amz-version-id');
  if (
    response.status !== 200 ||
    !etag ||
    etag.length > 160 ||
    !modified ||
    !Number.isFinite(Date.parse(modified)) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > GRAPH_CATALOG_MAX_BYTES ||
    (versionId !== null && (
      versionId.length < 1 ||
      versionId.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(versionId)
    ))
  ) {
    throw new Error('catalog_head_failed');
  }
  return {
    etag,
    size,
    modified,
    createdAt: new Date(modified).toISOString(),
    versionId,
  };
}

async function downloadCatalog(input: Readonly<{
  key: string;
  sourceSha256: string;
  head: CatalogHead;
  s3: GraphCatalogRawS3;
  signal: AbortSignal;
  expectedContentSha256?: string;
  expectedVersionId?: string;
}>): Promise<PinnedCatalog> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await bounded(
      () => input.s3({
        method: 'GET',
        key: input.key,
        headers: { 'if-match': input.head.etag },
        signal: input.signal,
      }),
      input.signal,
    );
    active(input.signal);
    reader = response.body?.getReader();
    if (response.status === 412) throw new Error('catalog_changed');
    if (response.status !== 200 || response.headers.get('etag') !== input.head.etag || !reader) {
      throw new Error('catalog_get_failed');
    }
    if (
      response.headers.get('last-modified') !== input.head.modified ||
      response.headers.get('x-amz-version-id') !== input.head.versionId
    ) {
      throw new Error('catalog_changed');
    }
    if (
      response.headers.has('content-length') &&
      Number(response.headers.get('content-length')) !== input.head.size
    ) {
      throw new Error('catalog_length_changed');
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const contentHash = createHash('sha256');
    const rows: Readonly<Record<string, unknown>>[] = [];
    let count = 0;
    let unparsed = '';

    const parse = (line: string) => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > GRAPH_CATALOG_MAX_LINE_BYTES) {
        throw new Error('catalog_line_too_large');
      }
      if (rows.length >= GRAPH_CATALOG_MAX_ROWS) throw new Error('catalog_too_many_rows');
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error('catalog_jsonl_invalid');
      }
      if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error('catalog_jsonl_invalid');
      }
      rows.push(freezeJson(value as Record<string, unknown>));
    };

    for (;;) {
      const part = await bounded(() => reader!.read(), input.signal);
      active(input.signal);
      if (part.done) break;
      count += part.value.byteLength;
      contentHash.update(part.value);
      if (count > input.head.size) throw new Error('catalog_length_changed');
      unparsed += decoder.decode(part.value, { stream: true });
      let end: number;
      while ((end = unparsed.indexOf('\n')) >= 0) {
        parse(unparsed.slice(0, end));
        unparsed = unparsed.slice(end + 1);
      }
      if (Buffer.byteLength(unparsed) > GRAPH_CATALOG_MAX_LINE_BYTES) {
        throw new Error('catalog_line_too_large');
      }
    }
    unparsed += decoder.decode();
    parse(unparsed);
    if (count !== input.head.size) throw new Error('catalog_length_changed');
    const catalogContentSha256 = contentHash.digest('hex');
    if (input.expectedContentSha256 !== undefined && input.expectedContentSha256 !== catalogContentSha256) throw new Error('catalog_content_changed');
    const after = await bounded(() => input.s3({ method: 'HEAD', key: input.key, signal: input.signal }), input.signal);
    const afterHead = parseHead(after);
    if (afterHead.etag !== input.head.etag || afterHead.size !== input.head.size || afterHead.modified !== input.head.modified || afterHead.versionId !== input.head.versionId) throw new Error('catalog_changed');
    active(input.signal);
    return Object.freeze({
      rows: Object.freeze(rows),
      catalogEtag: input.head.etag,
      catalogSourceSha256: input.sourceSha256,
      catalogContentSha256,
      catalogVersionId: input.head.versionId,
      createdAt: input.head.createdAt,
    });
  } finally {
    if (reader) await cancel(reader);
  }
}

export const defaultGraphCatalogS3: GraphCatalogRawS3 = async request => {
  if (!safeKey(request.key)) throw new Error('catalog_key_invalid');
  active(request.signal);
  const credentials = await bounded(() => resolveAwsCredentials(), request.signal);
  active(request.signal);
  if (!credentials) throw new Error('catalog_credentials');
  const host = `${BUCKET}.s3.${REGION}.amazonaws.com`;
  const signed = signRequest({
    method: request.method,
    host,
    path: '/' + request.key,
    region: REGION,
    service: 's3',
    credentials,
    extraHeaders: {
      'x-amz-content-sha256': createHash('sha256').update('').digest('hex'),
      ...(request.headers ?? {}),
    },
  });
  const response = await bounded(
    () => fetch('https://' + host + canonicalUri('/' + request.key), {
      method: request.method,
      headers: signed.headers,
      signal: request.signal,
      redirect: 'error',
    }),
    request.signal,
  );
  return { status: response.status, headers: response.headers, body: response.body };
};

export async function readPinnedGraphCatalog(input: Readonly<{
  key: string;
  sourceSha256: string;
  expectedContentSha256?: string;
  expectedVersionId?: string;
  createdAt?: string;
  s3?: GraphCatalogRawS3;
  signal?: AbortSignal;
}>): Promise<PinnedCatalog> {
  if (!safeKey(input.key) || !/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
    (input.expectedContentSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedContentSha256)) ||
    (input.expectedVersionId !== undefined && (!/^[A-Za-z0-9._-]{1,1024}$/.test(input.expectedVersionId) || input.expectedVersionId === 'null'))) {
    throw new Error('catalog_reader_request_invalid');
  }
  const internal = new AbortController();
  const timer = setTimeout(() => internal.abort(), 45_000);
  const signal = input.signal ? AbortSignal.any([input.signal, internal.signal]) : internal.signal;
  const s3 = input.s3 ?? defaultGraphCatalogS3;

  try {
    const headResponse = await bounded(() => s3({ method: 'HEAD', key: input.key, signal }), signal);
    active(signal);
    const head = parseHead(headResponse);
    if (input.createdAt !== undefined && input.createdAt !== head.createdAt) {
      throw new Error('catalog_timestamp_changed');
    }
    if (input.expectedVersionId !== undefined && input.expectedVersionId !== head.versionId) throw new Error('catalog_version_changed');

    const scope = cacheScope(s3);
    const identity = identityKey(input.key, input.sourceSha256, head);
    const ready = cached(scope, identity);
    if (ready) {
      if (input.expectedContentSha256 !== undefined && ready.catalogContentSha256 !== input.expectedContentSha256) throw new Error('catalog_content_changed');
      active(signal);
      return ready;
    }

    const existing = scope.inFlight.get(identity);
    if (existing) return await waitForSharedLoad(existing, signal);

    const sharedController = new AbortController();
    const sharedTimer = setTimeout(() => sharedController.abort(), 45_000);
    let shared!: SharedLoad;
    const promise = withLoadSlot(scope, sharedController.signal, () => downloadCatalog({
      key: input.key,
      sourceSha256: input.sourceSha256,
      head,
      s3,
      signal: sharedController.signal,
      expectedContentSha256: input.expectedContentSha256,
      expectedVersionId: input.expectedVersionId,
    })).then(catalog => {
      active(sharedController.signal);
      publish(scope, identity, catalog, head.size);
      return catalog;
    }).finally(() => {
      shared.settled = true;
      clearTimeout(shared.timer);
      if (scope.inFlight.get(identity) === shared) scope.inFlight.delete(identity);
    });
    shared = {
      promise,
      controller: sharedController,
      waiters: 0,
      settled: false,
      timer: sharedTimer,
    };
    scope.inFlight.set(identity, shared);
    return await waitForSharedLoad(shared, signal);
  } finally {
    clearTimeout(timer);
    internal.abort();
  }
}
