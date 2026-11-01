import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars (cosmos.js -> config/env.js reads at import), then import.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

const {
  buildPreview,
  buildOffloadedResultReference,
  pageCount,
  pageSlice,
  cursorSlice,
  shouldOffload,
  mayOffloadToolResult,
  recordInlineResultProjection,
  extractResultSummary,
  offloadResult,
  fetchStoredResult,
  PAGE_CHARS,
  COMPACT_RESULT_JSON_MODE_ENV,
  compactResultJsonWritesEnabled,
} = await import('./result-store.js');
const { handleGatewayFetchResult } = await import('./gateway-fetch-result.js');
const { buildTextContent } = await import('./registry.js');
const { resultProjectionLogFields } = await import('../audit/result-projection.js');

async function captureResultProjection<T>(run: (log: (measurement: Parameters<typeof resultProjectionLogFields>[0]) => void) => Promise<T>) {
  const events: Parameters<typeof resultProjectionLogFields>[0][] = [];
  const value = await run((measurement) => events.push(measurement));
  return { value, events: events.map(resultProjectionLogFields) };
}

async function withCompactJsonMode<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[COMPACT_RESULT_JSON_MODE_ENV];
  if (value === undefined) delete process.env[COMPACT_RESULT_JSON_MODE_ENV];
  else process.env[COMPACT_RESULT_JSON_MODE_ENV] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[COMPACT_RESULT_JSON_MODE_ENV];
    else process.env[COMPACT_RESULT_JSON_MODE_ENV] = previous;
  }
}

test('compact serialization writes require exact opt-in and default off', async () => {
  await withCompactJsonMode(undefined, async () => assert.equal(compactResultJsonWritesEnabled(), false));
  await withCompactJsonMode('off', async () => assert.equal(compactResultJsonWritesEnabled(), false));
  await withCompactJsonMode('ON', async () => assert.equal(compactResultJsonWritesEnabled(), false));
  await withCompactJsonMode('on', async () => assert.equal(compactResultJsonWritesEnabled(), true));
});

test('successful result offload logs original UTF-8 bytes and initial preview bytes without content', async () => {
  const store = fakeResultStore();
  const fullText = 'oversized synthetic result '.repeat(2000);
  const { value: outcome, events } = await captureResultProjection((logProjection) =>
    offloadResult(fullText, { payload: fullText }, 'corr_synthetic', '9'.repeat(64), { ...store.deps, logProjection }));
  assert.ok(outcome);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: 'result_projection',
    outcome: 'offloaded',
    size_class: '40KiB-64KiB',
    original_bytes: Buffer.byteLength(fullText, 'utf8'),
    initial_return_bytes: Buffer.byteLength(outcome.preview, 'utf8'),
  });
  assert.equal(JSON.stringify(events).includes(fullText.slice(0, 30)), false);
});

test('synthetic result pilot receipt confirms bounded initial return and full retrieval before TTL', async () => {
  const store = fakeResultStore();
  const callerHash = '5'.repeat(64);
  const payload = { rows: ['synthetic-row-'.repeat(4000)] };
  const fullText = JSON.stringify(payload);
  const { value: outcome, events } = await captureResultProjection((logProjection) =>
    offloadResult(fullText, payload, 'corr_synthetic_pilot', callerHash, { ...store.deps, logProjection }));
  assert.ok(outcome);
  const stored = store.docs.get(outcome.resultId)!;
  store.setNow(Number(stored.expiresAt) - 1);
  const pages: string[] = [];
  let pageCount = 0;
  for (let page = 0; ; page++) {
    const fetched = await fetchStoredResult(outcome.resultId, page, callerHash, store.deps);
    assert.equal(fetched.found, true);
    pages.push(fetched.chunk!);
    pageCount = fetched.pages!;
    if (page + 1 >= pageCount) break;
  }
  const reassembled = pages.join('');
  assert.deepEqual(JSON.parse(reassembled), payload);
  const receipt = {
    task_id: 'synthetic-result-pilot-v1',
    original_bytes: Buffer.byteLength(fullText, 'utf8'),
    initial_return_bytes: Buffer.byteLength(outcome.preview, 'utf8'),
    retrieved_bytes: Buffer.byteLength(reassembled, 'utf8'),
    retrieved_payload_bytes: Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf8'),
    pages: pageCount,
    fully_retrievable_before_ttl: true,
    actual_tool_tokens: null,
    host_deferral_observed: null,
  };
  assert.equal(receipt.initial_return_bytes < receipt.original_bytes, true);
  assert.equal(receipt.retrieved_bytes, receipt.retrieved_payload_bytes);
  assert.ok(events.some(({ outcome: kind }) => kind === 'offloaded'));
  assert.ok(pageCount > 0);
});

