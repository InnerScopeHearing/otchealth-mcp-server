import { createHash } from 'node:crypto';
import type { AuthContext } from '../auth/bearer.js';
import { s3LocationFor } from '../legal/s3-blob-store.js';
import {
  canonicalQueryString,
  canonicalUri,
  resolveAwsCredentials,
  signRequest,
  type AwsCredentials,
} from '../search/sigv4.js';
import { isLaneAllowed } from '../tools/kb/search-privileged.js';

export const CFO_TEXT_SNAPSHOT_SCHEMA = 'cfo-version-pinned-text-snapshot-v1';
export const CFO_TEXT_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const CFO_TEXT_MAX_CHUNK_CHARS = 16_000;
export const CFO_TEXT_MAX_CHUNK_BYTES = 16 * 1024;
export const CFO_TEXT_CHUNK_OVERLAP_CHARS = 200;
export const CFO_TEXT_DEADLINE_MS = 45_000;

const CFO_ACCOUNT = 'otchealthcfodata';
const CFO_CONTAINER = 'cfo-source-docs';
const CFO_INDEX = 'finance-cfo-source-docs';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA = /^[a-f0-9]{64}$/;
const DOC_VERSION = /^docv_[a-f0-9]{64}$/;
const ETAG = /^"[^"\r\n]{1,156}"$/;

export type CfoTextSource = Readonly<{
  room: 'finance';
  source_index: typeof CFO_INDEX;
  path: string;
  source_path_hash: string;
  document_version_id: string;
  source_version: string;
}>;

export type CfoTextChunk = Readonly<{
  ordinal: number;
  start_utf16: number;
  end_utf16: number;
  start_byte: number;
  end_byte: number;
  text_sha256: string;
  text: string;
}>;

export type CfoTextSnapshotResult =
  | Readonly<{
      outcome: 'ready';
      descriptor: Readonly<{
        schema: typeof CFO_TEXT_SNAPSHOT_SCHEMA;
        room: 'finance';
        source_index: typeof CFO_INDEX;
        source_document_version: string;
        catalog_source_sha256: string;
        source_lineage_status: 'catalog_association_only';
        source_path_hash: string;
        sidecar_path_hash: string;
        sidecar_etag: string;
        sidecar_version_id: string;
        sidecar_content_sha256: string;
        total_bytes: number;
        total_chars_utf16: number;
        chunk_count: number;
        chunk_overlap_chars: number;
      }>;
      chunks: readonly CfoTextChunk[];
    }>
  | Readonly<{
      outcome: 'missing_text' | 'oversize' | 'invalid_utf8' | 'source_changed';
      source_document_version: string;
      catalog_source_sha256: string;
      source_path_hash: string;
      observed_bytes: number | null;
      chunks: readonly never[];
    }>;

type CallerContext = Pick<AuthContext, 'caller_agent' | 'connector_surface'>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type CredentialProvider = (signal: AbortSignal) => Promise<AwsCredentials | null>;
type Signer = typeof signRequest;

