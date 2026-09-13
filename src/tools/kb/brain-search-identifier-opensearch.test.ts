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