test('storage failure logs fail_open and returns null so the caller keeps the inline result', async () => {
  const store = fakeResultStore();
  const fullText = 'large synthetic inline fallback '.repeat(1800);
  const failingDeps = {
    ...store.deps,
    upsertDoc: async () => { throw new Error('private storage detail'); },
  };
  const { value: outcome, events } = await captureResultProjection((logProjection) =>
    offloadResult(fullText, { payload: fullText }, 'corr_synthetic', '8'.repeat(64), { ...failingDeps, logProjection }));
  assert.equal(outcome, null);
  assert.deepEqual(events, [{
    type: 'result_projection',
    outcome: 'fail_open',
    size_class: '40KiB-64KiB',
    original_bytes: Buffer.byteLength(fullText, 'utf8'),
    initial_return_bytes: Buffer.byteLength(fullText, 'utf8'),
  }]);
  assert.equal(JSON.stringify(events).includes('private storage detail'), false);
});

test('successful fetch logs retrieved page bytes and fixed pagination counts', async () => {
  const store = fakeResultStore();
  const data = { payload: 'r'.repeat(PAGE_CHARS + 50) };
  const outcome = await offloadResult(JSON.stringify(data), data, 'corr_synthetic', '7'.repeat(64), store.deps);
  assert.ok(outcome);
  const { value: fetched, events } = await captureResultProjection((logProjection) =>
    fetchStoredResult(outcome.resultId, 0, '7'.repeat(64), { ...store.deps, logProjection }));
  assert.equal(fetched.found, true);
  assert.deepEqual(events[0], {
    type: 'result_projection',
    outcome: 'retrieved',
    size_class: 'under-40KiB',
    original_bytes: Buffer.byteLength(JSON.stringify(data, null, 2), 'utf8'),
    returned_bytes: Buffer.byteLength(fetched.chunk!, 'utf8'),
    page: 0,
    pages: 2,
  });
});

test('extractResultSummary: Xero list envelope -> pagination + array lengths, nothing else copied', () => {
  const data = {
    body: {
      Id: 'x',
      Status: 'OK',
      pagination: { page: 1, pageSize: 100, pageCount: 18, itemCount: 1753, extra: 'ignored' },
      Invoices: new Array(100).fill({ Total: 1 }),
    },
  };
  assert.deepEqual(extractResultSummary(data), {
    pagination: { page: 1, pageSize: 100, pageCount: 18, itemCount: 1753 },
    array_lengths: { Invoices: 100 },
  });
});

test('extractResultSummary: xero_bank_transfers shim counts are carried', () => {
  const s = extractResultSummary({ total_matching: 256, page: 1, pages: 3, body: { BankTransfers: [1, 2, 3] } });
  assert.deepEqual(s, { total_matching: 256, page: 1, pages: 3, array_lengths: { BankTransfers: 3 } });
});

test('extractResultSummary: returns undefined for scalars, null and shapes with nothing recognisable', () => {
  assert.equal(extractResultSummary(null), undefined);
  assert.equal(extractResultSummary('text'), undefined);
  assert.equal(extractResultSummary({ a: 1, b: { c: 2 } }), undefined);
});

test('extractResultSummary: caps array_lengths at 8 keys', () => {
  const body: Record<string, unknown[]> = {};
  for (let i = 0; i < 12; i++) body['k' + i] = [i];
  const s = extractResultSummary({ body }) as { array_lengths: Record<string, number> };
  assert.equal(Object.keys(s.array_lengths).length, 8);
});

test('shouldOffload is false for a short result (backward-compatible: small results untouched)', () => {
  assert.equal(shouldOffload('small result'), false);
  assert.equal(shouldOffload(''), false);
});

test('ordinary inline result records only content-free byte and fixed outcome fields', () => {
  const events: Parameters<typeof resultProjectionLogFields>[0][] = [];
  const text = 'ordinary synthetic inline result 😀';
  recordInlineResultProjection(text, (measurement) => events.push(measurement));
  assert.deepEqual(events.map(resultProjectionLogFields), [{
    type: 'result_projection',
    outcome: 'inline',
    size_class: 'under-40KiB',
    original_bytes: Buffer.byteLength(text, 'utf8'),
    initial_return_bytes: Buffer.byteLength(text, 'utf8'),
  }]);
  assert.equal(JSON.stringify(events).includes(text), false);
  recordInlineResultProjection(123 as unknown as string, (measurement) => events.push(measurement));
  assert.equal(events.length, 1, 'malformed runtime input is ignored');
});

