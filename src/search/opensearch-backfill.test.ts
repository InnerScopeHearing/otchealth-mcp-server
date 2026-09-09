import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call (see dispatch-opensearch.test.ts's header for
// why this matters): every env var this module's code path could read must be set before the first
// import below.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const {
  normalizeRow,
  toIndexInput,
  rowsToBulkNdjson,
  parseBulkResponse,
  fetchIndexMaxTs,
  bulkIndex,
  runBackfill,
  runHistoricalRepair,
} = await import('./opensearch-backfill.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const OS_HOST = 'es.amazonaws.com';
function isHost(u: string, host: string): boolean {
  try {
    const h = new URL(u).host;
    return h === host || h.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

// ============================ normalizeRow ============================

test('normalizeRow: a well-formed Cosmos/Postgres memory row survives intact', () => {
  const row = normalizeRow({
    id: '20260813-004',
    type: 'memory',
    agent: 'cto',
    kind: 'decision',
    text: 'ship the backfill',
    tags: ['aws', 'brain'],
    created_at: '2026-08-13T22:03:02.473Z',
  });
  assert.deepEqual(row, {
    id: '20260813-004',
    agent: 'cto',
    kind: 'decision',
    text: 'ship the backfill',
    tags: ['aws', 'brain'],
    created_at: '2026-08-13T22:03:02.473Z',
  });
});

test('normalizeRow: missing tags defaults to an empty array, not a crash', () => {
  const row = normalizeRow({ id: 'a', agent: 'cto', kind: 'fact', text: 'x', created_at: '2026-08-13T00:00:00Z' });
  assert.deepEqual(row?.tags, []);
});

test('normalizeRow: non-string tag entries are dropped, not thrown', () => {
  const row = normalizeRow({ id: 'a', agent: 'cto', kind: 'fact', text: 'x', created_at: '2026-08-13T00:00:00Z', tags: ['ok', 5, null, 'also-ok'] });
  assert.deepEqual(row?.tags, ['ok', 'also-ok']);
});

for (const missing of ['id', 'agent', 'kind', 'text', 'created_at']) {
  test(`normalizeRow: missing "${missing}" -> null (fail-safe per row, never throws)`, () => {
    const full: Record<string, unknown> = { id: 'a', agent: 'cto', kind: 'fact', text: 'x', created_at: '2026-08-13T00:00:00Z' };
    delete full[missing];
    assert.equal(normalizeRow(full), null);
  });
}

test('normalizeRow: non-object input -> null, never throws', () => {
  assert.equal(normalizeRow(null as unknown as Record<string, unknown>), null);
  assert.equal(normalizeRow(undefined as unknown as Record<string, unknown>), null);
});

// ============================ toIndexInput ============================

test('toIndexInput: MemoryRecord field names (kind/created_at) map to the index doc shape (type/ts)', () => {
  const row = { id: 'a', agent: 'cto', kind: 'pitfall', text: 'x', tags: ['t'], created_at: '2026-08-13T22:03:02.473Z' };
  const input = toIndexInput(row, [0.1, 0.2]);
  assert.equal(input.type, 'pitfall');
  assert.equal(input.ts, '2026-08-13T22:03:02.473Z');
  assert.equal(input.agent, 'cto');
  assert.equal(input.id, 'a');
  assert.deepEqual(input.vector, [0.1, 0.2]);
});

// ============================ rowsToBulkNdjson ============================

const sampleRow = { id: '20260815-001', agent: 'cto', kind: 'fact', text: 'the brain writer', tags: ['aws'], created_at: '2026-08-15T00:00:00Z' };

test('rowsToBulkNdjson: two lines per doc (action + source), using "index" (full replace) not "update"', () => {
  const ndjson = rowsToBulkNdjson([{ row: sampleRow, vector: [0.1] }], 'memory-exec');
  const lines = ndjson.trim().split('\n');
  assert.equal(lines.length, 2);
  const action = JSON.parse(lines[0]);
  assert.ok('index' in action, 'must use the index action, not update -- see module doc comment');
  assert.equal(action.index._index, 'memory-exec');
  assert.equal(action.index._id, 'cto__20260815-001'); // memoryDocId(agent, id) -- matches the live writer exactly
  const doc = JSON.parse(lines[1]);
  assert.equal(doc.agent, 'cto');
  assert.equal(doc.type, 'fact');
  assert.deepEqual(doc.contentVector, [0.1]);
});

test('rowsToBulkNdjson: a null vector still produces a fully valid, keyword-searchable doc (degrade, never drop)', () => {
  const ndjson = rowsToBulkNdjson([{ row: sampleRow, vector: null }], 'memory-exec');
  const doc = JSON.parse(ndjson.trim().split('\n')[1]);
  assert.equal('contentVector' in doc, false);
  assert.equal(doc.text, 'the brain writer');
});

test('rowsToBulkNdjson: empty input -> empty string (no dangling bulk call)', () => {
  assert.equal(rowsToBulkNdjson([], 'memory-exec'), '');
});

test('rowsToBulkNdjson: every action line is followed immediately by exactly one source line, for N docs', () => {
  const rows = [sampleRow, { ...sampleRow, id: '20260815-002' }, { ...sampleRow, id: '20260815-003' }];
  const ndjson = rowsToBulkNdjson(
    rows.map((row) => ({ row, vector: null })),
    'memory-exec',
  );
  const lines = ndjson.trim().split('\n');
  assert.equal(lines.length, 6);
  for (let i = 0; i < lines.length; i += 2) assert.ok('index' in JSON.parse(lines[i]));
});

// ============================ parseBulkResponse ============================

test('parseBulkResponse: all-success', () => {
  const body = { errors: false, items: [{ index: { status: 201 } }, { index: { status: 200 } }] };
  assert.deepEqual(parseBulkResponse(body, 2), { indexed: 2, failed: 0, errors: [] });
});

test('parseBulkResponse: a 2xx HTTP response can still carry per-item failures -- must not be misread as all-success', () => {
  const body = {
    errors: true,
    items: [{ index: { status: 201 } }, { index: { status: 409, error: { type: 'version_conflict_engine_exception', reason: 'conflict' } } }],
  };
  const out = parseBulkResponse(body, 2);
  assert.equal(out.indexed, 1);
  assert.equal(out.failed, 1);
  assert.match(out.errors[0], /409/);
  assert.match(out.errors[0], /version_conflict_engine_exception/);
});

test('parseBulkResponse: a malformed response (no items array) fails EVERY requested doc, not zero', () => {
  const out = parseBulkResponse({ ok: true }, 5);
  assert.equal(out.indexed, 0);
  assert.equal(out.failed, 5);
  assert.ok(out.errors.length > 0);
});

test('parseBulkResponse: caps the reported error list so one systemic failure cannot flood the report', () => {
  const items = Array.from({ length: 50 }, () => ({ index: { status: 500, error: { reason: 'boom' } } }));
  const out = parseBulkResponse({ errors: true, items }, 50);
  assert.equal(out.failed, 50);
  assert.ok(out.errors.length <= 10, `expected the error list capped, got ${out.errors.length}`);
});

// ============================ fetchIndexMaxTs ============================

test('fetchIndexMaxTs: returns the newest doc\'s ts on a clean sort', async () => {
  const ts = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ hits: { hits: [{ _source: { ts: '2026-08-13T22:03:02.473Z' } }] } }), { status: 200 })) as unknown as typeof fetch,
    () => fetchIndexMaxTs('memory-exec'),
  );
  assert.equal(ts, '2026-08-13T22:03:02.473Z');
});

