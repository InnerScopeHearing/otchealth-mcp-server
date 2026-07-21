import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars, then configure both Foundry and Azure AI Search so the
// integration-style tests below can exercise deepRetrieve's REAL code paths (not just the
// 'unconfigured' early return). Mirrors src/memory/agentic.test.ts / src/azure/search.test.ts.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';

const {
  deepRetrieve,
  fallbackFastSearch,
  parseDeepRetrievalMode,
  parseQueryPlan,
  parseRefineResponse,
  boundSubQueries,
  fusedConfidence,
  needsRefine,
  dedupeById,
  buildCitations,
  buildPlanMessages,
  buildSynthesisMessages,
  CONFIDENCE_THRESHOLD,
  NO_CONTEXT_ANSWER,
  SYNTH_UNAVAILABLE_ANSWER,
} = await import('./deep-retrieval.js');
type FusedHit = import('./rrf.js').FusedHit;

// Pure network mocking via globalThis.fetch — the same seam src/memory/agentic.test.ts and
// src/azure/search.test.ts use.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function isEmbeddingsUrl(url: string): boolean {
  return url.includes('/openai/deployments/') && url.includes('/embeddings');
}
function isChatUrl(url: string): boolean {
  return url.includes('/openai/deployments/') && url.includes('/chat/completions');
}
function isSearchUrl(url: string): boolean {
  return url.includes('/indexes/') && url.includes('/docs/search');
}
function embeddingsOk(): Response {
  return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
}
function chatJson(obj: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }], model: 'gpt-5.1' }), {
    status: 200,
  });
}
function chatText(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }], model: 'gpt-5.4' }), { status: 200 });
}

function hit(id: string, text: string, source = 'memory-exec'): FusedHit {
  return { score: 0.5, source, text, id };
}

// ============================================================================================
// (b) pure functions: plan-parse + confidence-threshold + friends
// ============================================================================================

// --- parseDeepRetrievalMode: the kill-switch parser ---

test('parseDeepRetrievalMode: "off" (any case/whitespace) -> off; everything else -> on', () => {
  assert.equal(parseDeepRetrievalMode('off'), 'off');
  assert.equal(parseDeepRetrievalMode('OFF'), 'off');
  assert.equal(parseDeepRetrievalMode('  Off  '), 'off');
  assert.equal(parseDeepRetrievalMode('on'), 'on');
  assert.equal(parseDeepRetrievalMode(''), 'on');
  assert.equal(parseDeepRetrievalMode(undefined), 'on');
  assert.equal(parseDeepRetrievalMode('garbage'), 'on');
});

// --- parseQueryPlan: the planner model's JSON reply, defensively parsed ---

test('parseQueryPlan: a clean plan is parsed, sub-queries capped at 4, rooms clamped to allowed', () => {
  const raw = JSON.stringify({
    sub_queries: ['q1', 'q2', 'q3', 'q4', 'q5'],
    rooms: ['memory-exec', 'commons-company-journal'],
  });
  const plan = parseQueryPlan(raw, 'original', ['memory-exec', 'commons-company-journal', 'legal-company']);
  assert.equal(plan.subQueries.length, 4, 'capped at 4 sub-queries');
  assert.deepEqual(plan.subQueries, ['q1', 'q2', 'q3', 'q4']);
  assert.deepEqual(plan.rooms.sort(), ['commons-company-journal', 'memory-exec']);
});

test('parseQueryPlan SECURITY: a room the model invents outside the allowed list is silently dropped, never honored', () => {
  const raw = JSON.stringify({ sub_queries: ['q1'], rooms: ['legal-personal', 'memory-exec'] });
  // Caller (brain-search.ts's roomsFor) only permitted memory-exec + commons-company-journal --
  // legal-personal must NEVER appear in the resolved plan, no matter what the model said.
  const plan = parseQueryPlan(raw, 'original', ['memory-exec', 'commons-company-journal']);
  assert.deepEqual(plan.rooms, ['memory-exec']);
  assert.ok(!plan.rooms.includes('legal-personal'), 'an invented/unpermitted room must never survive parsing');
});

test('parseQueryPlan: an empty rooms array falls back to EVERY allowed room (do not silently narrow to nothing)', () => {
  const plan = parseQueryPlan(JSON.stringify({ sub_queries: ['q1'], rooms: [] }), 'original', ['a', 'b', 'c']);
  assert.deepEqual(plan.rooms, ['a', 'b', 'c']);
});