test('buildPreview embeds the result_id, the JIT marker, and head+tail for long input', () => {
  const full = 'H'.repeat(4000) + 'M'.repeat(60000) + 'T'.repeat(1000);
  const p = buildPreview(full, 'jitres_abc');
  assert.match(p, /result_id="jitres_abc"/);
  assert.match(p, /gateway_fetch_result/);
  assert.match(p, /JIT: this result \(65000 chars\)/);
  assert.ok(p.startsWith('H'.repeat(100)), 'preview starts with the head');
  assert.ok(p.trimEnd().endsWith('T'.repeat(1000)), 'preview ends with the tail');
  assert.ok(p.length < full.length, 'preview is smaller than the full payload');
});

test('offloaded wake reference preserves the exact five-field provenance consumer contract', () => {
  const reference = buildOffloadedResultReference('jitres_fake_12345678', 133553, {
    array_lengths: { sections: 9 },
  });
  assert.deepEqual(Object.keys(reference).sort(), [
    '_jit_offloaded', 'note', 'result_id', 'summary', 'total_bytes',
  ]);
  assert.equal(reference._jit_offloaded, true);
  assert.equal(reference.result_id, 'jitres_fake_12345678');
  assert.equal(reference.total_bytes, 133553);
});

test('buildPreview omits the tail when input is short enough (head+marker only)', () => {
  const p = buildPreview('abc', 'jitres_x');
  assert.ok(p.startsWith('abc'));
  assert.match(p, /result_id="jitres_x"/);
});

test('pageCount: at least 1 page; splits on PAGE_CHARS boundary', () => {
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(PAGE_CHARS), 1);
  assert.equal(pageCount(PAGE_CHARS + 1), 2);
  assert.equal(pageCount(PAGE_CHARS * 3), 3);
});

test('pageSlice: clamps out-of-range pages and returns the right chunk', () => {
  const s = 'a'.repeat(PAGE_CHARS) + 'b'.repeat(PAGE_CHARS) + 'c'.repeat(500);
  const p0 = pageSlice(s, 0);
  assert.equal(p0.pages, 3);
  assert.equal(p0.page, 0);
  assert.equal(p0.chunk, 'a'.repeat(PAGE_CHARS));
  assert.equal(pageSlice(s, -5).page, 0, 'negative clamps to 0');
  const last = pageSlice(s, 99);
  assert.equal(last.page, 2, 'beyond-end clamps to last page');
  assert.equal(last.chunk, 'c'.repeat(500));
});

test('PAGE_CHARS stays below the offload threshold', () => {
  assert.ok(PAGE_CHARS < 40000);
});

test('gateway_fetch_result is a terminal transport that cannot recursively offload', () => {
  assert.equal(mayOffloadToolResult('gateway_fetch_result'), false);
  assert.equal(mayOffloadToolResult('catalog_list_tools'), true);
});

test('the AWS bridge tools are never offloaded to the shared result cache, and other tools still are', () => {
  // The whole aws_mcp_ family is excluded by prefix, so a tool added to it later is covered too.
  for (const name of ['aws_mcp_tool_call', 'aws_mcp_tool_list', 'aws_mcp_added_later', 'aws_mcp_']) {
    assert.equal(mayOffloadToolResult(name), false, name);
  }
  // It is a prefix match on the canonical name: lookalikes keep the normal offload behaviour.
  for (const name of ['catalog_list_tools', 'aws_inventory_read', 'aws_mcp', 'my_aws_mcp_tool_call', 'gateway_fetch_results']) {
    assert.equal(mayOffloadToolResult(name), true, name);
  }
  assert.equal(mayOffloadToolResult('brain_graph_search'), false);
});