test('fetchIndexMaxTs: falls back to ts.keyword when the plain sort 400s (fielddata-disabled-on-text-fields)', async () => {
  let calls = 0;
  const ts = await withStubbedFetch(
    (async (_u: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? '{}'));
      const sortField = Object.keys(body.sort?.[0] ?? {})[0];
      if (sortField === 'ts') return new Response('fielddata disabled on text fields', { status: 400 });
      assert.equal(sortField, 'ts.keyword', 'the fallback attempt must sort on ts.keyword');
      return new Response(JSON.stringify({ hits: { hits: [{ _source: { ts: '2026-08-14T00:00:00Z' } }] } }), { status: 200 });
    }) as unknown as typeof fetch,
    () => fetchIndexMaxTs('memory-exec'),
  );
  assert.equal(calls, 2, 'expected exactly one retry attempt');
  assert.equal(ts, '2026-08-14T00:00:00Z');
});

test('fetchIndexMaxTs: an absent index (404) is "cannot auto-detect", not an error', async () => {
  const ts = await withStubbedFetch((async () => new Response('{}', { status: 404 })) as unknown as typeof fetch, () => fetchIndexMaxTs('memory-exec'));
  assert.equal(ts, null);
});

test('fetchIndexMaxTs: an empty index (no hits) returns null, not an exception', async () => {
  const ts = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 })) as unknown as typeof fetch,
    () => fetchIndexMaxTs('memory-exec'),
  );
  assert.equal(ts, null);
});

test('fetchIndexMaxTs: both attempts failing degrades to null, never throws', async () => {
  const ts = await withStubbedFetch((async () => new Response('down', { status: 500 })) as unknown as typeof fetch, () => fetchIndexMaxTs('memory-exec'));
  assert.equal(ts, null);
});

