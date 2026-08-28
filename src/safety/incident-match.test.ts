import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars, then configure both Foundry and Azure AI Search so
// matchIncident's real code paths (not an early "unconfigured" return) run. Mirrors
// src/azure/search.test.ts's preamble exactly -- this file exercises the same hybridSearch
// machinery one layer up, through incident-match.ts.
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
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';

const {
  INCIDENT_TYPES,
  DEFAULT_MIN_CONFIDENCE,
  agentFromId,
  buildTypeInFilterClause,
  pickBestIncident,
  matchIncident,
  parseIncidentMatchMode,
  shouldSurfaceIncident,
  evaluateIncidentMatch,
  __resetIncidentMatchState,
} = await import('./incident-match.js');

// Pure network mocking via globalThis.fetch (the same seam src/azure/search.test.ts and
// src/util/fetch-budget.test.ts use, since node:test's mock.method() cannot redefine another
// module's live named export in this repo's ESM build).
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
function isSearchUrl(url: string): boolean {
  return url.includes('/indexes/') && url.includes('/docs/search');
}
function embeddingsOk(): Response {
  return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
}

// A real, ledgered pitfall (verbatim from safety/jit-doctrine.ts's JIT_DOCTRINE_BINDINGS) so this
// suite exercises the tool against realistic fleet vocabulary, not synthetic filler text.
const REAL_PITFALL_TEXT =
  'gpt-4.1-mini is banned for quality summarization; it degrades output. Use gpt-4o or the standard tier for summarization-quality-sensitive work.';

// ---- parseIncidentMatchMode (pure) -----------------------------------------------------------

test('parseIncidentMatchMode: valid modes pass through, case-insensitive and trimmed', () => {
  assert.equal(parseIncidentMatchMode('off'), 'off');
  assert.equal(parseIncidentMatchMode('OFF'), 'off');
  assert.equal(parseIncidentMatchMode('  on  '), 'on');
  assert.equal(parseIncidentMatchMode('ON'), 'on');
});

test('parseIncidentMatchMode: unset or garbage defaults to on (fail-open toward availability)', () => {
  assert.equal(parseIncidentMatchMode(undefined), 'on');
  assert.equal(parseIncidentMatchMode(''), 'on');
  assert.equal(parseIncidentMatchMode('banana'), 'on');
  assert.equal(parseIncidentMatchMode('enforce'), 'on', 'incident-match has no enforce mode; garbage falls back to on');
});

// ---- agentFromId (pure) -----------------------------------------------------------------------

test('agentFromId: parses the {agent}__{entryId} doc id convention', () => {
  assert.equal(agentFromId('cto__20260714-024'), 'cto');
  assert.equal(agentFromId('developer__abc123'), 'developer');
});

test('agentFromId: undefined/empty/malformed ids return undefined, never throw', () => {
  assert.equal(agentFromId(undefined), undefined);
  assert.equal(agentFromId(''), undefined);
  assert.equal(agentFromId('no-double-underscore-here'), undefined);
  assert.equal(agentFromId('__leading-only'), undefined, 'a leading __ has no agent segment before it (index 0, not > 0)');
});

// ---- buildTypeInFilterClause (pure) ------------------------------------------------------------

test('buildTypeInFilterClause: builds an OR-joined OData clause for the incident types', () => {
  assert.equal(buildTypeInFilterClause(INCIDENT_TYPES), "type eq 'pitfall' or type eq 'correction'");
});

test('buildTypeInFilterClause: supports a custom field name', () => {
  assert.equal(buildTypeInFilterClause(['a', 'b'], 'kind'), "kind eq 'a' or kind eq 'b'");
});

test('buildTypeInFilterClause: escapes single quotes per OData convention', () => {
  assert.equal(buildTypeInFilterClause(["o'brien"]), "type eq 'o''brien'");
});

test('buildTypeInFilterClause: empty type list yields an empty string, never throws', () => {
  assert.equal(buildTypeInFilterClause([]), '');
});

// ---- pickBestIncident (pure decision core) -----------------------------------------------------

test('pickBestIncident: empty hits array returns null', () => {
  assert.equal(pickBestIncident([]), null);
});

test('pickBestIncident: a single hit above the default threshold is returned with full shape', () => {
  const out = pickBestIncident([
    { score: 2.7, text: REAL_PITFALL_TEXT, id: 'cto__20260714-024', type: 'pitfall' },
  ]);
  assert.ok(out);
  assert.equal(out!.text, REAL_PITFALL_TEXT);
  assert.equal(out!.type, 'pitfall');
  assert.equal(out!.score, 2.7);
  assert.equal(out!.id, 'cto__20260714-024');
  assert.equal(out!.agent, 'cto', 'agent is derived from the id');
});