test('parseQueryPlan: empty/missing sub_queries falls back to the original query', () => {
  assert.deepEqual(parseQueryPlan(JSON.stringify({ sub_queries: [] }), 'orig q', ['a']).subQueries, ['orig q']);
  assert.deepEqual(parseQueryPlan(JSON.stringify({}), 'orig q', ['a']).subQueries, ['orig q']);
});

test('parseQueryPlan: sub-queries are deduped case-insensitively', () => {
  const plan = parseQueryPlan(JSON.stringify({ sub_queries: ['Foo Bar', 'foo bar', 'baz'] }), 'orig', ['a']);
  assert.deepEqual(plan.subQueries, ['Foo Bar', 'baz']);
});

test('parseQueryPlan: unparseable / garbage JSON never throws, falls back to a trivial one-query plan', () => {
  const plan = parseQueryPlan('not json at all {{{', 'orig q', ['a', 'b']);
  assert.deepEqual(plan.subQueries, ['orig q']);
  assert.deepEqual(plan.rooms, ['a', 'b']);
});

test('parseQueryPlan: non-string / malformed items in sub_queries are filtered out, not thrown on', () => {
  const raw = JSON.stringify({ sub_queries: ['good', 42, null, { nested: true }, ''] });
  const plan = parseQueryPlan(raw, 'orig', ['a']);
  assert.deepEqual(plan.subQueries, ['good']);
});

// --- parseRefineResponse ---

test('parseRefineResponse: new sub-queries are kept, capped at 3, duplicates of already-tried are dropped', () => {
  const raw = JSON.stringify({ sub_queries: ['new one', 'ALREADY tried', 'new two', 'new three', 'new four'] });
  const out = parseRefineResponse(raw, ['already tried']);
  assert.deepEqual(out, ['new one', 'new two', 'new three']);
});

test('parseRefineResponse: empty/garbage input yields no refinement (never throws)', () => {
  assert.deepEqual(parseRefineResponse('{"sub_queries": []}', ['x']), []);
  assert.deepEqual(parseRefineResponse('garbage {{{', ['x']), []);
});

// --- boundSubQueries: bounds total (subquery x room) fan-out ---

test('boundSubQueries: caps sub-queries so subQueries.length * roomCount stays bounded', () => {
  const many = Array.from({ length: 4 }, (_, i) => `q${i}`);
  // 4 subqueries x 8 rooms = 32 pairs, over the 24 cap -> floor(24/8)=3 subqueries kept.
  assert.equal(boundSubQueries(many, 8).length, 3);
  // 4 subqueries x 2 rooms = 8 pairs, under the cap -> all 4 kept.
  assert.equal(boundSubQueries(many, 2).length, 4);
});

test('boundSubQueries: never drops below 1 sub-query even with a huge room count', () => {
  assert.equal(boundSubQueries(['only'], 999).length, 1);
});

test('boundSubQueries: an empty input stays empty; a zero room count keeps just the first sub-query', () => {
  assert.deepEqual(boundSubQueries([], 5), []);
  assert.equal(boundSubQueries(['a', 'b'], 0).length, 1);
});

// --- fusedConfidence / needsRefine: the confidence threshold ---

test('fusedConfidence is the distinct-hit count', () => {
  assert.equal(fusedConfidence([]), 0);
  assert.equal(fusedConfidence([hit('1', 'a'), hit('2', 'b')]), 2);
});

test('needsRefine: true when hits are below CONFIDENCE_THRESHOLD and a round remains', () => {
  const thin = Array.from({ length: CONFIDENCE_THRESHOLD - 1 }, (_, i) => hit(String(i), 't'));
  assert.equal(thin.length < CONFIDENCE_THRESHOLD, true, 'sanity: this pool IS thin');
  assert.equal(needsRefine(thin, 1, 2), true);
});

test('needsRefine: false once the pool meets CONFIDENCE_THRESHOLD', () => {
  const enough = Array.from({ length: CONFIDENCE_THRESHOLD }, (_, i) => hit(String(i), 't'));
  assert.equal(needsRefine(enough, 1, 2), false);
});

test('needsRefine: false once roundsUsed hits the cap, no matter how thin the pool still is (hard bound)', () => {
  assert.equal(needsRefine([], 2, 2), false, 'zero hits, but the round budget is already spent');
});

test('needsRefine: zero hits with rounds remaining is the clearest "refine" signal', () => {
  assert.equal(needsRefine([], 0, 2), true);
  assert.equal(needsRefine([], 1, 2), true);
});

// --- dedupeById ---