// ============================ bulkIndex ============================

test('bulkIndex: reaches the OpenSearch _bulk endpoint with the ndjson content-type, signed', async () => {
  let seenPath = '';
  let seenContentType = '';
  const outcome = await withStubbedFetch(
    (async (u: string, init?: RequestInit) => {
      seenPath = new URL(String(u)).pathname;
      seenContentType = String((init?.headers as Record<string, string>)?.['content-type'] ?? '');
      return new Response(JSON.stringify({ errors: false, items: [{ index: { status: 201 } }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => bulkIndex('{"index":{"_index":"memory-exec","_id":"cto__1"}}\n{}\n', 1),
  );
  assert.equal(seenPath, '/_bulk');
  assert.equal(seenContentType, 'application/x-ndjson');
  assert.equal(outcome.indexed, 1);
});

test('bulkIndex: a non-2xx response fails every requested doc with the response body surfaced', async () => {
  const outcome = await withStubbedFetch(
    (async () => new Response('cluster unavailable', { status: 503 })) as unknown as typeof fetch,
    () => bulkIndex('{"index":{}}\n{}\n', 3),
  );
  assert.equal(outcome.indexed, 0);
  assert.equal(outcome.failed, 3);
  assert.match(outcome.errors[0], /503/);
});

test('bulkIndex: empty ndjson is a no-op that never calls fetch', async () => {
  let called = false;
  const outcome = await withStubbedFetch(
    (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch,
    () => bulkIndex('', 0),
  );
  assert.equal(called, false);
  assert.deepEqual(outcome, { indexed: 0, failed: 0, errors: [] });
});

// ============================ runBackfill (orchestration, injected deps) ============================

function fakeDeps(rows: Record<string, unknown>[], opts: { embedThrows?: boolean } = {}) {
  const queryCalls: unknown[] = [];
  const embedBatchCalls: string[][] = [];
  const embedCalls: string[] = [];
  return {
    deps: {
      queryDocs: (async (coll: string, query: string, parameters: unknown, qopts: unknown) => {
        queryCalls.push({ coll, query, parameters, qopts });
        return rows;
      }) as unknown as typeof import('../agentstate/store.js').queryDocs,
      embedBatch: (async (texts: string[]) => {
        embedBatchCalls.push(texts);
        if (opts.embedThrows) throw new Error('embed batch down');
        return texts.map((t) => [t.length, 0.5]);
      }) as unknown as typeof import('../azure/foundry.js').embedBatch,
      embed: (async (text: string) => {
        embedCalls.push(text);
        return [text.length, 0.5];
      }) as unknown as typeof import('../azure/foundry.js').embed,
    },
    queryCalls,
    embedBatchCalls,
    embedCalls,
  };
}

const bulkOkFetch = (async () => new Response(JSON.stringify({ errors: false, items: [{ index: { status: 201 } }] }), { status: 200 })) as unknown as typeof fetch;

test('runBackfill: an explicit --since is used as-is; no max-ts auto-detect call happens', async () => {
  const { deps, queryCalls } = fakeDeps([]);
  const seenUrls: string[] = [];
  const result = await withStubbedFetch(
    (async (u: string) => {
      seenUrls.push(String(u));
      return bulkOkFetch(u);
    }) as unknown as typeof fetch,
    () => runBackfill({ since: '2026-08-13T22:03:02.473Z' }, deps),
  );
  assert.equal(result.since, '2026-08-13T22:03:02.473Z');
  assert.equal(seenUrls.length, 0, 'an explicit since must skip the max-ts lookup entirely');
  assert.equal((queryCalls[0] as { parameters: { value: unknown }[] }).parameters[0].value, '2026-08-13T22:03:02.473Z');
});

test('runBackfill: no --since auto-detects the watermark from the index, then queries from there', async () => {
  const { deps, queryCalls } = fakeDeps([]);
  const result = await withStubbedFetch(
    (async (u: string, init?: RequestInit) => {
      if (String(u).includes('/_search')) {
        return new Response(JSON.stringify({ hits: { hits: [{ _source: { ts: '2026-08-13T22:03:02.473Z' } }] } }), { status: 200 });
      }
      return bulkOkFetch(u, init);
    }) as unknown as typeof fetch,
    () => runBackfill({}, deps),
  );
  assert.equal(result.since, '2026-08-13T22:03:02.473Z');
  assert.equal((queryCalls[0] as { parameters: { value: unknown }[] }).parameters[0].value, '2026-08-13T22:03:02.473Z');
});

test('runBackfill: auto-detect failing (empty/unreachable index) with no explicit --since refuses to run rather than backfilling all history', async () => {
  const { deps, queryCalls } = fakeDeps([]);
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 })) as unknown as typeof fetch,
    () => runBackfill({}, deps),
  );
  assert.equal(queryCalls.length, 0, 'must never query the memory store without a resolved since');
  assert.equal(result.fetched, 0);
  assert.match(result.errors[0], /cannot auto-detect/);
});

test('runBackfill: THE CORE PROMISE -- rows from the store get embedded AND land in the OpenSearch bulk body with their vector', async () => {
  const row = { id: '20260814-001', agent: 'cto', kind: 'fact', text: 'a fact worth recalling', tags: [], created_at: '2026-08-14T00:00:00Z' };
  const { deps } = fakeDeps([row]);
  let capturedBody = '';
  const result = await withStubbedFetch(
    (async (u: string, init?: RequestInit) => {
      if (isHost(String(u), OS_HOST) && String(u).includes('_bulk')) capturedBody = String(init?.body ?? '');
      return bulkOkFetch(u, init);
    }) as unknown as typeof fetch,
    () => runBackfill({ since: '2026-08-13T00:00:00Z' }, deps),
  );
  assert.equal(result.fetched, 1);
  assert.equal(result.indexed, 1);
  assert.equal(result.failed, 0);
  const lines = capturedBody.trim().split('\n');
  const doc = JSON.parse(lines[1]);
  assert.equal(doc.id, 'cto__20260814-001');
  assert.ok(Array.isArray(doc.contentVector) && doc.contentVector.length > 0, 'the backfilled doc must carry a real embedding, not an empty/missing vector');
});

test('runBackfill: malformed rows are skipped (counted, not thrown), valid rows in the same batch still get indexed', async () => {
  const good = { id: 'a', agent: 'cto', kind: 'fact', text: 'ok', tags: [], created_at: '2026-08-14T00:00:00Z' };
  const bad = { id: 'b', agent: 'cto', text: 'missing kind and created_at' }; // malformed on purpose
  const { deps } = fakeDeps([good, bad]);
  const result = await withStubbedFetch(bulkOkFetch, () => runBackfill({ since: '2026-08-13T00:00:00Z' }, deps));
  assert.equal(result.fetched, 1, 'only the well-formed row counts as fetched');
  assert.equal(result.indexed, 1);
  assert.ok(result.errors.some((e) => /skipped/.test(e)));
});

test('runBackfill: fetched === max sets truncated:true (self-detection, never a silent undercount)', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, agent: 'cto', kind: 'fact', text: 'x', tags: [], created_at: '2026-08-14T00:00:00Z' }));
  const { deps } = fakeDeps(rows);
  const result = await withStubbedFetch(bulkOkFetch, () => runBackfill({ since: '2026-08-13T00:00:00Z', max: 3 }, deps));
  assert.equal(result.truncated, true);
});