test('escape-heavy Unicode JSON pages stay bounded and reassemble to the exact UTF-8 bytes', async () => {
  const store = fakeResultStore();
  const callerHash = '9'.repeat(64);
  const data = {
    history: ('quote=" slash=\\ newline=\n tab=\t nul=\u0000 emoji=😀 musical=𝄞 ').repeat(5000),
  };
  const serialized = JSON.stringify(data);
  const outcome = await withCompactJsonMode('on', () =>
    offloadResult(serialized, data, 'corr_escape_heavy', callerHash, store.deps));
  assert.ok(outcome);

  const first = await withCompactJsonMode('off', () =>
    fetchStoredResult(outcome.resultId, 0, callerHash, store.deps));
  assert.equal(first.found, true);
  assert.ok(first.pages! > Math.ceil(serialized.length / PAGE_CHARS), 'fixture exercises JSON escape expansion');
  const chunks: string[] = [];
  for (let page = 0; page < first.pages!; page++) {
    const response = await handleGatewayFetchResult(
      { result_id: outcome.resultId, page },
      { callerHash },
      { fetchStoredResult: (id, requestedPage, hash) =>
        withCompactJsonMode('off', () => fetchStoredResult(id, requestedPage, hash, store.deps)) },
    );
    const fetched = response.data as {
      found: boolean;
      total_bytes?: number;
      page?: number;
      pages?: number;
      chunk?: string;
    };
    assert.equal(fetched.found, true);
    assert.ok(fetched.chunk !== undefined);
    const renderedText = JSON.stringify(fetched, null, 2) + '\n\n' + response.summary;
    const renderedBytes = Buffer.byteLength(renderedText, 'utf8');
    assert.ok(renderedBytes < 40000, 'page ' + page + ' rendered ' + renderedBytes + ' UTF-8 bytes');
    assert.equal(/[\uD800-\uDBFF]$/.test(fetched.chunk), false, 'page ' + page + ' ends with a split surrogate');
    assert.equal(/^[\uDC00-\uDFFF]/.test(fetched.chunk), false, 'page ' + page + ' starts with a split surrogate');
    chunks.push(fetched.chunk!);
  }

  const reassembled = chunks.join('');
  assert.equal(reassembled, serialized);
  assert.deepEqual(Buffer.from(reassembled, 'utf8'), Buffer.from(serialized, 'utf8'));
  assert.equal(first.total_bytes, Buffer.byteLength(serialized, 'utf8'));
  assert.equal(outcome.totalBytes, Buffer.byteLength(serialized, 'utf8'));
});

function fakeResultStore(nowValue = Date.parse('2026-09-08T00:00:00.000Z')) {
  const docs = new Map<string, Record<string, unknown>>();
  let now = nowValue;
  let sequence = 0;
  return {
    docs,
    setNow(value: number) { now = value; },
    deps: {
      newId: () => 'jitres_fixture_' + String(++sequence),
      upsertDoc: async (_collection: string, partitionKey: string, doc: Record<string, unknown>) => {
        docs.set(partitionKey, structuredClone(doc));
      },
      readDoc: async (_collection: string, partitionKey: string, _id: string) => {
        const doc = docs.get(partitionKey);
        return doc ? { doc: structuredClone(doc) } : null;
      },
      now: () => now,
    },
  };
}

test('cursor mode reconstructs pretty and compact records with changing limits and bounded output', async () => {
  for (const format of [undefined, 'compact-json-v1']) {
    const store = fakeResultStore();
    const caller = 'a'.repeat(64);
    const data = { text: ('quote" slash\\ control\n emoji😀 lone\ud800 ').repeat(4000) };
    store.docs.set('cursor-fixture', { type: 'jit_result', caller_hash: caller, data,
      serialization_format: format, expiresAt: store.deps.now() + 1000 });
    const expected = format ? JSON.stringify(data) : JSON.stringify(data, null, 2);
    let offset = 0;
    const chunks: string[] = [];
    let counter = 0;
    while (true) {
      const maxChunkBytes = counter++ % 2 ? 1024 : 8192;
      const result = await fetchStoredResult('cursor-fixture', 0, caller, store.deps, { offset, maxChunkBytes });
      assert.equal(result.found, true);
      assert.equal(result.offset, offset);
      assert.ok(Buffer.byteLength(JSON.stringify(result.chunk), 'utf8') <= maxChunkBytes + 2);
      const rendered = buildTextContent({ data: result, summary: 'synthetic result' }, null);
      assert.ok(Buffer.byteLength(rendered, 'utf8') < 8500);
      const simulatedWireResponse = { content: [{ type: 'text', text: rendered }], structuredContent: { result } };
      assert.ok(Buffer.byteLength(JSON.stringify(simulatedWireResponse), 'utf8') < 40000);
      chunks.push(result.chunk!);
      if (result.done) { assert.equal(result.next_offset, null); break; }
      assert.ok(result.next_offset! > offset);
      offset = result.next_offset!;
    }
    assert.equal(chunks.join(''), expected);
    assert.deepEqual(JSON.parse(chunks.join('')), data);
  }
});

