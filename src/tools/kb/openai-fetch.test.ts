import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same preamble as openai-search.test.ts / search.test.ts — satisfies loadEnv()'s required vars,
// then configures Azure AI Search so handleOpenAiFetch's real code paths run below.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
// Pin the pre-2026-08-28 backend defaults (env.ts's SEARCH_BACKEND/EMBEDDINGS_PROVIDER/
// LLM_PROVIDER/WEB_SEARCH_PROVIDER/BLOB_BACKEND/STATE_BACKEND now default to their AWS-native
// replacements) so this file keeps exercising exactly the Azure/Foundry/Cosmos code path it was
// written for -- those paths stay inert-but-present and still need this coverage.
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.SEARCH_BACKEND ||= 'azure';
process.env.LLM_PROVIDER ||= 'foundry';
process.env.EMBEDDINGS_PROVIDER ||= 'foundry';
process.env.WEB_SEARCH_PROVIDER ||= 'azure';
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';

const { handleOpenAiFetch } = await import('./openai-fetch.js');
const { buildCompositeId } = await import('./openai-ids.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function fakeCtx(callerAgent: string) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun: false, acknowledgeWarning: false, callerAgent };
}

type FetchResult = { id: string; title: string; text: string; url: string; metadata?: Record<string, unknown> };

/** Fails the test loudly if ANY network call is made — the tool for proving "refused before Azure
 *  Search was ever touched," which is the actual property under test for a ring refusal. */
const NETWORK_FORBIDDEN: typeof fetch = (async (url: string | URL) => {
  throw new Error(`UNEXPECTED network call to ${String(url)} — this call should have been refused before Azure Search was ever reached`);
}) as typeof fetch;

/** Stubs a successful flat-room GET-by-key returning canned text, and asserts nothing else is hit. */
function mockFlatGetFetch(text = 'the ASC key id is 9MR7PJHRYH'): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/docs/') && !u.includes('/docs/search')) {
      return new Response(JSON.stringify({ id: 'cto__142', title: 'A memory-exec fact', text }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;
}

// --- (b) SECURITY-CRITICAL: a privileged-room id from an external caller is REFUSED ---------------

test('(b) fetch of a legal-personal id by an external caller is REFUSED, with NO Azure Search call at all', async () => {
  await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
    const id = buildCompositeId('legal-personal', 'some-privileged-doc');
    const result = await handleOpenAiFetch({ id }, fakeCtx('external-read'));
    const data = result.data as FetchResult;
    assert.equal(data.text, '', 'no text must ever be returned for a refused fetch');
    assert.equal(data.title, '');
    assert.equal(data.metadata?.error, 'forbidden_ring');
  });
});

test('(b) fetch of every privileged room by an external caller is REFUSED (finance + legal + the memory rings)', async () => {
  const { RING_ROOMS } = await import('./brain-search.js');
  for (const room of RING_ROOMS) {
    await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
      const id = buildCompositeId(room, 'doc-1');
      const result = await handleOpenAiFetch({ id }, fakeCtx('external-read'));
      const data = result.data as FetchResult;
      assert.equal(data.metadata?.error, 'forbidden_ring', `room ${room} should be refused`);
    });
  }
});

test('(b) fetch of a privileged id by an UNAUTHENTICATED caller (empty string) is also REFUSED', async () => {
  await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
    const id = buildCompositeId('finance-cfo-source-docs', 'q3-statement');
    const result = await handleOpenAiFetch({ id }, fakeCtx(''));
    const data = result.data as FetchResult;
    assert.equal(data.metadata?.error, 'forbidden_ring');
  });
});

// --- (c) a public id is served correctly ----------------------------------------------------------

test('(c) fetch of a public (memory-exec) id by an external caller succeeds and returns full text', async () => {
  await withStubbedFetch(mockFlatGetFetch('the answer is 42'), async () => {
    const id = buildCompositeId('memory-exec', 'cto__142');
    const result = await handleOpenAiFetch({ id }, fakeCtx('external-read'));
    const data = result.data as FetchResult;
    assert.equal(data.id, id);
    assert.equal(data.text, 'the answer is 42');
    assert.equal(data.title, 'A memory-exec fact');
    assert.ok(data.url.startsWith('otchealth-brain://'));
    assert.equal(data.metadata?.error, undefined);
    assert.equal(data.metadata?.room, 'memory-exec');
  });
});