export interface CfoTextSnapshotReaderOptions {
  callerContext: CallerContext;
  credentialProvider?: CredentialProvider;
  signer?: Signer;
  fetchImpl?: FetchLike;
  region?: string;
  deadlineMs?: number;
  maxSourceBytes?: number;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value as Record<string, unknown>).sort().join('\0') === [...keys].sort().join('\0');
}
function active(signal: AbortSignal): void {
  if (signal.aborted) fail('cfo_text_deadline');
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  active(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('cfo_text_deadline'), { code: 'cfo_text_deadline' }));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function normalizedSourcePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 ||
      /^(?:\/|[a-zA-Z]:|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(value)) return null;
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (!parts.length || parts[0].toLowerCase() === '_text') return null;
  return parts.join('/');
}
function validateSource(value: unknown): CfoTextSource {
  const keys = ['room','source_index','path','source_path_hash','document_version_id','source_version'];
  if (!Object.isFrozen(value) || !exact(value, keys)) fail('cfo_text_source_invalid');
  const source = value as unknown as CfoTextSource;
  const path = normalizedSourcePath(source.path);
  if (!path || path !== source.path || source.room !== 'finance' || source.source_index !== CFO_INDEX ||
      !SHA.test(source.source_path_hash) || digest(path) !== source.source_path_hash ||
      !DOC_VERSION.test(source.document_version_id) || !SHA.test(source.source_version)) {
    fail('cfo_text_source_invalid');
  }
  return Object.freeze({ ...source });
}
function emptyResult(
  outcome: Exclude<CfoTextSnapshotResult['outcome'], 'ready'>,
  source: CfoTextSource,
  observedBytes: number | null,
): CfoTextSnapshotResult {
  return Object.freeze({
    outcome,
    source_document_version: source.document_version_id,
    catalog_source_sha256: source.source_version,
    source_path_hash: source.source_path_hash,
    observed_bytes: observedBytes,
    chunks: Object.freeze([]),
  });
}
function boundedVersion(value: string | null): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 1024 && !/[\r\n\0]/.test(value);
}
function safeContentLength(value: string | null): number | null {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function adjustSurrogateBoundary(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}
function utf8Offsets(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  let byteOffset = 0;
  for (let index = 0; index < text.length;) {
    offsets[index] = byteOffset;
    const codePoint = text.codePointAt(index) as number;
    const units = codePoint > 0xffff ? 2 : 1;
    if (units === 2) offsets[index + 1] = byteOffset;
    byteOffset += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    index += units;
    offsets[index] = byteOffset;
  }
  return offsets;
}
function chunkText(text: string): readonly CfoTextChunk[] {
  const chunks: CfoTextChunk[] = [];
  const byteOffsets = utf8Offsets(text);
  let start = 0;
  while (start < text.length) {
    let low = start + 1;
    let high = Math.min(text.length, start + CFO_TEXT_MAX_CHUNK_CHARS);
    let end = start;
    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      if (byteOffsets[candidate] - byteOffsets[start] <= CFO_TEXT_MAX_CHUNK_BYTES) {
        end = candidate;
        low = candidate + 1;
      } else {
        high = candidate - 1;
      }
    }
    end = adjustSurrogateBoundary(text, start, end);
    if (end <= start) fail('cfo_text_chunk_invalid');
    const chunk = text.slice(start, end);
    chunks.push(Object.freeze({
      ordinal: chunks.length,
      start_utf16: start,
      end_utf16: end,
      start_byte: byteOffsets[start],
      end_byte: byteOffsets[end],
      text_sha256: digest(chunk),
      text: chunk,
    }));
    if (end === text.length) break;
    let next = Math.max(start + 1, end - CFO_TEXT_CHUNK_OVERLAP_CHARS);
    if (next > 0 && next < text.length) {
      const current = text.charCodeAt(next);
      const previous = text.charCodeAt(next - 1);
      if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) next--;
    }
    start = next;
  }
  return Object.freeze(chunks);
}
async function boundedCancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    reader.cancel().catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
async function discardResponse(response: Response): Promise<void> {
  if (response.body) await boundedCancel(response.body.getReader());
}
async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      active(signal);
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await boundedCancel(reader);
        return null;
      }
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    await boundedCancel(reader);
    throw error;
  }
  return Buffer.concat(chunks, size);
}

/**
 * Internal CFO-only source reader. The server must construct this with the trusted
 * requireConnectorAuth context and must still enforce active-run/config admission
 * before calling readVersionPinnedPage. No HTTP route or caller-supplied seat is
 * created here, and no credential, signature, URL or raw source path is returned.
 */