test('runBackfill: fetched < max sets truncated:false', async () => {
  const rows = [{ id: 'r0', agent: 'cto', kind: 'fact', text: 'x', tags: [], created_at: '2026-08-14T00:00:00Z' }];
  const { deps } = fakeDeps(rows);
  const result = await withStubbedFetch(bulkOkFetch, () => runBackfill({ since: '2026-08-13T00:00:00Z', max: 50 }, deps));
  assert.equal(result.truncated, false);
});

test('runBackfill: dryRun fetches and previews but never embeds or writes', async () => {
  const rows = [{ id: 'r0', agent: 'cto', kind: 'fact', text: 'x', tags: [], created_at: '2026-08-14T00:00:00Z' }];
  const { deps, embedBatchCalls, embedCalls } = fakeDeps(rows);
  let bulkCalled = false;
  const result = await withStubbedFetch(
    (async (u: string, init?: RequestInit) => {
      if (String(u).includes('_bulk')) bulkCalled = true;
      return bulkOkFetch(u, init);
    }) as unknown as typeof fetch,
    () => runBackfill({ since: '2026-08-13T00:00:00Z', dryRun: true }, deps),
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.indexed, 0);
  assert.equal(result.fetched, 1);
  assert.equal(bulkCalled, false, 'dry-run must never write');
  assert.equal(embedBatchCalls.length + embedCalls.length, 0, 'dry-run must never spend an embedding call');
  assert.equal(result.preview?.[0]?.id, 'r0');
});

test('runBackfill: agent scopes the query to that partition (pk), sidestepping the cross-partition merge hazard', async () => {
  const { deps, queryCalls } = fakeDeps([]);
  await withStubbedFetch(bulkOkFetch, () => runBackfill({ since: '2026-08-13T00:00:00Z', agent: 'cfo' }, deps));
  assert.equal((queryCalls[0] as { qopts: { pk?: string } }).qopts.pk, 'cfo');
});

