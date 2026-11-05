import { test } from 'node:test';
import assert from 'node:assert/strict';

// SEARCH_BACKEND=opensearch, Azure vars UNSET (mirrors src/search/dispatch-opensearch.test.ts and
// semantic-opensearch.test.ts). Own file = own process under node:test's default per-file
// isolation. THIS is the file that proves the more severe half of the defect is closed:
// agentic.ts is memory_recall's FIRST-tier, highest-priority path (tried before ./semantic.ts on
// every call, via hot-cache.ts's cachedAgenticRecall). Before this fix it read
// process.env['AZURE_SEARCH_ENDPOINT'] directly (not even through loadEnv()) and issued its own
// bare, untimed fetch() -- with those variables unset (the state they will be in once Azure is
// genuinely retired) every sub-query search would have thrown/hung regardless of OpenSearch being
// fully configured and reachable, silently falling through to the slower tiers on every single
// recall.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.SEARCH_BACKEND = 'opensearch';
process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
delete process.env.AZURE_SEARCH_ENDPOINT;
delete process.env.AZURE_SEARCH_QUERY_KEY;

const { agenticRecall } = await import('./agentic.js');
const { filterCurrentRecallHits } = await import('../tools/memory/recall.js');
const { filterPersonalSharedMemory } = await import('../tools/memory/shared-memory-access.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('agenticRecall reaches the OpenSearch domain, not Azure, when SEARCH_BACKEND=opensearch', async () => {
  let openSearchHits = 0;
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/openai/deployments/') && u.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
      }
      if (u.startsWith('https://search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com/memory-exec/_search')) {
        openSearchHits++;
        return new Response(
          JSON.stringify({
            hits: { hits: [{ _id: 'cto__20260101-099', _score: 5.1, _source: { text: 'hello from opensearch (agentic)', type: 'decision' } }] },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch (agenticRecall should not reach a non-opensearch host when SEARCH_BACKEND=opensearch): ${u}`);
    }) as typeof fetch,
    async () => {
      const result = await agenticRecall('single query with no split delimiter');
      assert.equal(result.mode, 'agentic-hybrid', 'must not report unconfigured -- OpenSearch IS configured');
      assert.ok(openSearchHits > 0, 'at least one sub-query search must land on the OpenSearch domain host');
      assert.ok(result.results.length > 0);
      assert.equal(result.results[0]!.text, 'hello from opensearch (agentic)');
      assert.equal(result.results[0]!.agent, 'cto', 'agent recovery from the doc-id prefix must work on the OpenSearch path too');
    },
  );
});

test('agentic recall preserves legacy source owners for retraction and personal-lane filtering', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/openai/deployments/') && u.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
      }
      if (u.includes('/memory-exec/_search')) {
        return new Response(JSON.stringify({ hits: { hits: [
          { _id: 'legacy-1', _score: 3, _source: { id: '20261001-013', agent: 'cto', text: 'retired test record' } },
          { _id: 'legacy-2', _score: 2, _source: { id: '20261001-014', agent: 'clo-personal', text: 'synthetic protected record' } },
          { _id: 'legacy-3', _score: 1, _source: { id: 'cro__20261001-015', agent: 'cto', text: 'conflicting synthetic owner' } },
          { _id: 'legacy-4', _score: 1, _source: { id: 'cro__20261001-016', agent: 'clo-personal', text: 'synthetic protected conflict' } },
          { _id: 'legacy-5', _score: 1, _source: { id: '20261001-017', text: 'synthetic unknown owner' } },
          { _id: 'legacy-6', _score: 1, _source: { id: '20261001-013', agent: 'cfo', text: 'synthetic same-id other-lane record' } },
        ] } }), { status: 200 });
      }
      throw new Error(`unexpected synthetic fetch: ${u}`);
    }) as typeof fetch,
    async () => {
      const result = await agenticRecall('legacy owner metadata case', { top: 10 });
      const byIdentity = new Map(result.results.map((hit) => [`${hit.agent}|${hit.id}`, hit]));
      assert.ok(byIdentity.has('cto|20261001-013'));
      assert.ok(byIdentity.has('cfo|20261001-013'), 'a same-ID record from another lane stays distinct');
      assert.ok(byIdentity.has('clo-personal|20261001-014'));
      assert.ok(byIdentity.has('cro|cro__20261001-015'), 'a qualified ID retains precedence');
      assert.ok(byIdentity.has('clo-personal|cro__20261001-016'), 'a protected source label wins a conflict');
      assert.ok(byIdentity.has('|20261001-017'), 'missing identity is not guessed');
      const current = filterCurrentRecallHits(result.results, new Map([['cto', new Set(['20261001-013'])]]));
      assert.equal(current.some((hit) => hit.agent === 'cto' && hit.id === '20261001-013'), false);
      assert.equal(current.some((hit) => hit.agent === 'cfo' && hit.id === '20261001-013'), true);
      assert.equal(filterPersonalSharedMemory([byIdentity.get('clo-personal|20261001-014')!], 'cto').length, 0);
      assert.equal(filterPersonalSharedMemory([byIdentity.get('clo-personal|cro__20261001-016')!], 'cto').length, 0);
    },
  );
});

test('agent-filtered recall does not let other lanes crowd out the requested lane', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/openai/deployments/') && u.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
      }
      if (u.includes('/memory-exec/_search')) {
        const otherLanes = Array.from({ length: 8 }, (_, i) => ({
          _id: `legacy-other-${i}`,
          _score: 20 - i,
          _source: { id: '20261001-013', agent: `lane-${i}`, text: 'synthetic other-lane record' },
        }));
        return new Response(JSON.stringify({ hits: { hits: [
          ...otherLanes,
          { _id: 'legacy-requested', _score: 1, _source: { id: '20261001-099', agent: 'cto', text: 'synthetic requested record' } },
        ] } }), { status: 200 });
      }
      throw new Error(`unexpected synthetic fetch: ${u}`);
    }) as typeof fetch,
    async () => {
      const result = await agenticRecall('legacy owner filtered case', { agent: 'cto', top: 12 });
      assert.deepEqual(result.results.map((hit) => [hit.id, hit.agent]), [['20261001-099', 'cto']]);
    },
  );
});