test('dedupeById: keeps the first occurrence of a repeated id (score-sorted input assumed)', () => {
  const hits = [hit('a', 'first'), hit('b', 'other'), hit('a', 'second (duplicate id)')];
  const out = dedupeById(hits);
  assert.equal(out.length, 2);
  assert.equal(out.find((h) => h.id === 'a')?.text, 'first');
});

test('dedupeById: falls back to a text-prefix key when a hit carries no id', () => {
  const hits: FusedHit[] = [
    { score: 1, source: 'a', text: 'identical passage text goes here' },
    { score: 0.9, source: 'b', text: 'identical passage text goes here' },
    { score: 0.8, source: 'c', text: 'a totally different passage' },
  ];
  const out = dedupeById(hits);
  assert.equal(out.length, 2, 'two id-less hits with the same text collapse to one');
});

test('dedupeById: an empty list stays empty', () => {
  assert.deepEqual(dedupeById([]), []);
});

// --- buildCitations ---

test('buildCitations: 1-based indices matching the [n] convention, path/id only when present', () => {
  const cites = buildCitations([hit('doc1', 'a', 'memory-exec'), { score: 0.1, source: 'legal-company', text: 'b', path: 'x/y.pdf' }]);
  assert.equal(cites[0]?.n, 1);
  assert.equal(cites[0]?.source, 'memory-exec');
  assert.equal(cites[0]?.id, 'doc1');
  assert.equal(cites[1]?.n, 2);
  assert.equal(cites[1]?.path, 'x/y.pdf');
});

test('buildCitations: an empty hit list yields an empty citation list', () => {
  assert.deepEqual(buildCitations([]), []);
});

// --- prompt builders: pure, but worth a cheap sanity check (allowed rooms / context actually land in the prompt) ---

test('buildPlanMessages carries the allowed rooms and the question into the user message', () => {
  const msgs = buildPlanMessages('what is the ASC key', ['memory-exec', 'legal-company']);
  const user = msgs.find((m) => m.role === 'user')!.content;
  assert.match(user, /memory-exec/);
  assert.match(user, /legal-company/);
  assert.match(user, /what is the ASC key/);
  // Published-string rule: no actual em dash (—) / en dash (–) CHARACTERS in the prompt --
  // the prompt legitimately instructs the model "do not use em dashes," which contains the
  // substring "em dash" as English text; what must be absent is the dash GLYPH itself.
  const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
  assert.ok(!/[—–]/.test(sys), 'the system prompt must not itself contain an em or en dash character');
});

test('buildSynthesisMessages numbers passages [1], [2], ... and includes their room as source', () => {
  const msgs = buildSynthesisMessages('q', [hit('1', 'first passage'), hit('2', 'second passage', 'legal-company')]);
  const user = msgs.find((m) => m.role === 'user')!.content;
  assert.match(user, /\[1\]/);
  assert.match(user, /\[2\]/);
  assert.match(user, /legal-company/);
});

// ============================================================================================
// integration-style: deepRetrieve() end to end, with fetch stubbed
// ============================================================================================

test('deepRetrieve: no rooms -> "no-rooms", no network calls at all', async () => {
  const res = await deepRetrieve('q', { rooms: [] });
  assert.equal(res.mode, 'no-rooms');
  assert.deepEqual(res.hits, []);
});