test('pickBestIncident: a single hit below the default threshold returns null', () => {
  const out = pickBestIncident([{ score: 0.4, text: 'unrelated chatter', id: 'x__1', type: 'pitfall' }]);
  assert.equal(out, null);
});

test('pickBestIncident: a score exactly AT the threshold counts as a match (inclusive)', () => {
  const out = pickBestIncident(
    [{ score: DEFAULT_MIN_CONFIDENCE, text: 'right at the line', id: 'x__1' }],
    DEFAULT_MIN_CONFIDENCE,
  );
  assert.ok(out, 'score === threshold must match, not just score > threshold');
});

test('pickBestIncident: a score just below a custom threshold returns null', () => {
  const out = pickBestIncident([{ score: 1.49, text: 'almost', id: 'x__1' }], 1.5);
  assert.equal(out, null);
});

test('pickBestIncident: with multiple hits, picks the highest-scoring one', () => {
  const out = pickBestIncident([
    { score: 1.8, text: 'lower score correction', id: 'a__1', type: 'correction' },
    { score: 3.2, text: 'highest score pitfall', id: 'b__2', type: 'pitfall' },
    { score: 2.1, text: 'middle score', id: 'c__3', type: 'pitfall' },
  ]);
  assert.ok(out);
  assert.equal(out!.text, 'highest score pitfall');
  assert.equal(out!.score, 3.2);
});

test('pickBestIncident: hits with a missing or non-finite score are never eligible to be "best"', () => {
  const out = pickBestIncident([
    { score: undefined, text: 'no score at all', id: 'a__1' },
    { score: Number.NaN, text: 'NaN score', id: 'b__2' },
    { score: 1.9, text: 'the only real score', id: 'c__3' },
  ]);
  assert.ok(out);
  assert.equal(out!.text, 'the only real score');
});

test('pickBestIncident: if EVERY hit has a missing/non-finite score, returns null', () => {
  const out = pickBestIncident([
    { score: undefined, text: 'a', id: '1' },
    { score: Number.NaN, text: 'b', id: '2' },
  ]);
  assert.equal(out, null);
});

test('pickBestIncident: a numeric/non-string id is stringified; a missing id is undefined', () => {
  const withNumericId = pickBestIncident([{ score: 3, text: 'x', id: 42 as unknown }]);
  assert.equal(withNumericId!.id, '42');
  const withNoId = pickBestIncident([{ score: 3, text: 'x', id: undefined }]);
  assert.equal(withNoId!.id, undefined);
  assert.equal(withNoId!.agent, undefined);
});

test('pickBestIncident: carries `path` through when present (chunked-room citation parity)', () => {
  const out = pickBestIncident([{ score: 3, text: 'x', id: 'a__1', path: 'legal/contractA.pdf' }]);
  assert.equal(out!.path, 'legal/contractA.pdf');
});

test('pickBestIncident: never throws on garbage input', () => {
  assert.doesNotThrow(() => pickBestIncident([]));
  assert.doesNotThrow(() => pickBestIncident([{ score: undefined, text: '', id: undefined }]));
});

// ---- matchIncident (IO shell: embed + hybridSearch(memory-exec) + threshold) -------------------

test('matchIncident: empty/whitespace-only text returns null without any network call', async () => {
  let fetchCalled = false;
  await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      throw new Error('fetch must not be called for empty input');
    }) as typeof fetch,
    async () => {
      assert.equal(await matchIncident(''), null);
      assert.equal(await matchIncident('   '), null);
    },
  );
  assert.equal(fetchCalled, false);
});