test('runBackfill: a memory-store query failure is reported, not thrown', async () => {
  const deps = {
    queryDocs: (async () => {
      throw new Error('cosmos unreachable');
    }) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embed: (async () => null) as unknown as typeof import('../azure/foundry.js').embed,
    embedBatch: (async () => null) as unknown as typeof import('../azure/foundry.js').embedBatch,
  };
  const result = await runBackfill({ since: '2026-08-13T00:00:00Z' }, deps);
  assert.equal(result.fetched, 0);
  assert.match(result.errors[0], /cosmos unreachable/);
});

test('runBackfill: an embedBatch failure falls back to per-item embed(), never drops the batch', async () => {
  const rows = [{ id: 'r0', agent: 'cto', kind: 'fact', text: 'x', tags: [], created_at: '2026-08-14T00:00:00Z' }];
  const { deps, embedCalls } = fakeDeps(rows, { embedThrows: true });
  const result = await withStubbedFetch(bulkOkFetch, () => runBackfill({ since: '2026-08-13T00:00:00Z' }, deps));
  assert.equal(result.indexed, 1);
  assert.deepEqual(embedCalls, ['x']);
});

test('runBackfill: multiple bulk chunks (bulkBatchSize smaller than the fetched row count) all get written, and a chunk that permanently fails does not stop later chunks', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, agent: 'cto', kind: 'fact', text: 'x', tags: [], created_at: '2026-08-14T00:00:00Z' }));
  const { deps } = fakeDeps(rows);
  let bulkCalls = 0;
  const result = await withStubbedFetch(
    (async (u: string, init?: RequestInit) => {
      if (!String(u).includes('_bulk')) return bulkOkFetch(u, init);
      bulkCalls += 1;
      // Identify the chunk by its BODY content (r0 is only ever in the first chunk), not by a bare
      // call counter -- bulkIndex's own fetchWithBudget retries a 5xx once, so a counter-based stub
      // would let that automatic retry silently turn a "permanent" failure into a transient one.
      // Failing every attempt for the r0 chunk proves this test's actual intent: a chunk that is
      // truly down (exhausts its retry) must not abort the chunks after it. The doc _id is
      // memoryDocId('cto','r0') = "cto__r0" -- match the full quoted id, not a bare substring.
      if (String(init?.body ?? '').includes('"cto__r0"')) return new Response('overloaded', { status: 503 });
      // Success items must match the ACTUAL number of docs in this chunk's body (the last chunk has
      // only 1 row) -- a fixed-length canned response here would silently inflate the indexed count.
      const docsInChunk = String(init?.body ?? '')
        .trim()
        .split('\n').length / 2;
      const items = Array.from({ length: docsInChunk }, () => ({ index: { status: 201 } }));
      return new Response(JSON.stringify({ errors: false, items }), { status: 200 });
    }) as unknown as typeof fetch,
    () => runBackfill({ since: '2026-08-13T00:00:00Z', bulkBatchSize: 2 }, deps),
  );
  // 3 chunks (2+2+1) but the first chunk retries once (fetchWithBudget's default), so 4 fetch calls.
  assert.equal(bulkCalls, 4, 'expected 3 chunks, the first retried once = 4 fetch attempts');
  assert.equal(result.fetched, 5);
  assert.equal(result.failed, 2, 'the permanently-failed first chunk of 2');
  assert.equal(result.indexed, 3, 'the other two chunks (2 + 1) still succeeded despite the first chunk failing');
});

test('parseBulkResponse: a short item list is unconfirmed and fails EVERY requested doc', () => {
  const out = parseBulkResponse({ errors: false, items: [{ index: { status: 201 } }] }, 2);
  assert.equal(out.indexed, 0);
  assert.equal(out.failed, 2);
  assert.match(out.errors[0], /expected 2 items/);
});