test('cursor validation rejects invalid positions and never splits surrogate pairs', () => {
  const text = 'a'.repeat(1023) + '😀' + '\\"\n'.repeat(500);
  const first = cursorSlice(text, { offset: 0, maxChunkBytes: 1024 });
  assert.equal(first.next_offset, 1023);
  assert.throws(() => cursorSlice(text, { offset: 1024, maxChunkBytes: 1024 }), /Invalid/);
  for (const cursor of [{ offset: -1, maxChunkBytes: 1024 }, { offset: text.length + 1, maxChunkBytes: 1024 },
    { offset: 0, maxChunkBytes: 1023 }, { offset: 0, maxChunkBytes: 30001 }, { offset: 1.5, maxChunkBytes: 1024 }]) {
    assert.throws(() => cursorSlice(text, cursor), /Invalid/);
  }
  assert.deepEqual(cursorSlice(text, { offset: text.length, maxChunkBytes: 1024 }),
    { offset: text.length, next_offset: null, done: true, chunk: '' });
});

test('cursor retrieval keeps authorization, expiry and legacy paging semantics', async () => {
  const store = fakeResultStore();
  const caller = 'b'.repeat(64);
  const result = await offloadResult('fixture', { text: '😀'.repeat(9000) }, 'corr', caller, store.deps);
  assert.ok(result);
  const legacy = await fetchStoredResult(result.resultId, 0, caller, store.deps);
  assert.deepEqual(legacy, await fetchStoredResult(result.resultId, 0, caller, store.deps, undefined));
  assert.deepEqual(await fetchStoredResult(result.resultId, 0, 'c'.repeat(64), store.deps,
    { offset: 999999, maxChunkBytes: 1024 }), { found: false });
  store.setNow(store.deps.now() + 3_700_000);
  assert.deepEqual(await fetchStoredResult(result.resultId, 0, caller, store.deps,
    { offset: 0, maxChunkBytes: 1024 }), { found: false, expired: true });
});

test('cursor handler rejects mixed modes and passes authenticated continuation', async () => {
  const callerHash = '1'.repeat(64);
  const calls: unknown[] = [];
  const deps = { fetchStoredResult: async (...args: unknown[]) => {
    calls.push(args); return { found: true, total_bytes: 5, offset: 3, next_offset: null, done: true, chunk: 'end' };
  } };
  await assert.rejects(() => handleGatewayFetchResult({ result_id: 'fixture', page: 0, max_chunk_bytes: 8192 }, { callerHash }, deps), /Invalid/);
  await assert.rejects(() => handleGatewayFetchResult({ result_id: 'fixture', offset: 1 }, { callerHash }, deps), /Invalid/);
  const result = await handleGatewayFetchResult({ result_id: 'fixture', offset: 3, max_chunk_bytes: 8192 }, { callerHash }, deps);
  assert.deepEqual(calls, [['fixture', 0, callerHash, { offset: 3, maxChunkBytes: 8192 }]]);
  await handleGatewayFetchResult({ result_id: 'fixture', offset: 3, max_chunk_bytes: 8192,
    expected_origin_tool: 'wake' }, { callerHash }, deps);
  assert.deepEqual(calls[1], ['fixture', 0, callerHash, { offset: 3, maxChunkBytes: 8192 }, 'wake']);
  assert.equal((result.data as { done: boolean }).done, true);
});

test('offloaded result persists the exact authenticated caller hash and same caller pages it', async () => {
  const store = fakeResultStore();
  const callerHash = 'a'.repeat(64);
  const data = { payload: 'x'.repeat(PAGE_CHARS * 2 + 10) };
  const outcome = await offloadResult(
    JSON.stringify(data),
    data,
    'corr_synthetic',
    callerHash,
    store.deps,
  );
  assert.ok(outcome);
  const stored = store.docs.get(outcome.resultId);
  assert.equal(stored?.caller_hash, callerHash);
  assert.equal(stored?.type, 'jit_result');

  const first = await fetchStoredResult(outcome.resultId, 0, callerHash, store.deps);
  const second = await fetchStoredResult(outcome.resultId, 1, callerHash, store.deps);
  assert.equal(first.found, true);
  assert.equal(first.page, 0);
  assert.equal(second.found, true);
  assert.equal(second.page, 1);
  assert.ok(first.chunk);
  assert.ok(second.chunk);
});

test('every page rejects a different caller without payload or existence metadata', async () => {
  const store = fakeResultStore();
  const ownerHash = 'b'.repeat(64);
  const otherHash = 'c'.repeat(64);
  const outcome = await offloadResult(
    'synthetic',
    { payload: 'private synthetic result' },
    'corr_synthetic',
    ownerHash,
    store.deps,
  );
  assert.ok(outcome);
  for (const page of [0, 1, 999]) {
    const denied = await fetchStoredResult(outcome.resultId, page, otherHash, store.deps);
    assert.deepEqual(denied, { found: false });
    assert.equal('chunk' in denied, false);
    assert.equal('expired' in denied, false);
  }
});

