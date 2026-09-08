import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CFO_TEXT_MAX_CHUNK_BYTES,
  CFO_TEXT_MAX_CHUNK_CHARS,
  CFO_TEXT_MAX_SOURCE_BYTES,
  createCfoTextSnapshotReader,
  type CfoTextSource,
} from './cfo-text-snapshot.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const PATH = 'finance/synthetic/statement.pdf';
const SOURCE: CfoTextSource = Object.freeze({
  room: 'finance',
  source_index: 'finance-cfo-source-docs',
  path: PATH,
  source_path_hash: digest(PATH),
  document_version_id: `docv_${digest('synthetic catalog association')}`,
  source_version: digest('synthetic source document bytes'),
});
const CALLER = Object.freeze({ caller_agent: 'cfo', connector_surface: true });
const ETAG = '"synthetic-etag"';
const VERSION = 'synthetic/version+1=';

type RequestRecord = {
  method: string;
  path: string;
  query?: string | Record<string, string>;
  extraHeaders?: Record<string, string>;
};

function readerFor(
  handler: (url: string, init: RequestInit, call: number) => Promise<Response>,
  records: RequestRecord[] = [],
  limits: { maxSourceBytes?: number } = {},
) {
  let calls = 0;
  return {
    records,
    calls: () => calls,
    reader: createCfoTextSnapshotReader({
      callerContext: CALLER,
      credentialProvider: async signal => {
        assert.equal(signal.aborted, false);
        return { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
      },
      signer: input => {
        records.push({ method: input.method, path: input.path, query: input.query, extraHeaders: input.extraHeaders });
        return { headers: { 'x-synthetic-signed': 'true' } };
      },
      fetchImpl: async (url, init) => handler(url, init, ++calls),
      ...limits,
    }),
  };
}
function readyResponses(body: Buffer, getHeaders: Record<string, string> = {}) {
  return async (_url: string, init: RequestInit, call: number): Promise<Response> => {
    assert.equal(init.redirect, 'error');
    if (call === 1) return new Response(null, { status: 200, headers: {
      etag: ETAG, 'x-amz-version-id': VERSION, 'content-length': String(body.length),
    } });
    return new Response(body, { status: 200, headers: {
      etag: ETAG, 'x-amz-version-id': VERSION, 'content-length': String(body.length), ...getHeaders,
    } });
  };
}

test('CFO reader pins HEAD identity into exact VersionId and If-Match GET and returns immutable proof', async () => {
  const text = 'Synthetic Alpha relates to Synthetic Beta. 😀\n'.repeat(700);
  const body = Buffer.from(text);
  const h = readerFor(readyResponses(body));
  const result = await h.reader.readVersionPinnedPage(SOURCE);
  assert.equal(result.outcome, 'ready');
  if (result.outcome !== 'ready') return;
  assert.equal(h.calls(), 2);
  assert.equal(h.records[0].method, 'HEAD');
  assert.equal(h.records[0].query, undefined);
  assert.equal(h.records[1].method, 'GET');
  assert.deepEqual(h.records[1].query, { versionId: VERSION });
  assert.equal(h.records[1].extraHeaders?.['if-match'], ETAG);
  assert.equal(result.descriptor.source_document_version, SOURCE.document_version_id);
  assert.equal(result.descriptor.catalog_source_sha256, SOURCE.source_version);
  assert.equal(result.descriptor.source_lineage_status, 'catalog_association_only');
  assert.equal(result.descriptor.sidecar_content_sha256, digest(body));
  assert.equal(result.descriptor.sidecar_version_id, VERSION);
  assert.equal(result.descriptor.total_chars_utf16, text.length);
  assert.equal(result.descriptor.sidecar_path_hash, digest(`_TEXT/${PATH}.txt`));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.descriptor) && Object.isFrozen(result.chunks));
});

test('stable UTF-16 offsets cover every character with bounded overlapping UTF-8 chunks', async () => {
  const text = `${'a'.repeat(12000)}${'😀'.repeat(3000)}${'z'.repeat(9000)}`;
  const body = Buffer.from(text);
  const h = readerFor(readyResponses(body));
  const result = await h.reader.readVersionPinnedPage(SOURCE);
  assert.equal(result.outcome, 'ready');
  if (result.outcome !== 'ready') return;
  assert.ok(result.chunks.length > 1);
  let coveredUntil = 0;
  for (const [index, chunk] of result.chunks.entries()) {
    assert.equal(chunk.ordinal, index);
    assert.equal(chunk.text, text.slice(chunk.start_utf16, chunk.end_utf16));
    assert.equal(chunk.text_sha256, digest(chunk.text));
    assert.equal(chunk.start_byte, Buffer.byteLength(text.slice(0, chunk.start_utf16)));
    assert.equal(chunk.end_byte, Buffer.byteLength(text.slice(0, chunk.end_utf16)));
    assert.ok(chunk.text.length <= CFO_TEXT_MAX_CHUNK_CHARS);
    assert.ok(Buffer.byteLength(chunk.text) <= CFO_TEXT_MAX_CHUNK_BYTES);
    assert.ok(chunk.start_utf16 <= coveredUntil);
    assert.ok(chunk.end_utf16 > coveredUntil);
    if (index > 0) assert.ok(result.chunks[index - 1].end_utf16 - chunk.start_utf16 >= 199);
    coveredUntil = chunk.end_utf16;
  }
  assert.equal(coveredUntil, text.length);
});