test('historical repair: repairs older failed A even when newer B is already indexed, without embedding B', async () => {
  const a = { id: 'a', agent: 'cfo', kind: 'fact', text: 'older failed record', tags: [], created_at: '2026-08-01T00:00:00Z' };
  const b = { id: 'b', agent: 'cfo', kind: 'fact', text: 'newer indexed record', tags: [], created_at: '2026-08-02T00:00:00Z' };
  const embedTexts: string[] = [];
  let pass = 0;
  const deps = {
    queryDocs: (async (_coll: string, query: string) => query.includes('c.id = @id') ? [a] : (pass === 0 ? [a, b] : [])) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async (texts: string[]) => { embedTexts.push(...texts); return texts.map(() => [1]); }) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => [1]) as unknown as typeof import('../azure/foundry.js').embed,
  };
  let bulkBodies = 0;
  const result = await withStubbedFetch(
    (async (url: string, init?: RequestInit) => {
      if (url.includes('_mget')) return new Response(JSON.stringify({ docs: [
        { _id: 'cfo__a', found: false }, { _id: 'cfo__b', found: true },
      ] }), { status: 200 });
      if (url.includes('_bulk')) {
        bulkBodies += 1;
        assert.match(String(init?.body), /cfo__a/);
        assert.doesNotMatch(String(init?.body), /cfo__b/);
        return new Response(JSON.stringify({ errors: false, items: [{ index: { status: 201 } }] }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo' }, deps),
  );
  assert.equal(result.indexed, 1);
  assert.equal(result.already_indexed, 1);
  assert.deepEqual(embedTexts, ['older failed record']);
  assert.equal(bulkBodies, 1);
  assert.deepEqual(result.checkpoint.pending_ids, []);
});

test('historical repair: failed A is retained in checkpoint and retried from exact source after cursor advanced past B', async () => {
  const a = { id: 'a', agent: 'cfo', kind: 'fact', text: 'older failed record', tags: [], created_at: '2026-08-01T00:00:00Z' };
  const b = { id: 'b', agent: 'cfo', kind: 'fact', text: 'newer indexed record', tags: [], created_at: '2026-08-02T00:00:00Z' };
  let pass = 0;
  const deps = {
    queryDocs: (async (_coll: string, query: string) => query.includes('c.id = @id') ? [a] : (pass === 0 ? [a, b] : [])) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async (texts: string[]) => texts.map(() => [1])) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => [1]) as unknown as typeof import('../azure/foundry.js').embed,
  };
  const first = await withStubbedFetch(
    (async (url: string) => {
      if (url.includes('_mget')) return new Response(JSON.stringify({ docs: [{ _id: 'cfo__a', found: false }, { _id: 'cfo__b', found: true }] }), { status: 200 });
      if (url.includes('_bulk')) return new Response('down', { status: 503 });
      throw new Error('unexpected');
    }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo' }, deps),
  );
  assert.deepEqual(first.checkpoint.pending_ids, ['a']);
  assert.equal(first.checkpoint.after_id, 'b');
  pass = 1;
  const second = await withStubbedFetch(
    (async (url: string) => {
      if (url.includes('_mget')) return new Response(JSON.stringify({ docs: [{ _id: 'cfo__a', found: false }] }), { status: 200 });
      if (url.includes('_bulk')) return new Response(JSON.stringify({ errors: false, items: [{ index: { status: 201 } }] }), { status: 200 });
      throw new Error('unexpected');
    }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo', checkpoint: first.checkpoint }, deps),
  );
  assert.equal(second.indexed, 1);
  assert.deepEqual(second.checkpoint.pending_ids, []);
});

test('historical repair: a pending ID deleted from the source is removed without write or embedding', async () => {
  const deps = {
    queryDocs: (async () => []) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async () => { throw new Error('must not embed deleted source'); }) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => { throw new Error('must not embed deleted source'); }) as unknown as typeof import('../azure/foundry.js').embed,
  };
  const result = await withStubbedFetch(
    (async () => { throw new Error('must not query OpenSearch for absent source'); }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo', checkpoint: { version: 'memory-index-repair-v1', agent: 'cfo', after_id: 'z', pending_ids: ['a'] } }, deps),
  );
  assert.equal(result.checked, 0);
  assert.deepEqual(result.checkpoint.pending_ids, []);
});

test('historical repair: incomplete _mget coverage does not spend embeddings or declare omitted IDs missing', async () => {
  const a = { id: 'a', agent: 'cfo', kind: 'fact', text: 'a', tags: [], created_at: '2026-08-01T00:00:00Z' };
  const b = { id: 'b', agent: 'cfo', kind: 'fact', text: 'b', tags: [], created_at: '2026-08-02T00:00:00Z' };
  const deps = {
    queryDocs: (async () => [a, b]) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async () => { throw new Error('must not embed after incomplete mget'); }) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => { throw new Error('must not embed after incomplete mget'); }) as unknown as typeof import('../azure/foundry.js').embed,
  };
  const result = await withStubbedFetch(
    (async (url: string) => {
      if (url.includes('_mget')) return new Response(JSON.stringify({ docs: [{ _id: 'cfo__a', found: false }] }), { status: 200 });
      throw new Error('must not bulk write');
    }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo' }, deps),
  );
  assert.match(result.errors[0], /existence check failed/);
  assert.equal(result.indexed, 0);
  assert.deepEqual(result.checkpoint.pending_ids, ['a', 'b']);
  assert.equal(result.checkpoint.after_id, '');
});

test('historical repair: pending retry IDs cannot regress the ordered source cursor', async () => {
  const b = { id: 'b', agent: 'cfo', kind: 'fact', text: 'b', tags: [], created_at: '2026-08-01T00:00:00Z' };
  const z = { id: 'z', agent: 'cfo', kind: 'fact', text: 'z', tags: [], created_at: '2026-08-02T00:00:00Z' };
  const deps = {
    queryDocs: (async (_coll: string, query: string) => query.includes('c.id = @id') ? [z] : [b]) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async () => { throw new Error('must not embed existing docs'); }) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => { throw new Error('must not embed existing docs'); }) as unknown as typeof import('../azure/foundry.js').embed,
  };
  const result = await withStubbedFetch(
    (async (url: string) => {
      if (url.includes('_mget')) return new Response(JSON.stringify({ docs: [{ _id: 'cfo__z', found: true }, { _id: 'cfo__b', found: true }] }), { status: 200 });
      throw new Error('must not bulk write');
    }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo', checkpoint: { version: 'memory-index-repair-v1', agent: 'cfo', after_id: 'c', pending_ids: ['z'] } }, deps),
  );
  assert.equal(result.checkpoint.after_id, 'c');
});

