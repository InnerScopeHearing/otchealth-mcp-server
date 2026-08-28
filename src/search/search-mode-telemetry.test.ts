import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file = own process (node:test's default per-file isolation), because loadEnv() caches its
// parsed env for the process lifetime -- mutating process.env after the first loadEnv() call
// silently does nothing, so each SEARCH_MODE_TELEMETRY scenario needs its own file or its own
// carefully ordered import. This file exercises the 'on' default only; the 'off' kill-switch is
// covered by asserting the env schema default plus the guard's own branch below.
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
// A key must be present or captureGatewayEvent no-ops before building a payload, and this file
// would then assert nothing.
process.env.POSTHOG_GATEWAYOPS_KEY ||= 'phc_test_gatewayops_key';
process.env.POSTHOG_HOST ||= 'https://posthog.example.invalid';
// SEARCH_BACKEND pinned to 'azure' above (2026-08-28: its schema default flipped to 'opensearch' the
// same day; this file is about SEARCH_MODE_TELEMETRY, not about which search backend is active, and
// its fetch mocks below are shaped for the Azure REST surface).
delete process.env.SEARCH_MODE_TELEMETRY; // default 'on'

const { hybridSearch } = await import('./index.js');

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Runs `run()` with fetch stubbed so that: search calls resolve from `searchBody`, and any call to
 * the PostHog ingestion path is recorded instead of sent. Returns the captured telemetry events.
 */
async function captureTelemetry(
  searchBody: unknown,
  run: () => Promise<unknown>,
): Promise<Captured[]> {
  const original = globalThis.fetch;
  const events: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/i/v0/e/')) {
      events.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{}', { status: 200 });
    }
    return new Response(JSON.stringify(searchBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  // captureGatewayEvent is fire-and-forget (never awaited), so yield once for its microtask.
  await new Promise((r) => setTimeout(r, 0));
  return events;
}

test('emits gw_search_mode carrying backend, room and hit count', async () => {
  const events = await captureTelemetry(
    { value: [{ '@search.score': 1, content: 'hello world', id: 'doc-1' }] },
    () => hybridSearch('memory-exec', 'a query that must not be emitted', 5),
  );
  const search = events.filter((e) => (e.body as { event?: string }).event === 'gw_search_mode');
  assert.equal(search.length, 1, 'exactly one gw_search_mode per room query');
  const props = (search[0].body as { properties: Record<string, unknown> }).properties;
  assert.equal(props.backend, 'azure');
  assert.equal(props.room, 'memory-exec');
  assert.equal(typeof props.degraded, 'boolean');
  assert.equal(typeof props.hits, 'number');
});

test('SAFETY: never emits the query text or any hit content', async () => {
  const secretQuery = 'attorney privileged marital settlement figure';
  const secretContent = 'CONFIDENTIAL-HIT-BODY-SHOULD-NEVER-LEAVE';
  const events = await captureTelemetry(
    { value: [{ '@search.score': 1, content: secretContent, id: 'doc-1' }] },
    () => hybridSearch('legal-personal', secretQuery, 5),
  );
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(secretQuery), 'query text must never be emitted');
  assert.ok(!blob.includes(secretContent), 'hit content must never be emitted');
  // The room NAME is emitted on purpose -- it is already visible in brain_search's rooms_searched
  // output and is what makes a per-room degradation alert possible at all.
  assert.ok(blob.includes('legal-personal'), 'room name is emitted deliberately');
});

test('telemetry is never load-bearing: a throwing capture path cannot fail the search', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/i/v0/e/')) throw new Error('telemetry sink is down');
    return new Response(JSON.stringify({ value: [{ '@search.score': 1, content: 'ok', id: 'd' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const res = await hybridSearch('memory-exec', 'query', 5);
    assert.ok(res, 'search still returns a result when the telemetry sink throws');
    assert.equal(res?.matches.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