test('matchIncident: a query resembling a real ledgered pitfall returns it with citation + score', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(
          JSON.stringify({
            value: [
              { id: 'cto__20260714-024', type: 'pitfall', text: REAL_PITFALL_TEXT, '@search.rerankerScore': 2.9 },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const out = await matchIncident('should I route this summarization job through gpt-4.1-mini');
      assert.ok(out, 'a real ledgered pitfall above threshold must be returned, not null');
      assert.equal(out!.text, REAL_PITFALL_TEXT);
      assert.equal(out!.type, 'pitfall');
      assert.equal(out!.score, 2.9);
      assert.equal(out!.id, 'cto__20260714-024', 'the memory-exec doc id is the citation');
      assert.equal(out!.agent, 'cto');
      // The query must be scoped server-side to pitfall/correction only.
      assert.equal(capturedBody?.filter, "type eq 'pitfall' or type eq 'correction'");
      assert.equal(capturedBody?.queryType, 'semantic');
    },
  );
});

test('matchIncident: unrelated text with only low-confidence hits returns null', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        return new Response(
          JSON.stringify({
            value: [{ id: 'x__1', type: 'pitfall', text: 'a barely-related tangent', '@search.rerankerScore': 0.6 }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const out = await matchIncident('what is the weather like on Mars');
      assert.equal(out, null, 'a low-confidence hit must not be surfaced as a match');
    },
  );
});

test('matchIncident: no hits at all returns null', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      assert.equal(await matchIncident('anything'), null);
    },
  );
});

test('FAIL-OPEN: matchIncident returns null (never throws/rejects) on a real search outage (persistent 500)', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response('internal error', { status: 500 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      await assert.doesNotReject(async () => {
        const out = await matchIncident('some situation');
        assert.equal(out, null);
      });
    },
  );
});

test('FAIL-OPEN: matchIncident returns null (never throws/rejects) when the network throws on every attempt', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) throw new TypeError('simulated total network outage');
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      await assert.doesNotReject(async () => {
        const out = await matchIncident('some other situation');
        assert.equal(out, null);
      });
    },
  );
});

test('matchIncident: a custom top/threshold option is honored', async () => {
  let capturedTop: unknown;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        const b = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        capturedTop = b.top;
        return new Response(JSON.stringify({ value: [{ id: 'a__1', text: 'x', '@search.rerankerScore': 5 }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const out = await matchIncident('q', { top: 3, threshold: 10 });
      assert.equal(capturedTop, 3);
      assert.equal(out, null, 'a threshold of 10 must reject a score of 5');
    },
  );
});

// ---- shouldSurfaceIncident (IO shell throttle) --------------------------------------------------

test('shouldSurfaceIncident: the first call for a (caller, incident) pair returns true', () => {
  __resetIncidentMatchState();
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), true);
});

test('shouldSurfaceIncident: a repeat call for the SAME (caller, incident) pair returns false', () => {
  __resetIncidentMatchState();
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), true);
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), false);
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), false, 'stays throttled on further repeats');
});

test('shouldSurfaceIncident: a different incident for the same caller is a fresh key', () => {
  __resetIncidentMatchState();
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), true);
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), false);
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-B'), true);
});

test('shouldSurfaceIncident: the same incident for a different caller is a fresh key', () => {
  __resetIncidentMatchState();
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), true);
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), false);
  assert.equal(shouldSurfaceIncident('caller-2', 'incident-A'), true);
});

test('shouldSurfaceIncident: __resetIncidentMatchState clears the throttle', () => {
  __resetIncidentMatchState();
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), true);
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), false);
  __resetIncidentMatchState();
  assert.equal(shouldSurfaceIncident('caller-1', 'incident-A'), true, 'reset forgets prior throttle state');
});

test('shouldSurfaceIncident: never throws, even on empty callerHash/incidentId', () => {
  __resetIncidentMatchState();
  assert.doesNotThrow(() => shouldSurfaceIncident('', undefined));
});

// ---- evaluateIncidentMatch (mode gate + throttle, the tool layer's entry point) -----------------

test('evaluateIncidentMatch: default mode (unset env) is on', async () => {
  __resetIncidentMatchState();
  const prev = process.env.INCIDENT_MATCH_MODE;
  delete process.env.INCIDENT_MATCH_MODE;
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const out = await evaluateIncidentMatch('caller-default', 'q');
      assert.equal(out.mode, 'on');
    },
  );
  if (prev !== undefined) process.env.INCIDENT_MATCH_MODE = prev;
});

test('INCIDENT_MATCH_MODE=off: evaluateIncidentMatch returns null with NO network call at all', async () => {
  __resetIncidentMatchState();
  const prev = process.env.INCIDENT_MATCH_MODE;
  process.env.INCIDENT_MATCH_MODE = 'off';
  let fetchCalled = false;
  await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      throw new Error('fetch must not be called when INCIDENT_MATCH_MODE=off');
    }) as typeof fetch,
    async () => {
      const out = await evaluateIncidentMatch('caller-off', 'a query that would otherwise match');
      assert.deepEqual(out, { match: null, mode: 'off' });
    },
  );
  assert.equal(fetchCalled, false, 'mode=off must short-circuit before any embed/search call');
  if (prev !== undefined) process.env.INCIDENT_MATCH_MODE = prev; else delete process.env.INCIDENT_MATCH_MODE;
});