test('historical repair: short successful bulk response keeps all exact rows pending', async () => {
  const a = { id: 'a', agent: 'cfo', kind: 'fact', text: 'a', tags: [], created_at: '2026-08-01T00:00:00Z' };
  const b = { id: 'b', agent: 'cfo', kind: 'fact', text: 'b', tags: [], created_at: '2026-08-02T00:00:00Z' };
  const deps = {
    queryDocs: (async () => [a, b]) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async (texts: string[]) => texts.map(() => [1])) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => [1]) as unknown as typeof import('../azure/foundry.js').embed,
  };
  const result = await withStubbedFetch(
    (async (url: string) => {
      if (url.includes('_mget')) return new Response(JSON.stringify({ docs: [{ _id: 'cfo__a', found: false }, { _id: 'cfo__b', found: false }] }), { status: 200 });
      if (url.includes('_bulk')) return new Response(JSON.stringify({ errors: false, items: [{ index: { status: 201 } }] }), { status: 200 });
      throw new Error('unexpected');
    }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo' }, deps),
  );
  assert.equal(result.indexed, 0);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.checkpoint.pending_ids, ['a', 'b']);
});

test('historical repair: rejected embedding batch writes nothing and retains the exact obligation', async () => {
  const a = { id: 'a', agent: 'cfo', kind: 'fact', text: 'a', tags: [], created_at: '2026-08-01T00:00:00Z' };
  const deps = {
    queryDocs: (async () => [a]) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async () => []) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => [1]) as unknown as typeof import('../azure/foundry.js').embed,
  };
  const result = await withStubbedFetch(
    (async (url: string) => {
      if (url.includes('_mget')) return new Response(JSON.stringify({ docs: [{ _id: 'cfo__a', found: false }] }), { status: 200 });
      throw new Error('must not bulk write');
    }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo' }, deps),
  );
  assert.equal(result.indexed, 0);
  assert.deepEqual(result.checkpoint.pending_ids, ['a']);
  assert.match(result.errors[0], /embedding response rejected/);
});

test('historical repair: a stalled worker that loses its renewed fence dispatches no embedding or bulk write', async () => {
  const a = { id: 'a', agent: 'cfo', kind: 'fact', text: 'synthetic', tags: [], created_at: '2026-08-01T00:00:00Z' };
  let embeddings = 0;
  let bulkWrites = 0;
  const deps = {
    queryDocs: (async () => [a]) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async () => { embeddings += 1; return [[1]]; }) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => { embeddings += 1; return [1]; }) as unknown as typeof import('../azure/foundry.js').embed,
  };
  const result = await withStubbedFetch(
    (async (url: string) => {
      if (url.includes('_mget')) return new Response(JSON.stringify({ docs: [{ _id: 'cfo__a', found: false }] }), { status: 200 });
      if (url.includes('_bulk')) { bulkWrites += 1; return new Response('{}'); }
      throw new Error('unexpected');
    }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo', beforePaidDispatch: async () => false }, deps),
  );
  assert.equal(embeddings, 0);
  assert.equal(bulkWrites, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.checkpoint.pending_ids, ['a']);
  assert.match(result.errors[0], /execution fence lost/);
});

