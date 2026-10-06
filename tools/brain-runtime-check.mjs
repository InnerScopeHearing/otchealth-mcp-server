// Source-free checks of compiled Brain modules. This runner accepts no source inputs,
// never loads credentials and replaces all provider I/O before invoking retrieval.
import assert from 'node:assert/strict';
Object.assign(process.env, {
  NODE_ENV: 'test', STATE_BACKEND: 'cosmos', BLOB_BACKEND: 'azure',
  SEARCH_BACKEND: 'azure', LLM_PROVIDER: 'openai', EMBEDDINGS_PROVIDER: 'openai',
  WEB_SEARCH_PROVIDER: 'azure', OPENAI_USAGE_DISABLE: '1',
  CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'x'.repeat(32), ADMIN_REVOKE_TOKEN: 'x'.repeat(32),
  N8N_WEBHOOK_SECRET: 'x'.repeat(32), OPENAI_API_KEY: 'synthetic-runtime-fixture',
  AZURE_SEARCH_ENDPOINT: 'https://synthetic-search.example.invalid',
  AZURE_SEARCH_QUERY_KEY: 'synthetic-runtime-fixture',
});
assert.match(process.env.GIT_SHA ?? '', /^[a-f0-9]{40}$/i, 'image must carry its exact source commit');
const { dedupeById, buildCitations, deepStageTimingFields, deepRetrieve, PARTIAL_BUDGET_ANSWER } = await import('../dist/memory/deep-retrieval.js');
const hits = [
  { score: 1, source: 'synthetic-room-a', id: 'same', agent: 'coo', text: 'synthetic-A', source_version: 'v1' },
  { score: 0.9, source: 'synthetic-room-a', id: 'same', agent: 'coo', text: 'synthetic-B', source_version: 'v2' },
  { score: 0.8, source: 'synthetic-room-b', id: 'same', agent: 'coo', text: 'synthetic-C', source_version: 'v1' },
];
assert.deepEqual(dedupeById([...hits, hits[0]]), hits);
assert.deepEqual(buildCitations(hits).map(c => [c.source, c.source_version]), hits.map(h => [h.source, h.source_version]));
const timing = deepStageTimingFields('planning', 10, 20, 'partial', 'synthetic-correlation', process.env.GIT_SHA);
assert.deepEqual(Object.keys(timing).sort(), ['correlation_id','duration_ms','outcome','release_id','stage','type']);
assert.equal(timing.duration_ms, 10); assert.equal(timing.release_id, process.env.GIT_SHA);
// Allow emulated ARM startup to reach the mock before expiry; this is a cancellation
// fixture, not a microsecond performance threshold. Production defaults are unchanged.
const originalFetch = globalThis.fetch;
let aborted = false, retrievalCalls = 0;
try {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/chat/completions')) return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"sub_queries":["synthetic"]}' } }] }))), 10_000);
      const abort = () => { clearTimeout(timer); aborted = true; reject(init.signal.reason); };
      if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
    });
    retrievalCalls++; throw new Error('Unexpected synthetic provider request');
  };
  const result = await deepRetrieve('synthetic-runtime-query', { rooms: ['memory-exec'], budgetMs: 2_000 });
  assert.equal(aborted, true); assert.equal(retrievalCalls, 0);
  assert.equal(result.partial, true); assert.equal(result.answer, PARTIAL_BUDGET_ANSWER);
  assert.deepEqual(result.hits, []); assert.deepEqual(result.citations, []);
  assert.deepEqual(result.continuation.rooms, ['memory-exec']);
} finally { globalThis.fetch = originalFetch; }
console.log(JSON.stringify({ status: 'pass', checks: 3, source_sha: process.env.GIT_SHA, provider_calls: 0, source_bodies: 0 }));