test('missing and oversized sidecars are explicit and do not issue a GET', async () => {
  const missing = readerFor(async () => new Response(null, { status: 404 }));
  assert.equal((await missing.reader.readVersionPinnedPage(SOURCE)).outcome, 'missing_text');
  assert.equal(missing.calls(), 1);

  const oversize = readerFor(async () => new Response(null, { status: 200, headers: {
    etag: ETAG, 'x-amz-version-id': VERSION,
    'content-length': String(CFO_TEXT_MAX_SOURCE_BYTES + 1),
  } }));
  const result = await oversize.reader.readVersionPinnedPage(SOURCE);
  assert.equal(result.outcome, 'oversize');
  assert.equal(oversize.calls(), 1);
});

test('a lying GET length cannot bypass the bounded stream cap', async () => {
  const body = Buffer.from('12345');
  const h = readerFor(async (_url, _init, call) => call === 1
    ? new Response(null, { status: 200, headers: { etag: ETAG, 'x-amz-version-id': VERSION, 'content-length': '4' } })
    : new Response(body, { status: 200, headers: { etag: ETAG, 'x-amz-version-id': VERSION, 'content-length': '5' } }),
  [], { maxSourceBytes: 4 });
  assert.equal((await h.reader.readVersionPinnedPage(SOURCE)).outcome, 'oversize');
});
test('oversize stream settles when response cancellation never resolves', async () => {
  const hangingResponse = {
    status: 200,
    headers: new Headers({ etag: ETAG, 'x-amz-version-id': VERSION, 'content-length': '4' }),
    body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array([1, 2, 3, 4, 5]) }),
      cancel: () => new Promise<void>(() => {}),
    }) },
  } as unknown as Response;
  const h = readerFor(async (_url, _init, call) => call === 1
    ? new Response(null, { status: 200, headers: { etag: ETAG, 'x-amz-version-id': VERSION, 'content-length': '4' } })
    : hangingResponse, [], { maxSourceBytes: 4 });
  const started = Date.now();
  assert.equal((await h.reader.readVersionPinnedPage(SOURCE)).outcome, 'oversize');
  assert.ok(Date.now() - started < 300);
});
test('GET precondition failure or changed response identity cannot return text', async () => {
  const precondition = readerFor(async (_url, _init, call) => call === 1
    ? new Response(null, { status: 200, headers: { etag: ETAG, 'x-amz-version-id': VERSION, 'content-length': '4' } })
    : new Response(null, { status: 412 }));
  assert.equal((await precondition.reader.readVersionPinnedPage(SOURCE)).outcome, 'source_changed');

  const body = Buffer.from('safe');
  const changed = readerFor(readyResponses(body, { etag: '"different"' }));
  assert.equal((await changed.reader.readVersionPinnedPage(SOURCE)).outcome, 'source_changed');
});

test('invalid UTF-8 is counted explicitly after an otherwise exact pinned read', async () => {
  const body = Buffer.from([0xc3, 0x28]);
  const h = readerFor(readyResponses(body));
  const result = await h.reader.readVersionPinnedPage(SOURCE);
  assert.equal(result.outcome, 'invalid_utf8');
  assert.equal(result.chunks.length, 0);
});

test('trusted caller and frozen normalized catalog association fail closed before AWS dependencies', async () => {
  for (const callerContext of [
    { caller_agent: 'cto', connector_surface: true },
    { caller_agent: 'clo', connector_surface: true },
    { caller_agent: 'cfo', connector_surface: false },
  ]) {
    assert.throws(() => createCfoTextSnapshotReader({ callerContext }), { code: 'cfo_text_forbidden' });
  }
  const h = readerFor(async () => { throw new Error('must not fetch'); });
  const cases = [
    { ...SOURCE },
    Object.freeze({ ...SOURCE, room: 'legal_company' }),
    Object.freeze({ ...SOURCE, path: '_TEXT/finance/synthetic/statement.pdf.txt',
      source_path_hash: digest('_TEXT/finance/synthetic/statement.pdf.txt') }),
    Object.freeze({ ...SOURCE, path: 'finance/../statement.pdf', source_path_hash: digest('finance/../statement.pdf') }),
    Object.freeze({ ...SOURCE, source_path_hash: digest('wrong') }),
  ];
  for (const value of cases) {
    await assert.rejects(h.reader.readVersionPinnedPage(value as CfoTextSource), { code: 'cfo_text_source_invalid' });
  }
  assert.equal(h.calls(), 0);
});

test('caller cancellation is preserved before credential or source access', async () => {
  let credentials = 0;
  const reader = createCfoTextSnapshotReader({
    callerContext: CALLER,
    credentialProvider: async () => { credentials++; return { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }; },
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  await assert.rejects(reader.readVersionPinnedPage(SOURCE, { signal: AbortSignal.abort() }),
    { code: 'cfo_text_deadline' });
  assert.equal(credentials, 0);
});