import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CFO_TEXT_PREPARATION_MAX_BYTES,
  createCfoTextPreparationController,
} from './cfo-text-preparation.js';
import {
  CFO_TEXT_SNAPSHOT_SCHEMA,
  type CfoTextChunk,
  type CfoTextSnapshotResult,
  type CfoTextSource,
} from './cfo-text-snapshot.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const RUN_ID = `run_${'a'.repeat(64)}`;
const PATH = 'finance/synthetic/prepared.pdf';
const SOURCE: CfoTextSource = Object.freeze({
  room: 'finance', source_index: 'finance-cfo-source-docs', path: PATH,
  source_path_hash: digest(PATH), document_version_id: `docv_${digest('catalog doc')}`,
  source_version: digest('catalog source'),
});

function readySnapshot(overrides: Record<string, unknown> = {}): CfoTextSnapshotResult {
  const texts = ['Synthetic Alpha relates to ', 'Synthetic Beta.'];
  let utf16 = 0;
  let bytes = 0;
  const chunks: CfoTextChunk[] = texts.map((text, ordinal) => {
    const chunk = Object.freeze({
      ordinal, start_utf16: utf16, end_utf16: utf16 + text.length,
      start_byte: bytes, end_byte: bytes + Buffer.byteLength(text),
      text_sha256: digest(text), text,
    });
    utf16 = chunk.end_utf16;
    bytes = chunk.end_byte;
    return chunk;
  });
  const sidecar = Buffer.from(texts.join(''));
  return Object.freeze({
    outcome: 'ready',
    descriptor: Object.freeze({
      schema: CFO_TEXT_SNAPSHOT_SCHEMA,
      room: 'finance', source_index: 'finance-cfo-source-docs',
      source_document_version: SOURCE.document_version_id,
      catalog_source_sha256: SOURCE.source_version,
      source_lineage_status: 'catalog_association_only',
      source_path_hash: SOURCE.source_path_hash,
      sidecar_path_hash: digest(`_TEXT/${PATH}.txt`),
      sidecar_etag: '"etag-1"', sidecar_version_id: 'version-1',
      sidecar_content_sha256: digest(sidecar), total_bytes: sidecar.length,
      total_chars_utf16: texts.join('').length, chunk_count: chunks.length,
      chunk_overlap_chars: 200,
      ...overrides,
    }),
    chunks: Object.freeze(chunks),
  });
}

function harness(snapshot: CfoTextSnapshotResult = readySnapshot()) {
  const map = new Map<string, Buffer>();
  let puts = 0;
  let rechecks = 0;
  const sources = new Map<number, CfoTextSource>([[0, SOURCE], [1, Object.freeze({
    ...SOURCE, path: 'finance/synthetic/other.pdf',
    source_path_hash: digest('finance/synthetic/other.pdf'),
    document_version_id: `docv_${digest('other catalog doc')}`,
    source_version: digest('other catalog source'),
  })]]);
  const store = async (request: { method: 'GET' | 'PUT'; key: string; headers?: Readonly<Record<string, string>>; body?: Buffer }) => {
    if (request.method === 'GET') {
      const body = map.get(request.key);
      return { status: body ? 200 : 404, headers: new Headers(body ? { etag: '"stored"' } : {}), body: body ?? Buffer.alloc(0) };
    }
    puts++;
    assert.deepEqual(request.headers, { 'content-type': 'application/json', 'if-none-match': '*' });
    if (map.has(request.key)) return { status: 412, headers: new Headers(), body: Buffer.alloc(0) };
    map.set(request.key, Buffer.from(request.body as Buffer));
    return { status: 200, headers: new Headers({ etag: '"stored"' }), body: Buffer.alloc(0) };
  };
  const controller = createCfoTextPreparationController({
    runId: RUN_ID,
    sourceReader: { readVersionPinnedPage: async () => snapshot },
    resolveSource: async ordinal => {
      const source = sources.get(ordinal);
      if (!source) throw Object.assign(new Error('not found'), { code: 'not_found' });
      return source;
    },
    recheck: async () => { rechecks++; },
    store,
  });
  return { controller, map, puts: () => puts, rechecks: () => rechecks, sources };
}

test('prepare persists immutable bundles before a manifest and emits metadata only', async () => {
  const h = harness();
  const receipt = await h.controller.prepare({ document_ordinal: 0 });
  assert.equal(receipt.outcome, 'ready');
  assert.match(receipt.snapshot_id as string, /^txtsnap_[a-f0-9]{64}$/);
  assert.match(receipt.manifest_sha256 as string, /^[a-f0-9]{64}$/);
  assert.equal(receipt.chunk_count, 2);
  const serialized = JSON.stringify(receipt);
  for (const forbidden of ['Synthetic Alpha', 'prepared.pdf', '_TEXT/', '"text":']) assert.equal(serialized.includes(forbidden), false);
  const keys = [...h.map.keys()];
  assert.ok(keys.at(-1)?.endsWith('/manifest.json'));
  assert.ok(keys.slice(0, -1).every(key => key.includes('/bundles/')));
  const firstPuts = h.puts();
  const replay = await h.controller.prepare({ document_ordinal: 0 });
  assert.equal(replay.snapshot_id, receipt.snapshot_id);
  assert.ok(h.puts() > firstPuts);
});

