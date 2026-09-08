import { createHash } from 'node:crypto';
import {
  CFO_TEXT_SNAPSHOT_SCHEMA,
  type CfoTextChunk,
  CfoTextSnapshotResult,
  CfoTextSource,
} from './cfo-text-snapshot.js';

export const CFO_TEXT_PREPARATION_SCHEMA = 'cfo-text-preparation-v1';
export const CFO_TEXT_CHUNK_RESPONSE_SCHEMA = 'cfo-text-prepared-chunk-v1';
export const CFO_TEXT_PREPARATION_MAX_BYTES = 1024 * 1024;
export const CFO_TEXT_PREPARATION_MAX_CHUNKS = 100;
const BUNDLE_MAX_BYTES = 240 * 1024;
const MAX_STORE_RESPONSE_BYTES = 512 * 1024;
const RUN_ID = /^run_[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^txtsnap_[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;

type StoreRequest = Readonly<{
  method: 'GET' | 'PUT';
  key: string;
  headers?: Readonly<Record<string, string>>;
  body?: Buffer;
  signal: AbortSignal;
}>;
type StoreResponse = Readonly<{ status: number; headers: Headers; body: Buffer }>;
type Store = (request: StoreRequest) => Promise<StoreResponse>;
type SourceReader = Readonly<{
  readVersionPinnedPage: (
    source: CfoTextSource,
    options: { signal: AbortSignal },
  ) => Promise<CfoTextSnapshotResult>;
}>;
type SourceResolver = (
  documentOrdinal: number,
  options: { signal: AbortSignal },
) => Promise<CfoTextSource>;
type Recheck = (options: { signal: AbortSignal }) => Promise<void>;

export interface CfoTextPreparationControllerOptions {
  runId: string;
  sourceReader: SourceReader;
  resolveSource: SourceResolver;
  recheck: Recheck;
  store: Store;
  maxPreparedBytes?: number;
  maxChunks?: number;
}

type ChunkReference = Readonly<{
  ordinal: number;
  start_utf16: number;
  end_utf16: number;
  start_byte: number;
  end_byte: number;
  text_sha256: string;
  bundle_ordinal: number;
}>;
type BundleReference = Readonly<{
  ordinal: number;
  bundle_sha256: string;
  first_chunk_ordinal: number;
  last_chunk_ordinal: number;
}>;

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function active(signal: AbortSignal): void {
  if (signal.aborted) fail('cfo_text_preparation_deadline');
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value as Record<string, unknown>).sort().join('\0') === [...keys].sort().join('\0');
}
function boundedJson(response: StoreResponse): unknown {
  if (response.body.length > MAX_STORE_RESPONSE_BYTES) fail('cfo_text_preparation_corrupt');
  try { return JSON.parse(response.body.toString('utf8')); }
  catch { fail('cfo_text_preparation_corrupt'); }
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function chunkMetadata(chunk: CfoTextChunk) {
  return Object.freeze({
    ordinal: chunk.ordinal,
    start_utf16: chunk.start_utf16,
    end_utf16: chunk.end_utf16,
    start_byte: chunk.start_byte,
    end_byte: chunk.end_byte,
    text_sha256: chunk.text_sha256,
  });
}
function validateChunk(chunk: CfoTextChunk, expectedOrdinal: number): void {
  if (!exact(chunk, ['ordinal','start_utf16','end_utf16','start_byte','end_byte','text_sha256','text']) ||
      chunk.ordinal !== expectedOrdinal || !Number.isSafeInteger(chunk.start_utf16) || chunk.start_utf16 < 0 ||
      !Number.isSafeInteger(chunk.end_utf16) || chunk.end_utf16 <= chunk.start_utf16 ||
      chunk.end_utf16 - chunk.start_utf16 !== chunk.text.length ||
      !Number.isSafeInteger(chunk.start_byte) || chunk.start_byte < 0 ||
      !Number.isSafeInteger(chunk.end_byte) || chunk.end_byte <= chunk.start_byte ||
      Buffer.byteLength(chunk.text, 'utf8') !== chunk.end_byte - chunk.start_byte ||
      !SHA.test(chunk.text_sha256) || digest(chunk.text) !== chunk.text_sha256 ||
      typeof chunk.text !== 'string' || chunk.text.length < 1 || chunk.text.length > 16_000 ||
      Buffer.byteLength(chunk.text, 'utf8') > 16 * 1024) fail('cfo_text_preparation_invalid');
}
function validDescriptor(value: unknown, source: CfoTextSource, chunkCount: number): value is Record<string, unknown> {
  const keys = ['schema','room','source_index','source_document_version','catalog_source_sha256',
    'source_lineage_status','source_path_hash','sidecar_path_hash','sidecar_etag','sidecar_version_id',
    'sidecar_content_sha256','total_bytes','total_chars_utf16','chunk_count','chunk_overlap_chars'];
  if (!exact(value, keys)) return false;
  return value.schema === CFO_TEXT_SNAPSHOT_SCHEMA && value.room === 'finance' &&
    value.source_index === 'finance-cfo-source-docs' &&
    value.source_document_version === source.document_version_id &&
    value.catalog_source_sha256 === source.source_version &&
    value.source_lineage_status === 'catalog_association_only' &&
    value.source_path_hash === source.source_path_hash &&
    value.sidecar_path_hash === digest(`_TEXT/${source.path}.txt`) &&
    typeof value.sidecar_etag === 'string' && /^"[^"\r\n]{1,156}"$/.test(value.sidecar_etag) &&
    typeof value.sidecar_version_id === 'string' && value.sidecar_version_id.length > 0 &&
    value.sidecar_version_id.length <= 1024 && !/[\r\n\0]/.test(value.sidecar_version_id) &&
    SHA.test(String(value.sidecar_content_sha256)) &&
    Number.isSafeInteger(value.total_bytes) && (value.total_bytes as number) > 0 &&
    Number.isSafeInteger(value.total_chars_utf16) && (value.total_chars_utf16 as number) > 0 &&
    value.chunk_count === chunkCount && value.chunk_overlap_chars === 200;
}
function validIdentityChunk(value: unknown, ordinal: number): boolean {
  if (!exact(value, ['ordinal','start_utf16','end_utf16','start_byte','end_byte','text_sha256'])) return false;
  return value.ordinal === ordinal && Number.isSafeInteger(value.start_utf16) &&
    Number.isSafeInteger(value.end_utf16) && (value.end_utf16 as number) > (value.start_utf16 as number) &&
    Number.isSafeInteger(value.start_byte) && Number.isSafeInteger(value.end_byte) &&
    (value.start_byte as number) >= 0 && (value.end_byte as number) > (value.start_byte as number) &&
    SHA.test(String(value.text_sha256));
}
function buildBundles(runId: string, snapshotId: string, chunks: readonly CfoTextChunk[]) {
  const bodies: Array<{ value: Record<string, unknown>; body: string; hash: string }> = [];
  let pending: CfoTextChunk[] = [];
  function flush() {
    if (!pending.length) return;
    const ordinal = bodies.length;
    const value = {
      schema: 'cfo-text-chunk-bundle-v1', run_id: runId, snapshot_id: snapshotId,
      bundle_ordinal: ordinal, chunks: pending,
    };
    const body = canonical(value);
    if (Buffer.byteLength(body) > BUNDLE_MAX_BYTES) fail('cfo_text_preparation_oversize');
    bodies.push({ value, body, hash: digest(body) });
    pending = [];
  }
  for (const chunk of chunks) {
    const trial = [...pending, chunk];
    const value = {
      schema: 'cfo-text-chunk-bundle-v1', run_id: runId, snapshot_id: snapshotId,
      bundle_ordinal: bodies.length, chunks: trial,
    };
    if (pending.length && Buffer.byteLength(canonical(value)) > BUNDLE_MAX_BYTES) flush();
    pending.push(chunk);
  }
  flush();
  return bodies;
}
function manifestKey(prefix: string, snapshotId: string): string {
  return `${prefix}/text-snapshots/${snapshotId}/manifest.json`;
}
function bundleKey(prefix: string, snapshotId: string, ordinal: number, hash: string): string {
  return `${prefix}/text-snapshots/${snapshotId}/bundles/${ordinal}-${hash}.json`;
}

/**
 * Persistence controller for an authenticated CFO route. The broker must inject
 * resolveSource and recheck closures captured from its trusted auth/policy context.
 * Request bodies supply only a document ordinal or a prepared snapshot id/ordinal.
 */
export function createCfoTextPreparationController(options: CfoTextPreparationControllerOptions) {
  if (!options || !RUN_ID.test(options.runId || '') || typeof options.resolveSource !== 'function' ||
      typeof options.recheck !== 'function' || typeof options.store !== 'function' ||
      typeof options.sourceReader?.readVersionPinnedPage !== 'function') fail('cfo_text_preparation_configuration');
  const maxPreparedBytes = options.maxPreparedBytes ?? CFO_TEXT_PREPARATION_MAX_BYTES;
  const maxChunks = options.maxChunks ?? CFO_TEXT_PREPARATION_MAX_CHUNKS;
  if (!Number.isSafeInteger(maxPreparedBytes) || maxPreparedBytes < 1 ||
      maxPreparedBytes > CFO_TEXT_PREPARATION_MAX_BYTES ||
      !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > CFO_TEXT_PREPARATION_MAX_CHUNKS) {
    fail('cfo_text_preparation_configuration');
  }
  const prefix = `graph-trial/20260908/workers/cfo/${options.runId}`;

  async function recheck(signal: AbortSignal): Promise<void> {
    active(signal);
    await options.recheck({ signal });
    active(signal);
  }
  async function getExact(key: string, expectedBody: string, signal: AbortSignal): Promise<void> {
    const response = await options.store({ method: 'GET', key, signal });
    active(signal);
    if (response.status !== 200 || response.body.length !== Buffer.byteLength(expectedBody) ||
        response.body.toString('utf8') !== expectedBody) fail('cfo_text_preparation_conflict');
  }
  async function persistImmutable(key: string, body: string, signal: AbortSignal): Promise<void> {
    await recheck(signal);
    let response: StoreResponse;
    try {
      response = await options.store({ method: 'PUT', key,
        headers: Object.freeze({ 'content-type': 'application/json', 'if-none-match': '*' }),
        body: Buffer.from(body), signal });
    } catch {
      active(signal);
      await getExact(key, body, signal);
      await recheck(signal);
      return;
    }
    active(signal);
    if (![200,201,409,412].includes(response.status)) fail('cfo_text_preparation_unknown');
    await getExact(key, body, signal);
    await recheck(signal);
  }

  return Object.freeze({
    async prepare(
      input: Readonly<{ document_ordinal: number }>,
      { signal = AbortSignal.timeout(15_000) }: { signal?: AbortSignal } = {},
    ) {
      if (!exact(input, ['document_ordinal']) || !Number.isSafeInteger(input.document_ordinal) ||
          input.document_ordinal < 0 || input.document_ordinal >= 100) fail('cfo_text_preparation_request');
      await recheck(signal);
      const source = await options.resolveSource(input.document_ordinal, { signal });
      active(signal);
      const snapshot = await options.sourceReader.readVersionPinnedPage(source, { signal });
      await recheck(signal);
      if (snapshot.outcome !== 'ready') {
        return freeze({
          schema: CFO_TEXT_PREPARATION_SCHEMA,
          run_id: options.runId,
          document_ordinal: input.document_ordinal,
          outcome: snapshot.outcome,
          snapshot_id: null,
          source_document_version: snapshot.source_document_version,
          sidecar_content_sha256: null,
          chunk_count: 0,
          manifest_sha256: null,
          observed_bytes: snapshot.observed_bytes,
          paid_fallback: false,
        });
      }
      if (snapshot.descriptor.total_bytes > maxPreparedBytes || snapshot.chunks.length > maxChunks) {
        return freeze({
          schema: CFO_TEXT_PREPARATION_SCHEMA,
          run_id: options.runId,
          document_ordinal: input.document_ordinal,
          outcome: 'preparation_oversize',
          snapshot_id: null,
          source_document_version: snapshot.descriptor.source_document_version,
          sidecar_content_sha256: snapshot.descriptor.sidecar_content_sha256,
          chunk_count: snapshot.chunks.length,
          manifest_sha256: null,
          observed_bytes: snapshot.descriptor.total_bytes,
          paid_fallback: false,
        });
      }
      snapshot.chunks.forEach(validateChunk);
      const identity = freeze({
        schema: CFO_TEXT_PREPARATION_SCHEMA,
        run_id: options.runId,
        document_ordinal: input.document_ordinal,
        descriptor: snapshot.descriptor,
        chunks: snapshot.chunks.map(chunkMetadata),
      });
      const snapshotId = `txtsnap_${digest(canonical(identity))}`;
      const bundles = buildBundles(options.runId, snapshotId, snapshot.chunks);
      const bundleReferences: BundleReference[] = [];
      const chunkReferences: ChunkReference[] = [];
      for (const bundle of bundles) {
        const value = bundle.value;
        const bundleChunks = value.chunks as readonly CfoTextChunk[];
        const ordinal = value.bundle_ordinal as number;
        await persistImmutable(bundleKey(prefix, snapshotId, ordinal, bundle.hash), bundle.body, signal);
        bundleReferences.push(Object.freeze({
          ordinal,
          bundle_sha256: bundle.hash,
          first_chunk_ordinal: bundleChunks[0].ordinal,
          last_chunk_ordinal: bundleChunks[bundleChunks.length - 1].ordinal,
        }));
        for (const chunk of bundleChunks) {
          chunkReferences.push(Object.freeze({ ...chunkMetadata(chunk), bundle_ordinal: ordinal }));
        }
      }
      const manifestContent = freeze({
        schema: 'cfo-text-prepared-manifest-v1',
        snapshot_id: snapshotId,
        identity,
        bundles: bundleReferences,
        chunks: chunkReferences,
      });
      const manifestSha256 = digest(canonical(manifestContent));
      const manifest = freeze({ ...manifestContent, manifest_sha256: manifestSha256 });
      await persistImmutable(manifestKey(prefix, snapshotId), canonical(manifest), signal);
      await recheck(signal);
      return freeze({
        schema: CFO_TEXT_PREPARATION_SCHEMA,
        run_id: options.runId,
        document_ordinal: input.document_ordinal,
        outcome: 'ready',
        snapshot_id: snapshotId,
        source_document_version: snapshot.descriptor.source_document_version,
        sidecar_content_sha256: snapshot.descriptor.sidecar_content_sha256,
        chunk_count: snapshot.chunks.length,
        manifest_sha256: manifestSha256,
        observed_bytes: snapshot.descriptor.total_bytes,
        paid_fallback: false,
      });
    },

    async readChunk(
      input: Readonly<{ snapshot_id: string; ordinal: number }>,
      { signal = AbortSignal.timeout(15_000) }: { signal?: AbortSignal } = {},
    ) {
      if (!exact(input, ['snapshot_id','ordinal']) || !SNAPSHOT_ID.test(input.snapshot_id || '') ||
          !Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= maxChunks) {
        fail('cfo_text_chunk_request');
      }
      await recheck(signal);
      const manifestResponse = await options.store({ method: 'GET',
        key: manifestKey(prefix, input.snapshot_id), signal });
      active(signal);
      if (manifestResponse.status === 404) fail('cfo_text_chunk_not_found');
      if (manifestResponse.status !== 200) fail('cfo_text_chunk_unknown');
      const manifestValue = boundedJson(manifestResponse);
      if (!exact(manifestValue, ['schema','snapshot_id','identity','bundles','chunks','manifest_sha256']) ||
          manifestValue.schema !== 'cfo-text-prepared-manifest-v1' || manifestValue.snapshot_id !== input.snapshot_id ||
          !SHA.test(String(manifestValue.manifest_sha256)) ||
          manifestValue.manifest_sha256 !== digest(canonical({
            schema: manifestValue.schema,
            snapshot_id: manifestValue.snapshot_id,
            identity: manifestValue.identity,
            bundles: manifestValue.bundles,
            chunks: manifestValue.chunks,
          })) || !Array.isArray(manifestValue.chunks) || !Array.isArray(manifestValue.bundles)) {
        fail('cfo_text_preparation_corrupt');
      }
      const identity = manifestValue.identity;
      if (!exact(identity, ['schema','run_id','document_ordinal','descriptor','chunks']) ||
          identity.schema !== CFO_TEXT_PREPARATION_SCHEMA || identity.run_id !== options.runId ||
          !Number.isSafeInteger(identity.document_ordinal) || (identity.document_ordinal as number) < 0 ||
          (identity.document_ordinal as number) >= 100 || !Array.isArray(identity.chunks) ||
          identity.chunks.length < 1 || identity.chunks.length > maxChunks ||
          identity.chunks.length !== manifestValue.chunks.length ||
          identity.chunks.some((value, ordinal) => !validIdentityChunk(value, ordinal)) ||
          `txtsnap_${digest(canonical(identity))}` !== input.snapshot_id) {
        fail('cfo_text_preparation_corrupt');
      }
      const source = await options.resolveSource(identity.document_ordinal as number, { signal });
      active(signal);
      if (!Object.isFrozen(source) || !validDescriptor(identity.descriptor, source, identity.chunks.length)) {
        fail('cfo_text_preparation_corrupt');
      }
      await recheck(signal);
      const descriptor = identity.descriptor;
      const chunkRef = manifestValue.chunks[input.ordinal] as Record<string, unknown> | undefined;
      if (!exact(chunkRef, ['ordinal','start_utf16','end_utf16','start_byte','end_byte','text_sha256','bundle_ordinal']) ||
          chunkRef.ordinal !== input.ordinal || !SHA.test(String(chunkRef.text_sha256)) ||
          !Number.isSafeInteger(chunkRef.bundle_ordinal)) fail('cfo_text_preparation_corrupt');
      const bundleRef = manifestValue.bundles[chunkRef.bundle_ordinal as number] as Record<string, unknown> | undefined;
      if (!exact(bundleRef, ['ordinal','bundle_sha256','first_chunk_ordinal','last_chunk_ordinal']) ||
          bundleRef.ordinal !== chunkRef.bundle_ordinal || !SHA.test(String(bundleRef.bundle_sha256))) {
        fail('cfo_text_preparation_corrupt');
      }
      const key = bundleKey(prefix, input.snapshot_id, bundleRef.ordinal as number, String(bundleRef.bundle_sha256));
      const bundleResponse = await options.store({ method: 'GET', key, signal });
      active(signal);
      if (bundleResponse.status !== 200 || digest(bundleResponse.body) !== bundleRef.bundle_sha256) {
        fail('cfo_text_preparation_corrupt');
      }
      const bundle = boundedJson(bundleResponse);
      if (!exact(bundle, ['schema','run_id','snapshot_id','bundle_ordinal','chunks']) ||
          bundle.schema !== 'cfo-text-chunk-bundle-v1' || bundle.run_id !== options.runId ||
          bundle.snapshot_id !== input.snapshot_id || bundle.bundle_ordinal !== bundleRef.ordinal ||
          !Array.isArray(bundle.chunks)) fail('cfo_text_preparation_corrupt');
      const chunk = bundle.chunks.find((candidate: unknown) =>
        !!candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).ordinal === input.ordinal) as
        CfoTextChunk | undefined;
      if (!chunk) fail('cfo_text_preparation_corrupt');
      validateChunk(chunk, input.ordinal);
      if (chunk.start_utf16 !== chunkRef.start_utf16 || chunk.end_utf16 !== chunkRef.end_utf16 ||
          chunk.start_byte !== chunkRef.start_byte || chunk.end_byte !== chunkRef.end_byte ||
          chunk.text_sha256 !== chunkRef.text_sha256) fail('cfo_text_preparation_corrupt');
      await recheck(signal);
      return freeze({
        schema: CFO_TEXT_CHUNK_RESPONSE_SCHEMA,
        snapshot_id: input.snapshot_id,
        source_document_version: descriptor.source_document_version,
        manifest_sha256: manifestValue.manifest_sha256,
        sidecar_content_sha256: descriptor.sidecar_content_sha256,
        ordinal: chunk.ordinal,
        start_utf16: chunk.start_utf16,
        end_utf16: chunk.end_utf16,
        start_byte: chunk.start_byte,
        end_byte: chunk.end_byte,
        text_sha256: chunk.text_sha256,
        text: chunk.text,
      });
    },
  });
}