test('(c) fetch of a public CHUNKED-room (commons-company-journal) id by an external caller succeeds via reassembly', async () => {
  // commons-company-journal is a CHUNKED room (see azure/search.ts CHUNKED_ROOMS), so this exercises
  // the full handleOpenAiFetch -> getDocumentByKey -> parent-reassembly integration, not just the
  // flat-room GET path — one of only two OPEN_ROOMS takes exactly this path in production.
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/docs/search')) {
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        assert.equal(body.filter, "parent_id eq 'entry-9'");
        return new Response(
          JSON.stringify({
            value: [{ chunk_id: 'entry-9#0', parent_id: 'entry-9', title: 'Journal entry', path: 'journal/entry-9.md', chunk: 'journal entry text' }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const id = buildCompositeId('commons-company-journal', 'entry-9');
      const result = await handleOpenAiFetch({ id }, fakeCtx('external-read'));
      const data = result.data as FetchResult;
      assert.equal(data.text, 'journal entry text');
      assert.equal(data.title, 'Journal entry');
      assert.equal(data.metadata?.mode, 'reassembled');
    },
  );
});

// --- (d) cto caller unaffected -------------------------------------------------------------------

test('(d) cto caller: fetching a public id still succeeds exactly like external-read (no regression)', async () => {
  await withStubbedFetch(mockFlatGetFetch('cto sees the same open rooms'), async () => {
    const id = buildCompositeId('memory-exec', 'x1');
    const result = await handleOpenAiFetch({ id }, fakeCtx('cto'));
    const data = result.data as FetchResult;
    assert.equal(data.text, 'cto sees the same open rooms');
  });
});

test('(d) cto caller: fetching a privileged-room id is ALSO refused (cto has never been in EXEC_RING)', async () => {
  await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
    const id = buildCompositeId('legal-company', 'doc-1');
    const result = await handleOpenAiFetch({ id }, fakeCtx('cto'));
    const data = result.data as FetchResult;
    assert.equal(data.metadata?.error, 'forbidden_ring');
  });
});

// --- SECURITY: defense-in-depth — even an EXEC_RING caller is capped, unlike brain_search --------

test('SECURITY: an EXEC_RING caller (cfo) is ALSO refused on a privileged id through fetch() — stricter than brain_search/kb_search_privileged on purpose', async () => {
  await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
    const id = buildCompositeId('finance-cfo-source-docs', 'board-deck');
    const result = await handleOpenAiFetch({ id }, fakeCtx('cfo'));
    const data = result.data as FetchResult;
    assert.equal(data.metadata?.error, 'forbidden_ring', 'cfo can read finance-cfo-source-docs via brain_search, but NEVER via this any-engine tool pair');
  });
});

test('SECURITY: an EXEC_RING caller (exec) still succeeds on the open rooms through fetch()', async () => {
  await withStubbedFetch(mockFlatGetFetch('open room text'), async () => {
    const id = buildCompositeId('memory-exec', 'x1');
    const result = await handleOpenAiFetch({ id }, fakeCtx('exec'));
    const data = result.data as FetchResult;
    assert.equal(data.text, 'open room text');
  });
});

// --- (e) malformed / unknown id fails closed ------------------------------------------------------

test('(e) a malformed id (no "::" separator) is refused with malformed_id, no network call', async () => {
  await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
    const result = await handleOpenAiFetch({ id: 'not-a-composite-id' }, fakeCtx('external-read'));
    const data = result.data as FetchResult;
    assert.equal(data.metadata?.error, 'malformed_id');
  });
});

test('(e) an id naming an UNKNOWN/unlisted room is refused with forbidden_ring (fails closed, not "room not found")', async () => {
  await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
    const id = buildCompositeId('some-room-that-does-not-exist', 'x');
    const result = await handleOpenAiFetch({ id }, fakeCtx('external-read'));
    const data = result.data as FetchResult;
    assert.equal(data.metadata?.error, 'forbidden_ring', 'an unrecognized room must never be treated as implicitly permitted');
  });
});

test('(e) an id for a genuinely missing document in a PERMITTED room returns not_found, not an error throw', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/docs/') && !u.includes('/docs/search')) return new Response('not found', { status: 404 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const id = buildCompositeId('memory-exec', 'never-existed');
      const result = await handleOpenAiFetch({ id }, fakeCtx('external-read'));
      const data = result.data as FetchResult;
      assert.equal(data.metadata?.error, 'not_found');
    },
  );
});

// --- kill switch -----------------------------------------------------------------------------

test('OPENAI_SEARCH_MODE=off: fetch is disabled with NO network call, even for an otherwise-valid public id', async () => {
  const prior = process.env.OPENAI_SEARCH_MODE;
  process.env.OPENAI_SEARCH_MODE = 'off';
  try {
    await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
      const id = buildCompositeId('memory-exec', 'x1');
      const result = await handleOpenAiFetch({ id }, fakeCtx('external-read'));
      const data = result.data as FetchResult;
      assert.equal(data.metadata?.error, 'disabled');
    });
  } finally {
    if (prior === undefined) delete process.env.OPENAI_SEARCH_MODE;
    else process.env.OPENAI_SEARCH_MODE = prior;
  }
});

// --- fail-open ONLY after the ring check has passed -----------------------------------------------

test('a genuine Azure Search outage on a PERMITTED room degrades to a graceful refusal, never a thrown error', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/docs/') && !u.includes('/docs/search')) return new Response('internal error', { status: 500 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const id = buildCompositeId('memory-exec', 'x1');
      // Must resolve, never reject/throw — registerTool's handler contract expects a ToolResultPayload,
      // not a thrown error, for an expected-shape infra failure.
      const result = await handleOpenAiFetch({ id }, fakeCtx('external-read'));
      const data = result.data as FetchResult;
      assert.equal(data.metadata?.error, 'fetch_failed');
    },
  );
});