test('evaluateIncidentMatch: a fresh match is returned with mode=on and no already_surfaced flag', async () => {
  __resetIncidentMatchState();
  const prev = process.env.INCIDENT_MATCH_MODE;
  process.env.INCIDENT_MATCH_MODE = 'on';
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        return new Response(
          JSON.stringify({ value: [{ id: 'cto__1', type: 'pitfall', text: REAL_PITFALL_TEXT, '@search.rerankerScore': 3.1 }] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const out = await evaluateIncidentMatch('caller-fresh', 'about to summarize with gpt-4.1-mini');
      assert.ok(out.match);
      assert.equal(out.match!.text, REAL_PITFALL_TEXT);
      assert.equal(out.mode, 'on');
      assert.equal(out.already_surfaced, undefined, 'a first surfacing carries no already_surfaced flag');
    },
  );
  if (prev !== undefined) process.env.INCIDENT_MATCH_MODE = prev; else delete process.env.INCIDENT_MATCH_MODE;
});

test('evaluateIncidentMatch: a REPEAT match for the same caller sets already_surfaced=true but STILL returns the match (never suppressed)', async () => {
  __resetIncidentMatchState();
  const prev = process.env.INCIDENT_MATCH_MODE;
  process.env.INCIDENT_MATCH_MODE = 'on';
  const stub = (async (url: string | URL) => {
    const u = String(url);
    if (isEmbeddingsUrl(u)) return embeddingsOk();
    if (isSearchUrl(u)) {
      return new Response(
        JSON.stringify({ value: [{ id: 'cto__repeat-1', type: 'correction', text: 'a corrected belief', '@search.rerankerScore': 2.5 }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;
  await withStubbedFetch(stub, async () => {
    const first = await evaluateIncidentMatch('caller-repeat', 'query one');
    assert.ok(first.match, 'sanity: the first call surfaces a match');
    assert.equal(first.already_surfaced, undefined);
    const second = await evaluateIncidentMatch('caller-repeat', 'query two (different text, same matched incident)');
    assert.ok(second.match, 'a THROTTLED repeat must still return the real match -- this is NOT jit-doctrine style suppression');
    assert.equal(second.match!.id, 'cto__repeat-1');
    assert.equal(second.already_surfaced, true);
  });
  if (prev !== undefined) process.env.INCIDENT_MATCH_MODE = prev; else delete process.env.INCIDENT_MATCH_MODE;
});

test('evaluateIncidentMatch: the throttle is scoped per (caller, incident) -- a different caller is still fresh', async () => {
  __resetIncidentMatchState();
  const prev = process.env.INCIDENT_MATCH_MODE;
  process.env.INCIDENT_MATCH_MODE = 'on';
  const stub = (async (url: string | URL) => {
    const u = String(url);
    if (isEmbeddingsUrl(u)) return embeddingsOk();
    if (isSearchUrl(u)) {
      return new Response(
        JSON.stringify({ value: [{ id: 'cto__scoped-1', type: 'pitfall', text: 'x', '@search.rerankerScore': 3 }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;
  await withStubbedFetch(stub, async () => {
    const a1 = await evaluateIncidentMatch('caller-scoped-1', 'q');
    const a2 = await evaluateIncidentMatch('caller-scoped-1', 'q');
    const b1 = await evaluateIncidentMatch('caller-scoped-2', 'q');
    assert.equal(a1.already_surfaced, undefined);
    assert.equal(a2.already_surfaced, true);
    assert.equal(b1.already_surfaced, undefined, 'a different caller is unaffected by caller-scoped-1 having been throttled');
  });
  if (prev !== undefined) process.env.INCIDENT_MATCH_MODE = prev; else delete process.env.INCIDENT_MATCH_MODE;
});

test('FAIL-OPEN: evaluateIncidentMatch never throws on empty callerHash or text', async () => {
  __resetIncidentMatchState();
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      await assert.doesNotReject(() => evaluateIncidentMatch('', ''));
      await assert.doesNotReject(() => evaluateIncidentMatch('', 'some text'));
      await assert.doesNotReject(() => evaluateIncidentMatch('some-caller', ''));
    },
  );
});
