import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same preamble as brain-search.test.ts / search.test.ts — satisfies loadEnv()'s required vars,
// then configures Azure AI Search so handleOpenAiSearch's real code paths run below.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';

const { handleOpenAiSearch, nonPrivilegedRoomsFor, parseOpenAiSearchMode, titleFor } = await import('./openai-search.js');
const { OPEN_ROOMS, RING_ROOMS } = await import('./brain-search.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function isSearchUrl(url: string): boolean {
  return url.includes('/indexes/') && url.includes('/docs/search');
}

/** A minimal-but-complete fake ToolContext (only callerAgent is actually read by the handler). */
function fakeCtx(callerAgent: string) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun: false, acknowledgeWarning: false, callerAgent };
}

// --- pure helpers -----------------------------------------------------------------------------

test('parseOpenAiSearchMode defaults to "on" for unset/garbage input', () => {
  assert.equal(parseOpenAiSearchMode(undefined), 'on');
  assert.equal(parseOpenAiSearchMode(''), 'on');
  assert.equal(parseOpenAiSearchMode('garbage'), 'on');
  assert.equal(parseOpenAiSearchMode('ON'), 'on');
});

test('parseOpenAiSearchMode recognizes "off" case-insensitively', () => {
  assert.equal(parseOpenAiSearchMode('off'), 'off');
  assert.equal(parseOpenAiSearchMode('OFF'), 'off');
  assert.equal(parseOpenAiSearchMode(' Off '), 'off');
});

test('titleFor prefers the source path when present', () => {
  assert.equal(titleFor('legal-company', 'legal/contractA.pdf', 'irrelevant text'), 'legal/contractA.pdf');
});

test('titleFor falls back to room + snippet when there is no path', () => {
  assert.equal(titleFor('memory-exec', undefined, 'the ASC key id is 9MR7PJHRYH'), 'memory-exec: the ASC key id is 9MR7PJHRYH');
});

// --- (a) SECURITY-CRITICAL: room selection never reaches a privileged room -----------------------

test('(a) nonPrivilegedRoomsFor: an external/unrecognized caller gets ONLY the open rooms', () => {
  for (const caller of ['external-read', '', undefined, 'randostring', 'chatgpt']) {
    const rooms = nonPrivilegedRoomsFor(caller);
    assert.deepEqual(rooms.sort(), [...OPEN_ROOMS].sort(), `caller=${String(caller)}`);
    for (const ring of RING_ROOMS) assert.ok(!rooms.includes(ring), `${String(caller)} must never reach ${ring}`);
  }
});

test('(a) SECURITY: nonPrivilegedRoomsFor caps EVEN an EXEC_RING caller (cfo/exec) to the open rooms — stricter than brain_search on purpose', () => {
  for (const caller of ['cfo', 'clo', 'clo-personal', 'exec', 'cpo']) {
    const rooms = nonPrivilegedRoomsFor(caller);
    assert.deepEqual(rooms.sort(), [...OPEN_ROOMS].sort(), `caller=${caller}`);
    for (const ring of RING_ROOMS) assert.ok(!rooms.includes(ring), `${caller} must never reach ${ring} THROUGH THIS TOOL PAIR`);
  }
});

test('(d) cto caller unaffected: gets exactly the same open-rooms-only set as before (regression guard)', () => {
  assert.deepEqual(nonPrivilegedRoomsFor('cto').sort(), [...OPEN_ROOMS].sort());
});

/** Stubs the AI Search docs/search endpoint with one canned hit per room; captures which index
 *  each request targeted so a test can assert privileged rooms were never even QUERIED. */
function mockSearchFetch(seenIndexes: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (isSearchUrl(u)) {
      const m = u.match(/\/indexes\/([^/]+)\/docs\/search/);
      if (m) seenIndexes.push(decodeURIComponent(m[1]));
      return new Response(JSON.stringify({ value: [{ id: 'cto__1', text: 'a hit for the query', '@search.rerankerScore': 2.0 }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;
}

test('(a) handleOpenAiSearch: an external caller only ever QUERIES the open rooms, never finance/legal', async () => {
  const seen: string[] = [];
  await withStubbedFetch(mockSearchFetch(seen), async () => {
    const result = await handleOpenAiSearch({ query: 'what is the ASC key id' }, fakeCtx('external-read'));
    const data = result.data as { results: Array<{ id: string; title: string; url: string; snippet?: string }> };
    assert.ok(Array.isArray(data.results));
    assert.deepEqual(seen.sort(), [...OPEN_ROOMS].sort(), 'only the open rooms were ever queried');
    for (const ring of RING_ROOMS) assert.ok(!seen.includes(ring));
  });
});

test('(a) handleOpenAiSearch: results carry a well-formed composite id "room::key" and a snippet/url', async () => {
  await withStubbedFetch(mockSearchFetch([]), async () => {
    const result = await handleOpenAiSearch({ query: 'ping' }, fakeCtx('external-read'));
    const data = result.data as { results: Array<{ id: string; title: string; url: string; snippet?: string }> };
    assert.ok(data.results.length > 0, 'expected at least one fused hit');
    for (const r of data.results) {
      assert.ok(r.id.includes('::'), `id "${r.id}" should be a composite id`);
      const [room] = r.id.split('::');
      assert.ok((OPEN_ROOMS as readonly string[]).includes(room), `cited room "${room}" must be non-privileged`);
      assert.ok(typeof r.title === 'string' && r.title.length > 0);
      assert.ok(r.url.startsWith('otchealth-brain://'));
      assert.equal(typeof r.snippet, 'string');
    }
  });
});

test('SECURITY: even an EXEC_RING caller (cfo) never gets a privileged room queried through search()', async () => {
  const seen: string[] = [];
  await withStubbedFetch(mockSearchFetch(seen), async () => {
    await handleOpenAiSearch({ query: 'anything' }, fakeCtx('cfo'));
    assert.deepEqual(seen.sort(), [...OPEN_ROOMS].sort(), 'cfo is capped to the open rooms through this tool pair');
  });
});

// --- kill switch -----------------------------------------------------------------------------

test('OPENAI_SEARCH_MODE=off: search returns an empty result set with NO network call at all', async () => {
  const prior = process.env.OPENAI_SEARCH_MODE;
  process.env.OPENAI_SEARCH_MODE = 'off';
  try {
    await withStubbedFetch(
      (async (url: string | URL) => {
        throw new Error(`unexpected fetch to ${String(url)} — OPENAI_SEARCH_MODE=off must short-circuit before any request`);
      }) as typeof fetch,
      async () => {
        const result = await handleOpenAiSearch({ query: 'ping' }, fakeCtx('external-read'));
        assert.deepEqual(result.data, { results: [] });
      },
    );
  } finally {
    if (prior === undefined) delete process.env.OPENAI_SEARCH_MODE;
    else process.env.OPENAI_SEARCH_MODE = prior;
  }
});

test('an empty/unauthenticated caller still gets a well-formed result (open rooms only, never throws)', async () => {
  await withStubbedFetch(mockSearchFetch([]), async () => {
    const result = await handleOpenAiSearch({ query: 'ping' }, fakeCtx(''));
    assert.ok(Array.isArray((result.data as { results: unknown[] }).results));
  });
});