test('single chunk GET validates the manifest and returns exact source and text hashes', async () => {
  const h = harness();
  const receipt = await h.controller.prepare({ document_ordinal: 0 });
  assert.equal(receipt.outcome, 'ready');
  const chunk = await h.controller.readChunk({ snapshot_id: receipt.snapshot_id as string, ordinal: 1 });
  assert.equal(chunk.text, 'Synthetic Beta.');
  assert.equal(chunk.text_sha256, digest(chunk.text));
  assert.equal(chunk.source_document_version, SOURCE.document_version_id);
  assert.equal(chunk.sidecar_content_sha256, receipt.sidecar_content_sha256);
  assert.equal(chunk.manifest_sha256, receipt.manifest_sha256);
  assert.equal(chunk.start_byte, Buffer.byteLength('Synthetic Alpha relates to '));
  assert.ok(h.rechecks() >= 2);
});

test('snapshot identity changes when pinned version metadata changes even for identical text', async () => {
  const first = harness(readySnapshot());
  const second = harness(readySnapshot({ sidecar_version_id: 'version-2' }));
  const a = await first.controller.prepare({ document_ordinal: 0 });
  const b = await second.controller.prepare({ document_ordinal: 0 });
  assert.notEqual(a.snapshot_id, b.snapshot_id);
});

test('canary preparation cap returns explicit status without hundreds of writes', async () => {
  const snapshot = readySnapshot({ total_bytes: CFO_TEXT_PREPARATION_MAX_BYTES + 1 });
  const h = harness(snapshot);
  const receipt = await h.controller.prepare({ document_ordinal: 0 });
  assert.equal(receipt.outcome, 'preparation_oversize');
  assert.equal(h.puts(), 0);
});

test('nonready source outcomes are counted without state writes', async () => {
  const snapshot: CfoTextSnapshotResult = Object.freeze({
    outcome: 'missing_text', source_document_version: SOURCE.document_version_id,
    catalog_source_sha256: SOURCE.source_version, source_path_hash: SOURCE.source_path_hash,
    observed_bytes: null, chunks: Object.freeze([]),
  });
  const h = harness(snapshot);
  const receipt = await h.controller.prepare({ document_ordinal: 0 });
  assert.equal(receipt.outcome, 'missing_text');
  assert.equal(h.puts(), 0);
});

test('malformed UTF16 and byte spans are rejected before persistence', async () => {
  const base = readySnapshot();
  assert.equal(base.outcome, 'ready');
  if (base.outcome !== 'ready') return;
  const bad = Object.freeze({ ...base, chunks: Object.freeze([
    Object.freeze({ ...base.chunks[0], end_utf16: base.chunks[0].end_utf16 + 1 }),
    base.chunks[1],
  ]) }) as CfoTextSnapshotResult;
  const h = harness(bad);
  await assert.rejects(h.controller.prepare({ document_ordinal: 0 }), { code: 'cfo_text_preparation_invalid' });
  assert.equal(h.puts(), 0);
});

test('a self-hashed manifest with a forged identity or different current source cannot return a chunk', async () => {
  const h = harness();
  const receipt = await h.controller.prepare({ document_ordinal: 0 });
  assert.equal(receipt.outcome, 'ready');
  const prefix = `graph-trial/20260908/workers/cfo/${RUN_ID}/text-snapshots`;
  const originalKey = `${prefix}/${receipt.snapshot_id}/manifest.json`;
  const original = JSON.parse((h.map.get(originalKey) as Buffer).toString('utf8')) as Record<string, unknown>;
  const identity = { ...(original.identity as Record<string, unknown>), document_ordinal: 1 };
  const forgedSnapshotId = `txtsnap_${digest(canonicalForTest(identity))}`;
  const content = { ...original, snapshot_id: forgedSnapshotId, identity };
  delete content.manifest_sha256;
  const forged = { ...content, manifest_sha256: digest(canonicalForTest(content)) };
  h.map.set(`${prefix}/${forgedSnapshotId}/manifest.json`, Buffer.from(canonicalForTest(forged)));
  await assert.rejects(h.controller.readChunk({ snapshot_id: forgedSnapshotId, ordinal: 0 }),
    { code: 'cfo_text_preparation_corrupt' });
});

function canonicalForTest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalForTest(row[key])}`).join(',')}}`;
}