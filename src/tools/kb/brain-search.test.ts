import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars (searchConfigured()/foundryConfigured() go through loadEnv via
// azure/search.ts and azure/foundry.ts), then configure Azure AI Search so handleBrainSearch's real
// code paths (not the 'unconfigured' early return) run below. Mirrors src/memory/agentic.test.ts and
// src/azure/search.test.ts's preamble exactly. Foundry is deliberately left UNCONFIGURED here: the
// tests below only exercise the fast path and the deep-mode kill-switch (which must short-circuit
// BEFORE any Foundry call), so an unconfigured Foundry is itself part of proving those two paths
// never need it.
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

const { roomsFor, rrfFuse, OPEN_ROOMS, RING_ROOMS, handleBrainSearch, brainSearchInputShape } = await import('./brain-search.js');
const { z } = await import('zod');

// Pure network mocking via globalThis.fetch — the same seam src/memory/agentic.test.ts and
// src/azure/search.test.ts use, since this repo's ESM build does not let node:test's mock.method()
// redefine another module's live named export.
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

/** A minimal-but-complete fake ToolContext (only callerAgent is actually read by handleBrainSearch). */
function fakeCtx(callerAgent: string) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun: false, acknowledgeWarning: false, callerAgent };
}

// --- ring safety: federation must NEVER become a side door around a privilege boundary ---

test('a non-ring caller (cto) gets ONLY the open rooms — no finance, no legal', () => {
  const rooms = roomsFor('cto');
  assert.deepEqual(rooms, [...OPEN_ROOMS]);
  for (const r of RING_ROOMS) assert.ok(!rooms.includes(r), `cto must not reach ${r}`);
});

test('an unauthenticated caller still gets the open rooms, never the ring', () => {
  const rooms = roomsFor(undefined);
  assert.deepEqual(rooms, [...OPEN_ROOMS]);
});

test('an EXEC_RING caller (cfo) reaches the ring rooms too', () => {
  const rooms = roomsFor('cfo');
  assert.ok(rooms.includes('finance-cfo-source-docs'));
  assert.ok(rooms.includes('legal-company'));
  assert.ok(rooms.includes('memory-exec'));
});

test('REGRESSION (2026-07-21, least-privilege): coo and cro are removed from EXEC_RING, roomsFor() gives them ONLY the open rooms', () => {
  for (const caller of ['coo', 'cro']) {
    const rooms = roomsFor(caller);
    assert.deepEqual(rooms, [...OPEN_ROOMS], `caller=${caller}`);
    for (const r of RING_ROOMS) assert.ok(!rooms.includes(r), `${caller} must not reach ${r}`);
  }
});

test('a domain filter cannot escalate: cto asking for finance gets NO finance rooms', () => {
  assert.deepEqual(roomsFor('cto', 'finance'), []);
});

test('domain filter narrows correctly for a permitted caller', () => {
  // Option B (2026-07-16): cfo reaches company-legal but NOT the personal-legal rooms (clo-personal/exec only).
  assert.deepEqual(roomsFor('cfo', 'legal').sort(), ['legal-company']);
  // the personal-legal lane DOES reach all three legal rooms
  assert.deepEqual(roomsFor('clo-personal', 'legal').sort(), ['legal-company', 'legal-personal', 'legal-personal-memory']);
  assert.deepEqual(roomsFor('cto', 'exec'), ['memory-exec']);
});

test('an unknown domain returns all permitted rooms rather than silently nothing', () => {
  assert.deepEqual(roomsFor('cto', 'not-a-domain'), [...OPEN_ROOMS]);
});

// --- RRF: rrfFuse's own behavior is now tested at its source, src/memory/rrf.test.ts. This just
// proves the re-export contract brain-search.ts's header promises (existing importers unaffected).

test('rrfFuse is re-exported from brain-search.js unchanged (backward-compat for existing importers)', () => {
  const fused = rrfFuse([{ room: 'a', hits: [{ text: 'x' }] }], 1);
  assert.equal(fused[0]?.text, 'x');
});

// --- mode:'fast' is unchanged (regression), and mode:'deep' respects the DEEP_RETRIEVAL_MODE
// kill-switch. handleBrainSearch is the extracted, directly-callable handler (see brain-search.ts).

test('the wire-level zod schema defaults `mode` to "fast" when the caller omits it entirely', () => {
  const parsed = z.object(brainSearchInputShape).parse({ query: 'ping' });
  assert.equal(parsed.mode, 'fast');
});

/** Stubs the AI Search docs/search endpoint with one canned hit; THROWS on anything else (in
 *  particular an embeddings or chat/completions call), so a test using this stub can assert
 *  "Foundry was never reached" simply by not failing with an "unexpected fetch" error. */