test('deepRetrieve: happy path — plans, searches, synthesizes a cited answer (round 1 is rich enough, no refine needed)', async () => {
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isChatUrl(u)) {
        const body = init?.body ? (JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }) : { messages: [] };
        const sys = body.messages[0]?.content ?? '';
        if (sys.includes('refining')) throw new Error('this happy path must not need the refine round (round 1 is rich)');
        if (sys.includes('retrieval query planner')) {
          return chatJson({ sub_queries: ['sub one', 'sub two'], rooms: ['memory-exec'] });
        }
        if (sys.includes('One Brain')) {
          return chatText('The ASC key id is 9MR7PJHRYH [1].');
        }
        throw new Error(`unexpected chat call, system prompt: ${sys.slice(0, 80)}`);
      }
      if (isSearchUrl(u)) {
        // 3 DISTINCT docs (>= CONFIDENCE_THRESHOLD) so round 1 is rich enough and refine never fires.
        return new Response(
          JSON.stringify({
            value: [
              { id: 'doc1', text: 'the ASC key id is 9MR7PJHRYH', '@search.rerankerScore': 3 },
              { id: 'doc2', text: 'a related fact', '@search.rerankerScore': 2.5 },
              { id: 'doc3', text: 'another related fact', '@search.rerankerScore': 2 },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await deepRetrieve('what is the ASC key id', { rooms: ['memory-exec', 'commons-company-journal'] });
      assert.equal(res.mode, 'deep-agentic');
      assert.equal(res.answer, 'The ASC key id is 9MR7PJHRYH [1].');
      assert.deepEqual(res.sub_queries, ['sub one', 'sub two']);
      assert.equal(res.rounds_used, 1);
      assert.ok(res.hits.length >= 1);
      assert.equal(res.citations.length, res.hits.length);
      assert.deepEqual(res.rooms_searched, ['memory-exec'], 'the plan narrowed to memory-exec only, and that narrowing was honored');
    },
  );
});

test('deepRetrieve SECURITY: the plan cannot escalate rooms beyond what the caller passed in', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isChatUrl(u)) return chatJson({ sub_queries: ['q'], rooms: ['legal-personal', 'memory-exec'] }); // legal-personal not permitted
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await deepRetrieve('q', { rooms: ['memory-exec'] }); // caller only permits memory-exec
      assert.ok(!res.rooms_searched.includes('legal-personal'), 'a room the plan invented must never actually be searched');
      assert.deepEqual(res.rooms_searched, ['memory-exec']);
    },
  );
});

test('deepRetrieve: thin round 1 triggers exactly ONE refine round, never more (rounds_used caps at 2)', async () => {
  let planCalls = 0;
  let refineCalls = 0;
  let round = 0;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isChatUrl(u)) {
        const body = init?.body ? (JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }) : { messages: [] };
        const sys = body.messages[0]?.content ?? '';
        if (sys.includes('refining')) {
          refineCalls++;
          return chatJson({ sub_queries: ['a broader reformulation'] });
        }
        if (sys.includes('retrieval query planner')) {
          planCalls++;
          return chatJson({ sub_queries: ['narrow query'] });
        }
        return chatText('synthesized answer [1]');
      }
      if (isSearchUrl(u)) {
        round++;
        // Round 1 (narrow query): thin -- 1 hit, below CONFIDENCE_THRESHOLD, should trigger refine.
        // Round 2 (broader reformulation): rich -- enough hits to satisfy the threshold.
        const value =
          round <= 1
            ? [{ id: 'doc1', text: 'one thin hit', '@search.rerankerScore': 1 }]
            : [
                { id: 'doc2', text: 'hit two', '@search.rerankerScore': 3 },
                { id: 'doc3', text: 'hit three', '@search.rerankerScore': 2.5 },
                { id: 'doc4', text: 'hit four', '@search.rerankerScore': 2 },
              ];
        return new Response(JSON.stringify({ value }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await deepRetrieve('q', { rooms: ['memory-exec'] });
      assert.equal(planCalls, 1, 'exactly one initial planning call');
      assert.equal(refineCalls, 1, 'exactly one refine call -- the bounded evaluate-refine round');
      assert.equal(res.rounds_used, 2, 'round 1 + the one refine round');
      assert.ok(res.sub_queries.includes('narrow query') && res.sub_queries.includes('a broader reformulation'));
    },
  );
});

test('deepRetrieve: a rich round 1 (>= CONFIDENCE_THRESHOLD hits) skips the refine round entirely', async () => {
  let refineCalls = 0;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isChatUrl(u)) {
        const body = init?.body ? (JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }) : { messages: [] };
        const sys = body.messages[0]?.content ?? '';
        if (sys.includes('refining')) {
          refineCalls++;
          return chatJson({ sub_queries: [] });
        }
        if (sys.includes('retrieval query planner')) return chatJson({ sub_queries: ['q'] });
        return chatText('answer [1][2][3]');
      }
      if (isSearchUrl(u)) {
        return new Response(
          JSON.stringify({
            value: [
              { id: 'doc1', text: 'a', '@search.rerankerScore': 3 },
              { id: 'doc2', text: 'b', '@search.rerankerScore': 2.9 },
              { id: 'doc3', text: 'c', '@search.rerankerScore': 2.8 },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await deepRetrieve('q', { rooms: ['memory-exec'] });
      assert.equal(refineCalls, 0, 'a rich-enough round 1 must never spend the refine round');
      assert.equal(res.rounds_used, 1);
    },
  );
});

test('deepRetrieve FAIL-OPEN: Foundry unconfigured (plan/refine/synth all skip) still returns real search hits', async () => {
  // Reset the module's cached env by using a fresh process.env snapshot is not possible mid-process
  // (loadEnv caches), so instead simulate "Foundry down" by making every chat/embeddings call fail --
  // this exercises the SAME inline fail-open branches (chat() throwing) as an unconfigured Foundry
  // would via foundryConfigured() === false, without fighting the module-level env cache.
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u) || isChatUrl(u)) return new Response('service unavailable', { status: 503 });
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [{ id: 'doc1', text: 'a real hit', '@search.rerankerScore': 1 }] }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await deepRetrieve('q', { rooms: ['memory-exec'] });
      // Never throws, and still surfaces the passage that WAS retrieved even though every LLM step failed.
      assert.equal(res.mode, 'deep-agentic');
      assert.equal(res.answer, SYNTH_UNAVAILABLE_ANSWER);
      assert.equal(res.hits.length, 1);
      assert.equal(res.hits[0]?.text, 'a real hit');
    },
  );
});