test('origin binding preserves legacy explicit-id reads and verifies new records after caller authorization', async () => {
  const store = fakeResultStore();
  const ownerHash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const legacyId = 'jitres_legacy_origin';
  store.docs.set(legacyId, {
    id: legacyId,
    cacheScope: legacyId,
    type: 'jit_result',
    caller_hash: ownerHash,
    correlation_id: 'corr_legacy_origin',
    data: { payload: 'legacy synthetic wake context' },
    expiresAt: store.deps.now() + 60_000,
  });

  const legacyRead = await fetchStoredResult(legacyId, 0, ownerHash, store.deps);
  assert.equal(legacyRead.found, true, 'old records remain readable by explicit id without an origin check');
  assert.deepEqual(
    await fetchStoredResult(legacyId, 0, ownerHash, store.deps, undefined, 'wake'),
    { found: false },
    'asking to verify origin on an old record fails generically because no origin was recorded',
  );
  assert.deepEqual(
    await fetchStoredResult(legacyId, 0, otherHash, store.deps),
    { found: false },
    'legacy result remains bound to its original caller',
  );

  const data = { payload: 'x'.repeat(PAGE_CHARS + 20) };
  const outcome = await offloadResult(JSON.stringify(data), data, 'corr_new_origin', ownerHash, store.deps, 'wake');
  assert.ok(outcome);
  assert.equal(store.docs.get(outcome.resultId)?.origin_tool, 'wake');
  assert.equal(
    (await fetchStoredResult(outcome.resultId, 0, ownerHash, store.deps, undefined, 'wake')).found,
    true,
    'same caller can retrieve with matching expected origin',
  );

  const aliasOutcome = await offloadResult(
    'synthetic alias result', { payload: 'synthetic alias result' }, 'corr_alias_origin',
    ownerHash, store.deps, 'github_repo_get',
  );
  assert.ok(aliasOutcome);
  assert.equal(
    store.docs.get(aliasOutcome.resultId)?.origin_tool,
    'github_repo_get',
    'origin binding records canonical github_repo_get for its M365 repo_get alias',
  );
  assert.deepEqual(
    await fetchStoredResult(outcome.resultId, 0, ownerHash, store.deps, undefined, 'memory_pack'),
    { found: false },
    'wrong expected origin is indistinguishable from a miss',
  );
  assert.deepEqual(
    await fetchStoredResult(outcome.resultId, 0, otherHash, store.deps, undefined, 'wake'),
    { found: false },
    'wrong caller stays indistinguishable from a miss even with matching origin',
  );

  const firstCursor = await fetchStoredResult(
    outcome.resultId, 0, ownerHash, store.deps,
    { offset: 0, maxChunkBytes: 8192 }, 'wake',
  );
  assert.equal(firstCursor.found, true);
  assert.equal(firstCursor.offset, 0);
  assert.ok(firstCursor.next_offset !== null);
  const nextCursor = await fetchStoredResult(
    outcome.resultId, 0, ownerHash, store.deps,
    { offset: firstCursor.next_offset!, maxChunkBytes: 8192 }, 'wake',
  );
  assert.equal(nextCursor.found, true);
  assert.equal(nextCursor.offset, firstCursor.next_offset);
});

