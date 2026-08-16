import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process: SEARCH_BACKEND=opensearch here, and loadEnv() caches per process.
// This file exercises THE scenario the telemetry exists for -- Azure Foundry (which still serves
// embeddings even after the OpenSearch cutover) is unreachable, so the vector half of the hybrid
// query cannot run. src/search/opensearch.ts catches that and continues keyword-only, by design.
// The search still SUCCEEDS and every health check stays green, which is exactly why the degraded
// flag has to come from telemetry rather than from an error path.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.POSTHOG_GATEWAYOPS_KEY ||= 'phc_test_gatewayops_key';
process.env.POSTHOG_HOST ||= 'https://posthog.example.invalid';
process.env.SEARCH_BACKEND = 'opensearch';
process.env.OPENSEARCH_ENDPOINT = 'search-test.us-east-1.es.amazonaws.com';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const { hybridSearch } = await import('./index.js');

const OS_HIT = {
  hits: { hits: [{ _id: 'd1', _score: 1.2, _source: { id: 'd1', text: 'a keyword match' } }] },
};

/** Stubs fetch so embeddings FAIL, OpenSearch succeeds, and telemetry is captured. */
async function run(embedFails: boolean): Promise<Array<Record<string, unknown>>> {
  const original = globalThis.fetch;
  const events: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/i/v0/e/')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      events.push(body);
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/embeddings')) {
      if (embedFails) throw new Error('Foundry unreachable');
      return new Response(JSON.stringify({ data: [{ embedding: new Array(3072).fill(0.01) }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(OS_HIT), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const res = await hybridSearch('memory-exec', 'query', 5);
    // The search MUST still succeed -- fail-open is the intended runtime behavior.
    assert.ok(res, 'search still returns results with embeddings down');
    assert.ok(res.matches.length > 0, 'keyword half still produced hits');
  } finally {
    globalThis.fetch = original;
  }
  await new Promise((r) => setTimeout(r, 0));
  return events;
}

function props(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const e = events.find((x) => (x as { event?: string }).event === 'gw_search_mode');
  assert.ok(e, 'a gw_search_mode event was emitted');
  return (e as { properties: Record<string, unknown> }).properties;
}

test('THE ALARM: embeddings down -> search still succeeds, but degraded=true is emitted', async () => {
  const p = props(await run(true));
  assert.equal(p.mode, 'keyword', 'adapter reports keyword-only when the vector half could not run');
  assert.equal(p.degraded, true, 'degraded flag is what a monitor alerts on');
  assert.equal(p.backend, 'opensearch');
});

test('CONTROL: embeddings healthy -> hybrid, degraded=false (so the alarm cannot false-positive)', async () => {
  const p = props(await run(false));
  assert.equal(p.mode, 'hybrid');
  assert.equal(p.degraded, false);
});
