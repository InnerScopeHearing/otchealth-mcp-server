import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars, then configure BOTH the standard Foundry endpoint and the
// Azure Model Router endpoint with DISTINCT hosts, so a stubbed-fetch test can tell which one a
// call site actually asked for by inspecting the URL it hit. Mirrors src/memory/deep-retrieval.test.ts.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.FOUNDRY_ROUTER_ENDPOINT ||= 'https://otchealth-router.example.invalid';
process.env.FOUNDRY_ROUTER_KEY ||= 'test-router-key';

const { parseDistillResponse, distillSummary } = await import('./checkpoint.js');

// Pure network mocking via globalThis.fetch — the same seam src/memory/deep-retrieval.test.ts and
// src/memory/agentic.test.ts use.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('parseDistillResponse: parses a well-formed reply', () => {
  const out = parseDistillResponse(
    JSON.stringify({ memories: [{ kind: 'fact', text: 'ASC key id is 9MR7PJHRYH' }, { kind: 'decision', text: 'ship build 46' }] }),
  );
  assert.deepEqual(out, [
    { kind: 'fact', text: 'ASC key id is 9MR7PJHRYH' },
    { kind: 'decision', text: 'ship build 46' },
  ]);
});

test('parseDistillResponse: an empty memories array parses to an empty list', () => {
  assert.deepEqual(parseDistillResponse(JSON.stringify({ memories: [] })), []);
});

test('parseDistillResponse: caps at 3 items even if the model returns more', () => {
  const memories = Array.from({ length: 10 }, (_, i) => ({ kind: 'fact', text: `fact ${i}` }));
  const out = parseDistillResponse(JSON.stringify({ memories }));
  assert.equal(out.length, 3);
});

test('parseDistillResponse: drops items with an unrecognized kind', () => {
  const out = parseDistillResponse(
    JSON.stringify({ memories: [{ kind: 'status', text: 'chatter' }, { kind: 'fact', text: 'a real fact' }] }),
  );
  assert.deepEqual(out, [{ kind: 'fact', text: 'a real fact' }]);
});

test('parseDistillResponse: drops items with a missing/empty/non-string text', () => {
  const out = parseDistillResponse(
    JSON.stringify({
      memories: [
        { kind: 'fact', text: '' },
        { kind: 'fact' },
        { kind: 'fact', text: 42 },
        { kind: 'fact', text: '  ' },
        { kind: 'fact', text: 'kept' },
      ],
    }),
  );
  assert.deepEqual(out, [{ kind: 'fact', text: 'kept' }]);
});

test('parseDistillResponse: truncates an overlong text field', () => {
  const long = 'x'.repeat(3000);
  const out = parseDistillResponse(JSON.stringify({ memories: [{ kind: 'pitfall', text: long }] }));
  assert.equal(out.length, 1);
  assert.ok(out[0]!.text.length <= 2000);
});

test('parseDistillResponse: never throws on malformed JSON, missing memories key, or wrong types', () => {
  assert.deepEqual(parseDistillResponse('not json at all'), []);
  assert.deepEqual(parseDistillResponse('{}'), []);
  assert.deepEqual(parseDistillResponse(JSON.stringify({ memories: 'not an array' })), []);
  assert.deepEqual(parseDistillResponse(JSON.stringify({ memories: [null, 42, 'x'] })), []);
  assert.deepEqual(parseDistillResponse(''), []);
});

// ── distillSummary: the LLM call site itself now asks the router, not a hardcoded tier ────────────

function isChatUrl(url: string): boolean {
  return url.includes('/openai/deployments/') && url.includes('/chat/completions');
}

test('COST ROUTER: distillSummary asks the Azure Model Router, not a hardcoded standard/high tier', async () => {
  // Wave 6, item 6.3: this call site used to hardcode tier:'standard' (always the plain Foundry
  // chat endpoint). It now passes tier:'router', so a configured Model Router endpoint gets the
  // call instead of the standard deployment. Asserting on the ACTUAL fetch URL (not just the
  // options object) proves the router really is reached end to end through chat(), not merely
  // requested and ignored.
  let hitUrl: string | undefined;
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isChatUrl(u)) {
        hitUrl = u;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ memories: [{ kind: 'fact', text: 'routed via the model router' }] }) } }],
            model: 'model-router',
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const out = await distillSummary('Matt decided to ship build 46 today.');
      assert.deepEqual(out, [{ kind: 'fact', text: 'routed via the model router' }]);
    },
  );
  assert.ok(hitUrl, 'distillSummary must call the chat completions endpoint');
  assert.ok(
    hitUrl!.startsWith('https://otchealth-router.example.invalid/'),
    `expected the ROUTER endpoint to be hit, got: ${hitUrl}`,
  );
  assert.ok(
    !hitUrl!.includes('otchealth-foundry.example.invalid'),
    'must not fall back to the plain standard-tier Foundry endpoint when the router is configured',
  );
});