test('fetch result reports verified origin only for matching authorized page and cursor reads', async () => {
  const store = fakeResultStore();
  const ownerHash = 'c'.repeat(64);
  const otherHash = 'd'.repeat(64);
  const legacyId = 'jitres_legacy_without_origin';
  store.docs.set(legacyId, {
    id: legacyId,
    cacheScope: legacyId,
    type: 'jit_result',
    caller_hash: ownerHash,
    correlation_id: 'corr_legacy_without_origin',
    data: { payload: 'legacy' },
    expiresAt: store.deps.now() + 60_000,
  });
  const data = { payload: 'x'.repeat(PAGE_CHARS + 200) };
  const stored = await offloadResult(JSON.stringify(data), data, 'corr_verified_origin', ownerHash, store.deps, 'wake');
  assert.ok(stored);
  const deps = {
    fetchStoredResult: (id: string, page: number, callerHash: string,
      cursor?: Parameters<typeof fetchStoredResult>[4], expectedOriginTool?: string) =>
      fetchStoredResult(id, page, callerHash, store.deps, cursor, expectedOriginTool),
  };

  const page = await handleGatewayFetchResult(
    { result_id: stored.resultId, expected_origin_tool: 'wake' }, { callerHash: ownerHash }, deps,
  );
  const pageData = page.data as Record<string, unknown>;
  assert.equal(pageData.found, true);
  assert.equal(pageData.verified_origin_tool, 'wake');

  const cursor = await handleGatewayFetchResult(
    { result_id: stored.resultId, offset: 0, max_chunk_bytes: 1024, expected_origin_tool: 'wake' },
    { callerHash: ownerHash }, deps,
  );
  const cursorData = cursor.data as Record<string, unknown>;
  assert.equal(cursorData.found, true);
  assert.equal(cursorData.verified_origin_tool, 'wake');

  const unrequested = await handleGatewayFetchResult(
    { result_id: stored.resultId }, { callerHash: ownerHash }, deps,
  );
  assert.equal((unrequested.data as Record<string, unknown>).found, true);
  assert.equal(Object.hasOwn(unrequested.data as object, 'verified_origin_tool'), false,
    'old callers retain the original successful response shape');

  const legacy = await handleGatewayFetchResult(
    { result_id: legacyId, expected_origin_tool: 'wake' }, { callerHash: ownerHash }, deps,
  );
  const wrongCaller = await handleGatewayFetchResult(
    { result_id: stored.resultId, expected_origin_tool: 'wake' }, { callerHash: otherHash }, deps,
  );
  const mismatchedOrigin = await handleGatewayFetchResult(
    { result_id: stored.resultId, expected_origin_tool: 'memory_pack' }, { callerHash: ownerHash }, deps,
  );
  assert.deepEqual(legacy.data, { found: false }, 'legacy records cannot claim verified origin');
  assert.deepEqual(wrongCaller.data, { found: false }, 'wrong caller cannot claim verified origin');
  assert.deepEqual(mismatchedOrigin.data, { found: false }, 'origin mismatch remains a generic miss');
  assert.equal(wrongCaller.summary, mismatchedOrigin.summary,
    'wrong-caller and origin-mismatch misses for the same ID remain indistinguishable');
  assert.equal(legacy.summary,
    'no stored result for ' + legacyId + ' (invalid id, unauthorized, or expired).',
    'legacy-origin miss uses the same generic miss format');
  assert.equal(Object.hasOwn(legacy.data as object, 'verified_origin_tool'), false);
  assert.equal(Object.hasOwn(wrongCaller.data as object, 'verified_origin_tool'), false);
  assert.equal(Object.hasOwn(mismatchedOrigin.data as object, 'verified_origin_tool'), false);
});

test('legacy unbound and malformed-caller result access fails closed', async () => {
  const store = fakeResultStore();
  store.docs.set('jitres_legacy', {
    id: 'jitres_legacy',
    cacheScope: 'jitres_legacy',
    type: 'jit_result',
    data: { payload: 'legacy synthetic payload' },
    expiresAt: store.deps.now() + 60_000,
  });
  assert.deepEqual(
    await fetchStoredResult('jitres_legacy', 0, 'd'.repeat(64), store.deps),
    { found: false },
  );
  assert.deepEqual(
    await fetchStoredResult('jitres_legacy', 0, 'unknown', store.deps),
    { found: false },
  );
  assert.equal(
    await offloadResult('synthetic', { payload: 'x' }, 'corr', 'unknown', store.deps),
    null,
  );
  assert.equal(store.docs.size, 1);
});

test('expiry is visible only to the exact caller bound to the result', async () => {
  const store = fakeResultStore();
  const ownerHash = 'e'.repeat(64);
  const outcome = await offloadResult(
    'synthetic',
    { payload: 'expired synthetic payload' },
    'corr_synthetic',
    ownerHash,
    store.deps,
  );
  assert.ok(outcome);
  store.setNow(store.deps.now() + 3_700_000);
  assert.deepEqual(
    await fetchStoredResult(outcome.resultId, 0, ownerHash, store.deps),
    { found: false, expired: true },
  );
  assert.deepEqual(
    await fetchStoredResult(outcome.resultId, 0, 'f'.repeat(64), store.deps),
    { found: false },
  );
});

test('gateway fetch handler forwards the exact request caller hash on every page', async () => {
  const callerHash = '1'.repeat(64);
  const calls: unknown[] = [];
  const response = await handleGatewayFetchResult(
    { result_id: 'jitres_synthetic', page: 7 },
    { callerHash },
    {
      fetchStoredResult: async (...args) => {
        calls.push(args);
        return { found: false };
      },
    },
  );
  assert.deepEqual(calls, [['jitres_synthetic', 7, callerHash]]);
  assert.deepEqual(response.data, { found: false });
  assert.match(response.summary, /unauthorized/);
});