test('historical repair: malformed terminal source row advances only its stable ID and remains incomplete', async () => {
  const malformed = { id: 'z', agent: 'cfo', type: 'memory', text: 'missing kind', created_at: '2026-08-01T00:00:00Z' };
  const deps = {
    queryDocs: (async () => [malformed]) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async () => { throw new Error('must not embed malformed'); }) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => { throw new Error('must not embed malformed'); }) as unknown as typeof import('../azure/foundry.js').embed,
  };
  const result = await withStubbedFetch(
    (async () => { throw new Error('must not call OpenSearch when no valid source rows'); }) as unknown as typeof fetch,
    () => runHistoricalRepair({ agent: 'cfo', checkpoint: { version: 'memory-index-repair-v1', agent: 'cfo', after_id: 'a', pending_ids: [] } }, deps),
  );
  assert.equal(result.checkpoint.after_id, 'z');
  assert.equal(result.truncated, true);
  assert.match(result.errors[0], /repair remains incomplete/);
});

test('historical repair: malformed scanned ID survives cursor advancement and is indexed after source correction', async () => {
  let corrected = false;
  let embeddings = 0;
  const record = () => ({ id: 'z', agent: 'cfo', type: 'memory', text: 'synthetic repair', created_at: '2026-08-01T00:00:00Z', ...(corrected ? {kind:'fact',tags:[]} : {}) });
  const deps = {
    queryDocs: (async (_coll: string, query: string) => query.includes('c.id = @id') ? [record()] : corrected ? [] : [record()]) as unknown as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async (texts: string[]) => { embeddings += texts.length; return texts.map(() => [1]); }) as unknown as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => { embeddings++; return [1]; }) as unknown as typeof import('../azure/foundry.js').embed,
  };
  const first = await withStubbedFetch((async () => { throw new Error('malformed row must not reach index'); }) as typeof fetch,
    () => runHistoricalRepair({agent:'cfo'},deps));
  assert.equal(first.checkpoint.after_id,'z');
  assert.deepEqual(first.checkpoint.pending_ids,['z']);
  assert.equal(first.truncated,true);
  assert.equal(embeddings,0);
  const stillMalformed = await withStubbedFetch((async () => { throw new Error('malformed pending must not reach index'); }) as typeof fetch,
    () => runHistoricalRepair({agent:'cfo',checkpoint:first.checkpoint}, {...deps,queryDocs:(async (_coll:string,query:string)=>query.includes('c.id = @id')?[record()]:[]) as typeof deps.queryDocs}));
  assert.deepEqual(stillMalformed.checkpoint.pending_ids,['z']);
  assert.equal(stillMalformed.truncated,true);
  corrected=true;
  const final = await withStubbedFetch((async (input: RequestInfo|URL) => {
    if(String(input).includes('_mget')) return new Response(JSON.stringify({docs:[{_id:'cfo__z',found:false}]}));
    if(String(input).includes('_bulk')) return new Response(JSON.stringify({errors:false,items:[{index:{status:201}}]}));
    throw new Error('unexpected request');
  }) as typeof fetch, () => runHistoricalRepair({agent:'cfo',checkpoint:stillMalformed.checkpoint},deps));
  assert.equal(final.indexed,1);
  assert.deepEqual(final.checkpoint.pending_ids,[]);
  assert.equal(final.truncated,true);
  const terminal = await withStubbedFetch((async () => { throw new Error('empty terminal page must not reach index'); }) as typeof fetch,
    () => runHistoricalRepair({agent:'cfo',checkpoint:final.checkpoint},deps));
  assert.equal(terminal.truncated,false);
  assert.equal(embeddings,1);
});

test('historical repair: deleting the last pending source still requires the remaining scan', async () => {
  let scans = 0;
  const deps = {
    queryDocs: (async (_coll: string, query: string) => { if (query.includes('c.id >')) scans++; return []; }) as typeof import('../agentstate/store.js').queryDocs,
    embedBatch: (async () => { throw new Error('no embeddings expected'); }) as typeof import('../azure/foundry.js').embedBatch,
    embed: (async () => { throw new Error('no embeddings expected'); }) as typeof import('../azure/foundry.js').embed,
  };
  const first = await runHistoricalRepair({agent:'cfo',checkpoint:{version:'memory-index-repair-v1',agent:'cfo',after_id:'a',pending_ids:['a']}},deps);
  assert.deepEqual(first.checkpoint.pending_ids,[]);
  assert.equal(first.truncated,true);
  assert.equal(scans,0);
  const terminal = await runHistoricalRepair({agent:'cfo',checkpoint:first.checkpoint},deps);
  assert.equal(scans,1);
  assert.equal(terminal.truncated,false);
});