export function createCfoTextSnapshotReader(options: CfoTextSnapshotReaderOptions) {
  if (!options || options.callerContext?.caller_agent !== 'cfo' ||
      options.callerContext.connector_surface !== true ||
      !isLaneAllowed(CFO_INDEX, options.callerContext.caller_agent)) fail('cfo_text_forbidden');
  const location = s3LocationFor(CFO_ACCOUNT, CFO_CONTAINER);
  if (!location) fail('cfo_text_configuration');
  const fixedLocation = Object.freeze({ ...location });
  const region = options.region ?? 'us-east-1';
  const deadlineMs = options.deadlineMs ?? CFO_TEXT_DEADLINE_MS;
  const maxSourceBytes = options.maxSourceBytes ?? CFO_TEXT_MAX_SOURCE_BYTES;
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > CFO_TEXT_DEADLINE_MS ||
      !Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > CFO_TEXT_MAX_SOURCE_BYTES ||
      (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function') ||
      (options.signer !== undefined && typeof options.signer !== 'function') ||
      (options.credentialProvider !== undefined && typeof options.credentialProvider !== 'function')) {
    fail('cfo_text_configuration');
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const signer = options.signer ?? signRequest;
  const credentialProvider: CredentialProvider = options.credentialProvider ??
    (async () => resolveAwsCredentials());

  async function request(
    method: 'HEAD' | 'GET', key: string, credentials: AwsCredentials,
    signal: AbortSignal, versionId?: string, etag?: string,
  ): Promise<Response> {
    active(signal);
    const host = `${fixedLocation.bucket}.s3.${region}.amazonaws.com`;
    const rawPath = `/${fixedLocation.keyPrefix}${key}`;
    const query = versionId ? { versionId } : undefined;
    const extraHeaders = {
      'x-amz-content-sha256': EMPTY_SHA256,
      ...(etag ? { 'if-match': etag } : {}),
    };
    const signed = signer({ method, host, path: rawPath, query, region,
      service: 's3', credentials, extraHeaders });
    const suffix = query ? `?${canonicalQueryString(query)}` : '';
    return abortable(fetchImpl(`https://${host}${canonicalUri(rawPath)}${suffix}`, {
      method, headers: signed.headers, signal, redirect: 'error',
    }), signal);
  }

  return Object.freeze({
    async readVersionPinnedPage(sourceValue: CfoTextSource, { signal }: { signal?: AbortSignal } = {}): Promise<CfoTextSnapshotResult> {
      const source = validateSource(sourceValue);
      const internal = AbortSignal.timeout(deadlineMs);
      const boundedSignal = signal ? AbortSignal.any([signal, internal]) : internal;
      active(boundedSignal);
      const credentials = await abortable(credentialProvider(boundedSignal), boundedSignal);
      active(boundedSignal);
      if (!credentials) fail('cfo_text_credentials_unavailable');
      const sidecarPath = `_TEXT/${source.path}.txt`;
      const head = await request('HEAD', sidecarPath, credentials, boundedSignal);
      if (head.status === 404) return emptyResult('missing_text', source, null);
      if (head.status !== 200) fail('cfo_text_source_unavailable');
      const etag = head.headers.get('etag');
      const versionId = head.headers.get('x-amz-version-id');
      const length = safeContentLength(head.headers.get('content-length'));
      if (!etag || !ETAG.test(etag) || !boundedVersion(versionId) || length === null) {
        fail('cfo_text_source_unavailable');
      }
      if (length > maxSourceBytes) return emptyResult('oversize', source, length);
      if (length === 0) return emptyResult('missing_text', source, 0);

      const get = await request('GET', sidecarPath, credentials, boundedSignal, versionId, etag);
      if (get.status === 404 || get.status === 412) {
        await discardResponse(get);
        return emptyResult('source_changed', source, length);
      }
      if (get.status !== 200) {
        await discardResponse(get);
        fail('cfo_text_source_unavailable');
      }
      if (get.headers.get('etag') !== etag || get.headers.get('x-amz-version-id') !== versionId) {
        await discardResponse(get);
        return emptyResult('source_changed', source, length);
      }
      const body = await readBounded(get, maxSourceBytes, boundedSignal);
      if (!body) return emptyResult('oversize', source, null);
      if (body.length !== length) return emptyResult('source_changed', source, body.length);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
      catch { return emptyResult('invalid_utf8', source, body.length); }
      const chunks = chunkText(text);
      if (!chunks.length) return emptyResult('missing_text', source, body.length);
      const descriptor = Object.freeze({
        schema: CFO_TEXT_SNAPSHOT_SCHEMA,
        room: 'finance' as const,
        source_index: CFO_INDEX,
        source_document_version: source.document_version_id,
        catalog_source_sha256: source.source_version,
        source_lineage_status: 'catalog_association_only' as const,
        source_path_hash: source.source_path_hash,
        sidecar_path_hash: digest(sidecarPath),
        sidecar_etag: etag,
        sidecar_version_id: versionId,
        sidecar_content_sha256: digest(body),
        total_bytes: body.length,
        total_chars_utf16: text.length,
        chunk_count: chunks.length,
        chunk_overlap_chars: CFO_TEXT_CHUNK_OVERLAP_CHARS,
      });
      return Object.freeze({ outcome: 'ready' as const, descriptor, chunks });
    },
  });
}