test('deepRetrieve FAIL-OPEN: zero hits retrieved -> the "no context" answer, not a crash', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isChatUrl(u)) return chatJson({ sub_queries: ['q'] });
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await deepRetrieve('q', { rooms: ['memory-exec'] });
      assert.equal(res.answer, NO_CONTEXT_ANSWER);
      assert.deepEqual(res.hits, []);
    },
  );
});

test('deepRetrieve FAIL-OPEN: AI Search itself throwing (e.g. a real 500) on EVERY room degrades gracefully WITHIN deep mode (rooms_failed set, 0 hits, no throw) rather than needing the outer fallback', async () => {
  // A per-room/per-subquery hybridSearch rejection is absorbed by runRetrievalRound's own
  // Promise.allSettled (mirrors brain-search.ts's fast-path "one dead room must never blank the
  // brain" isolation) -- it degrades WITHIN the deep-agentic flow rather than propagating up to
  // deepRetrieve's outer try/catch. That outer catch (-> fallbackFastSearch, see the tests below)
  // is reserved for a genuinely unexpected error, not an ordinary upstream outage.
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isChatUrl(u)) return chatJson({ sub_queries: ['q'] });
      if (isSearchUrl(u)) return new Response('internal error', { status: 500 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await deepRetrieve('q', { rooms: ['memory-exec'] });
      assert.equal(res.mode, 'deep-agentic', 'a room-level outage stays inside the agentic flow, it does not need the outer fallback');
      assert.deepEqual(res.hits, []);
      assert.equal(res.answer, NO_CONTEXT_ANSWER);
      // rooms_failed entries now carry the failure REASON ("room: why") so agents can distinguish
      // quota vs auth vs missing-index without gateway logs.
      assert.equal(res.rooms_failed?.length, 1);
      assert.match(res.rooms_failed![0]!, /^memory-exec: /);
      assert.deepEqual(res.rooms_searched, []);
    },
  );
});

// --- fallbackFastSearch: the outer-catch destination directly (see deepRetrieve's own header for
// why the FULL agentic flow is hard to force into this path from the outside -- every inner step is
// already individually fail-open, so this is deliberately last-resort, defense-in-depth). Exported
// as a test seam so its own two layers (the normal fast-path shape, and its OWN inner try/catch for
// a truly unreachable AI Search) are both directly verifiable. ---

test('fallbackFastSearch: exactly the brain_search fast-path shape, no LLM call involved', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isSearchUrl(u)) {
        return new Response(JSON.stringify({ value: [{ id: 'doc1', text: 'a hit', '@search.rerankerScore': 1 }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u} (the fallback must never call an embeddings/chat endpoint)`);
    }) as typeof fetch,
    async () => {
      const res = await fallbackFastSearch('q', ['memory-exec'], 8, false);
      assert.equal(res.mode, 'deep-fallback-fast');
      assert.equal(res.rounds_used, 0);
      assert.deepEqual(res.sub_queries, ['q']);
      assert.equal(res.answer, SYNTH_UNAVAILABLE_ANSWER);
      assert.equal(res.hits.length, 1);
      assert.equal(res.citations.length, 1);
    },
  );
});

test('fallbackFastSearch: even AI Search itself failing resolves to a valid EMPTY result, never throws (the absolute last resort)', async () => {
  await withStubbedFetch((async () => new Response('internal error', { status: 500 })) as typeof fetch, async () => {
    const res = await fallbackFastSearch('q', ['memory-exec'], 8, false);
    assert.equal(res.mode, 'deep-fallback-fast');
    assert.deepEqual(res.hits, []);
    assert.deepEqual(res.citations, []);
  });
});
