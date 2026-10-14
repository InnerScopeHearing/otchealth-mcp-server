import assert from 'node:assert/strict';
import test from 'node:test';

for (const [key, value] of Object.entries({
  CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test', PERPLEXITY_CONNECTOR_TOKEN: 'x'.repeat(32),
  ADMIN_REVOKE_TOKEN: 'x'.repeat(32), N8N_WEBHOOK_SECRET: 'x'.repeat(32), OPENSEARCH_ENDPOINT: 'search.identifier.test.invalid',
  OPENSEARCH_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
})) process.env[key] ||= value;
process.env.SEARCH_BACKEND = 'opensearch';
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.LLM_PROVIDER ||= 'foundry';
process.env.EMBEDDINGS_PROVIDER ||= 'foundry';
process.env.WEB_SEARCH_PROVIDER ||= 'azure';
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://foundry.identifier.test.invalid';
process.env.FOUNDRY_KEY ||= 'test';

const { handleBrainSearch } = await import('./brain-search.js');

const exactKey = `cto__m_idem_${'a'.repeat(64)}`;
const bareExactKey = `m_idem_${'b'.repeat(64)}`;

test('brain_search resolves a bare native idempotency key only inside the authenticated caller lane', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url); seen.push(u);
    if (u.endsWith(`/memory-exec/_doc/cto__${bareExactKey}`)) return new Response(JSON.stringify({
      found: true, _source: { text: 'the exact native memory', type: 'fact' },
    }), { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    const result = await handleBrainSearch({ query: bareExactKey, top: 1, domain: 'exec' }, { callerAgent: 'cto' } as any, {
      lookupEntity: async () => null,
      retractedIdsByAgent: async () => new Map(),
    });
    const data = result.data as any;
    assert.equal(data.mode, 'direct-id');
    assert.equal(data.matches.length, 1);
    assert.equal(data.matches[0].id, `cto__${bareExactKey}`);
    assert.deepEqual(data.source_currentness, {
      contractVersion: 'source-currentness.query.v1', state: 'unknown',
      reasons: ['trusted_source_authority_unavailable'],
    });
    assert.deepEqual(seen, [`https://search.identifier.test.invalid/memory-exec/_doc/cto__${bareExactKey}`]);
  } finally { globalThis.fetch = original; }
});

test('brain_search does not guess a lane or semantically search when a bare native id has no caller identity', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('must not search without caller identity'); }) as typeof fetch;
  try {
    const result = await handleBrainSearch({ query: bareExactKey, top: 1 }, {} as any, {
      lookupEntity: async () => null,
      retractedIdsByAgent: async () => new Map(),
    });
    assert.equal((result.data as any).mode, 'exact-unavailable');
    assert.equal((result.data as any).count, 0);
    assert.match(result.summary, /authenticated caller lane is unavailable/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('brain_search keeps an exact m_idem miss in memory-exec and never substitutes a commons neighbor', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url); seen.push(u);
    if (u.endsWith(`/memory-exec/_doc/${exactKey}`)) return new Response(JSON.stringify({ found: false }), { status: 404 });
    if (u.includes('/commons-company-journal/_search')) {
      return new Response(JSON.stringify({ hits: { hits: [{ _id: 'neighbor', _score: 1, _source: { id: 'commons__neighbor', text: 'different record' } }] } }), { status: 200 });
    }
    if (u.includes('/embeddings')) return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    const result = await handleBrainSearch({ query: exactKey, top: 3 }, { callerAgent: 'cto' } as any, {
      lookupEntity: async () => null,
      retractedIdsByAgent: async () => new Map(),
    });
    const data = result.data as any;
    assert.equal(data.mode, 'exact-not-indexed');
    assert.deepEqual(data.matches, []);
    assert.equal(data.source_currentness, undefined, 'a missing exact ID receives no currentness claim');
    assert.equal(data.evidence_pack.reason, 'exact_id_not_indexed');
    assert.equal(data.evidence_pack.outcome, 'no_evidence');
    assert.equal(data.evidence_pack.sourceCurrentness, 'unknown');
    assert.equal(data.evidence_pack.coverage.expectedMatchCount, null);
    assert.deepEqual(data.rooms_searched, ['memory-exec']);
    assert.equal(seen.some((u) => u.includes('/commons-company-journal/_search')), false);
    assert.equal(seen.some((u) => u.includes('/embeddings')), false);
  } finally { globalThis.fetch = original; }
});

test('brain_search preserves exact denial instead of reporting an empty federated search', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url); seen.push(u);
    if (u.endsWith(`/memory-exec/_doc/${exactKey}`)) return new Response('forbidden', { status: 403 });
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    const result = await handleBrainSearch({ query: exactKey, top: 3, domain: 'exec' }, { callerAgent: 'cto' } as any, {
      lookupEntity: async () => null,
      retractedIdsByAgent: async () => new Map(),
    });
    const data = result.data as any;
    assert.equal(data.mode, 'exact-denied');
    assert.deepEqual(data.matches, []);
    assert.equal(data.source_currentness, undefined, 'a denied exact ID receives no currentness claim');
    assert.equal(data.evidence_pack.reason, 'exact_id_denied');
    assert.equal(data.evidence_pack.outcome, 'partial');
    assert.equal(data.evidence_pack.sourceCurrentness, 'unknown');
    assert.deepEqual(data.evidence_pack.coverage.roomsSearched, []);
    assert.deepEqual(data.evidence_pack.coverage.roomsFailed, ['memory-exec']);
    assert.deepEqual(data.rooms_searched, ['memory-exec']);
    assert.equal(seen.length, 1);
  } finally { globalThis.fetch = original; }
});