function mockSearchOnlyFetch(): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (isSearchUrl(u)) {
      return new Response(JSON.stringify({ value: [{ id: 'x1', text: 'a fast-mode hit', '@search.rerankerScore': 1.0 }] }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch to ${u} (this path must never reach an embeddings/chat endpoint)`);
  }) as typeof fetch;
}

test('handleBrainSearch mode:"fast" is a regression: same output shape as brain_search before deep mode existed', async () => {
  await withStubbedFetch(mockSearchOnlyFetch(), async () => {
    const result = await handleBrainSearch({ query: 'what is the ASC key id', mode: 'fast' }, fakeCtx('cto'));
    const data = result.data as Record<string, unknown>;
    assert.equal(data.mode, 'federated-rrf');
    assert.ok(Array.isArray(data.matches));
    assert.equal(typeof data.count, 'number');
    assert.ok(Array.isArray(data.rooms_searched));
    assert.equal(data.include_ops, false);
    for (const deepOnlyField of ['answer', 'citations', 'sub_queries', 'rounds_used']) {
      assert.ok(!(deepOnlyField in data), `fast mode must NOT carry the deep-only field "${deepOnlyField}"`);
    }
  });
});

test('DEEP_RETRIEVAL_MODE=off: mode:"deep" behaves EXACTLY like mode:"fast" (kill-switch short-circuits before deepRetrieve/Foundry is ever reached)', async () => {
  const prior = process.env.DEEP_RETRIEVAL_MODE;
  process.env.DEEP_RETRIEVAL_MODE = 'off';
  try {
    await withStubbedFetch(mockSearchOnlyFetch(), async () => {
      // mockSearchOnlyFetch throws on anything that looks like an embeddings/chat call, so if the
      // kill-switch failed to short-circuit and deepRetrieve() (or its planning chat() call) ran
      // anyway, this test fails with "unexpected fetch" rather than silently passing.
      const result = await handleBrainSearch({ query: 'what is the ASC key id', mode: 'deep' }, fakeCtx('cto'));
      const data = result.data as Record<string, unknown>;
      assert.equal(data.mode, 'federated-rrf', 'kill-switched-off deep must produce the FAST mode marker, not deep-agentic');
      for (const deepOnlyField of ['answer', 'citations', 'sub_queries', 'rounds_used']) {
        assert.ok(!(deepOnlyField in data), `kill-switched-off deep must NOT carry the deep-only field "${deepOnlyField}"`);
      }
    });
  } finally {
    if (prior === undefined) delete process.env.DEEP_RETRIEVAL_MODE;
    else process.env.DEEP_RETRIEVAL_MODE = prior;
  }
});

test('DEEP_RETRIEVAL_MODE unset (default "on"): mode:"deep" takes the deep path (never the fast marker)', async () => {
  // This file's preamble deliberately leaves Foundry unconfigured, so ordinarily every LLM step
  // inside deepRetrieve would individually fail open (trivial plan, no refine, "unavailable"
  // synthesis note). But loadEnv() caches per-process, and node:test's isolation-per-file is an
  // assumption about the test RUNNER, not this repo's code -- so this stub tolerates an
  // embeddings/chat call too (unlike mockSearchOnlyFetch) rather than asserting on Foundry's
  // configured-ness, which is not what this test is actually about. What this test IS about: the
  // kill-switch being ON (or unset) really does route through deepRetrieve and produce a DEEP mode
  // marker + the deep-only fields, and deepRetrieve never throws either way. The mirror-image
  // "switch really is OFF" property is what the strict test above proves (it is a STRUCTURAL
  // guarantee there -- deepRetrieve is never even called -- so it does not share this concern).
  assert.equal(process.env.DEEP_RETRIEVAL_MODE, undefined, 'sanity: no leftover override from another test');
  const tolerantFetch = (async (url: string | URL) => {
    const u = String(url);
    if (isSearchUrl(u)) {
      return new Response(JSON.stringify({ value: [{ id: 'x1', text: 'a hit', '@search.rerankerScore': 1 }] }), { status: 200 });
    }
    if (u.includes('/embeddings')) return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    if (u.includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"sub_queries":["q"]}' } }], model: 'test' }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;
  await withStubbedFetch(tolerantFetch, async () => {
    const result = await handleBrainSearch({ query: 'what is the ASC key id', mode: 'deep' }, fakeCtx('cto'));
    const data = result.data as Record<string, unknown>;
    assert.ok(
      data.mode === 'deep-agentic' || data.mode === 'deep-fallback-fast',
      `expected a deep-mode marker, got "${String(data.mode)}"`,
    );
    assert.equal(typeof data.answer, 'string');
    assert.ok(Array.isArray(data.sub_queries));
    assert.equal(typeof data.rounds_used, 'number');
  });
});