test('compact stored JSON preserves nested values and reduces a large invoice payload by over 20%', async () => {
  const store = fakeResultStore();
  const callerHash = '8'.repeat(64);
  const data = {
    body: {
      Id: 'synthetic',
      Status: 'OK',
      pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 100 },
      Invoices: Array.from({ length: 100 }, (_, i) => ({
        InvoiceID: `INV-${String(i).padStart(6, '0')}`,
        Contact: { ContactID: `CONTACT-${i}`, Name: `Synthetic customer ${i}` },
        Date: '2026-09-01',
        DueDate: '2026-09-30',
        Status: 'AUTHORISED',
        LineItems: [{ Description: 'Synthetic service', Quantity: 1, UnitAmount: 125.5, TaxType: 'OUTPUT', AccountCode: '200' }],
        Total: 125.5,
        CurrencyCode: 'USD',
      })),
    },
  };
  const pretty = JSON.stringify(data, null, 2);
  const compact = JSON.stringify(data);
  assert.deepEqual(JSON.parse(compact), JSON.parse(pretty));
  assert.ok(Buffer.byteLength(compact, 'utf8') < Buffer.byteLength(pretty, 'utf8') * 0.8);

  const outcome = await withCompactJsonMode('on', () =>
    offloadResult(pretty, data, 'corr_compact_synthetic', callerHash, store.deps));
  assert.ok(outcome);
  const stored = store.docs.get(outcome.resultId);
  assert.equal(stored?.serialization_format, 'compact-json-v1');
  assert.equal(stored?.total_bytes, Buffer.byteLength(compact, 'utf8'));
  const first = await withCompactJsonMode('off', () =>
    fetchStoredResult(outcome.resultId, 0, callerHash, store.deps));
  assert.equal(first.found, true);
  assert.equal(first.pages, 2);
  const chunks: string[] = [];
  for (let page = 0; page < first.pages!; page++) {
    const fetched = await withCompactJsonMode('off', () =>
      fetchStoredResult(outcome.resultId, page, callerHash, store.deps));
    assert.equal(fetched.found, true);
    assert.ok(fetched.chunk !== undefined);
    chunks.push(fetched.chunk!);
    assert.equal(fetched.total_bytes, Buffer.byteLength(compact, 'utf8'));
  }
  const reassembled = chunks.join('');
  assert.equal(reassembled, compact);
  assert.equal(outcome.totalBytes, Buffer.byteLength(compact, 'utf8'));
  assert.deepEqual(JSON.parse(reassembled), data);
});

test('legacy results stay pretty and paginate identically when compact writes are enabled', async () => {
  const store = fakeResultStore();
  const callerHash = '7'.repeat(64);
  const data = { rows: Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'Synthetic row ' + i, nested: { active: true } })) };
  const pretty = JSON.stringify(data, null, 2);
  const outcome = await withCompactJsonMode('off', () =>
    offloadResult(pretty, data, 'corr_legacy_read', callerHash, store.deps));
  assert.ok(outcome);
  const stored = store.docs.get(outcome.resultId);
  assert.equal(stored?.serialization_format, undefined);
  assert.equal(stored?.total_bytes, Buffer.byteLength(pretty, 'utf8'));
  assert.equal(outcome.totalBytes, Buffer.byteLength(pretty, 'utf8'));

  const fetched = await withCompactJsonMode('on', async () => {
    const first = await fetchStoredResult(outcome.resultId, 0, callerHash, store.deps);
    const chunks: string[] = [];
    for (let page = 0; page < first.pages!; page++) {
      chunks.push((await fetchStoredResult(outcome.resultId, page, callerHash, store.deps)).chunk!);
    }
    return { first, chunks };
  });
  assert.equal(fetched.first.total_bytes, Buffer.byteLength(pretty, 'utf8'));
  assert.equal(fetched.first.pages, pageCount(pretty));
  assert.equal(fetched.chunks.join(''), pretty);
  assert.deepEqual(JSON.parse(fetched.chunks.join('')), data);
});

test('unknown stored serialization formats fail closed before payload serialization', async () => {
  const callerHash = '6'.repeat(64);
  const result = await fetchStoredResult('jitres_unknown_format', 0, callerHash, {
    newId: () => 'unused',
    upsertDoc: async () => undefined,
    readDoc: async () => ({
      doc: {
        id: 'jitres_unknown_format',
        type: 'jit_result',
        caller_hash: callerHash,
        expiresAt: Date.now() + 60_000,
        serialization_format: 'compact-json-v2',
        data: 1n,
      },
    }),
    now: Date.now,
  });
  assert.deepEqual(result, { found: false });
});