test('brain_search preserves exact unavailability without searching another room', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url); seen.push(u);
    if (u.endsWith(`/memory-exec/_doc/${exactKey}`)) return new Response('unavailable', { status: 503 });
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    const result = await handleBrainSearch({ query: exactKey, top: 3 }, { callerAgent: 'cto' } as any, {
      lookupEntity: async () => null,
      retractedIdsByAgent: async () => new Map(),
    });
    const data = result.data as any;
    assert.equal(data.mode, 'exact-unavailable');
    assert.deepEqual(data.matches, []);
    assert.equal(data.source_currentness, undefined, 'an unavailable exact ID receives no currentness claim');
    assert.equal(data.evidence_pack.reason, 'exact_id_unavailable');
    assert.equal(data.evidence_pack.outcome, 'partial');
    assert.equal(data.evidence_pack.sourceCurrentness, 'unknown');
    assert.deepEqual(data.evidence_pack.coverage.roomsSearched, []);
    assert.deepEqual(data.evidence_pack.coverage.roomsFailed, ['memory-exec']);
    assert.deepEqual(data.rooms_searched, ['memory-exec']);
    assert.equal(seen.length, 2, 'the existing bounded 5xx retry repeats only the exact GET');
    assert.ok(seen.every((u) => u.endsWith(`/memory-exec/_doc/${exactKey}`)));
  } finally { globalThis.fetch = original; }
});

test('brain_search marks exact IDs outside the selected domain as unchecked, not absent', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('must not search outside the selected domain'); }) as typeof fetch;
  try {
    const result = await handleBrainSearch({ query: exactKey, top: 3, domain: 'commons' }, { callerAgent: 'cto' } as any, {
      lookupEntity: async () => null,
      retractedIdsByAgent: async () => new Map(),
    });
    const data = result.data as any;
    assert.equal(data.mode, 'exact-unavailable');
    assert.equal(data.evidence_pack.reason, 'exact_id_not_checked');
    assert.equal(data.evidence_pack.outcome, 'partial');
    assert.equal(data.evidence_pack.coverage.expectedMatchCount, null);
    assert.deepEqual(data.evidence_pack.coverage.roomsSearched, []);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('brain_search keeps an exact hit canonical', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url); seen.push(u);
    if (u.endsWith(`/memory-exec/_doc/${exactKey}`)) return new Response(JSON.stringify({
      found: true, _source: { id: 'wrong__source-id', agent: 'cfo', type: 'fact', text: 'exact requested row' },
    }), { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    const result = await handleBrainSearch({ query: exactKey, top: 3 }, { callerAgent: 'cto' } as any, {
      lookupEntity: async () => null,
      retractedIdsByAgent: async () => new Map(),
    });
    const data = result.data as any;
    assert.equal(data.mode, 'direct-id');
    assert.equal(data.matches.length, 1);
    assert.equal(data.matches[0].id, exactKey);
    assert.deepEqual(data.source_currentness, {
      contractVersion: 'source-currentness.query.v1',
      state: 'unknown',
      reasons: ['trusted_source_authority_unavailable'],
    });
    assert.deepEqual(data.rooms_searched, ['memory-exec']);
    assert.equal(seen.length, 1);
  } finally { globalThis.fetch = original; }
});

test('brain_search withholds an exact hit retracted in its owning lane', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith(`/memory-exec/_doc/${exactKey}`)) return new Response(JSON.stringify({
      found: true, _source: { id: exactKey, type: 'fact', text: 'superseded row' },
    }), { status: 200 });
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;
  try {
    const entryId = exactKey.slice(exactKey.indexOf('__') + 2);
    const result = await handleBrainSearch({ query: exactKey, top: 3 }, { callerAgent: 'cto' } as any, {
      lookupEntity: async () => null,
      retractedIdsByAgent: async () => new Map([['cto', new Set([entryId])]]),
    });
    const data = result.data as any;
    assert.equal(data.mode, 'exact-superseded');
    assert.deepEqual(data.matches, []);
    assert.deepEqual(data.retracted_dropped, [exactKey]);
  } finally { globalThis.fetch = original; }
});

test('brain_search promotes an authorized full-text opaque identifier before federation trim', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [], token = 'MXVEDTUKA2', longText = `${'x'.repeat(1400)} ${token} ${'y'.repeat(1400)}`;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url); seen.push(u);
    if (u.includes('/embeddings')) return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    if (u.includes('search.identifier.test.invalid')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const memory = u.includes('/memory-exec/_search');
      const vector = Boolean(body.query?.knn);
      const hits = memory
        ? vector
          ? [{ _id: 'semantic', _score: 1, _source: { id: 'cto__semantic', text: 'semantic distractor', type: 'fact' } }]
          : [
              { _id: 'semantic', _score: 2, _source: { id: 'cto__semantic', text: 'semantic distractor', type: 'fact' } },
              { _id: 'literal', _score: 1, _source: { id: 'cto__literal', text: longText, type: 'status', agent: 'cto' } },
            ]
        : [{ _id: 'commons', _score: 1, _source: { id: 'commons__1', text: 'other room distractor' } }];
      return new Response(JSON.stringify({ hits: { hits } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    const result = await handleBrainSearch({ query: token, top: 3, include_ops: false }, { callerAgent: 'cto' } as any);
    const data = result.data as any;
    assert.equal(data.mode, 'identifier-match');
    assert.equal(data.matches[0].id, 'cto__literal');
    assert.match(data.matches[0].text, new RegExp(token));
    assert.ok(seen.some((url) => url.includes('/memory-exec/_search')));
    assert.ok(seen.some((url) => url.includes('/commons-company-journal/_search')));
    assert.equal(seen.some((url) => /finance|legal-personal|legal-company/.test(url)), false);
  } finally { globalThis.fetch = original; }
});
