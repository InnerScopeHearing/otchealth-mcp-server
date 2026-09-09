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
process.env.FOUNDRY_ROUTER_ENDPOINT ||= 'https://otchealth-router.example.invalid';
process.env.FOUNDRY_ROUTER_KEY ||= 'test-router-key';

const { parseDistillResponse, distillSummary, registerCheckpoint } = await import('./checkpoint.js');

test('actual checkpoint handler preserves partial IDs and resets pressure only for complete delivery', async () => {
  for (const mode of ['stored-unindexed', 'storage-unknown', 'complete'] as const) {
    let handler: import('../registry.js').ToolHandler<never> | undefined;
    let writes = 0, resets = 0;
    registerCheckpoint({} as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, () => 'fixture', {
      register: (_server, definition) => { handler = definition.handler; },
      configured: () => true,
      reset: () => { resets++; },
      deliver: async () => {
        writes++;
        if (writes === 1 && mode === 'storage-unknown') return {id:null,stored:false,indexed:false};
        return {id: writes === 1 ? 'explicit' : 'episode',stored:true,indexed:writes !== 1 || mode === 'complete'};
      },
    });
    assert.ok(handler);
    const result = await handler({agent:'cto',memories:[{kind:'fact',text:'Synthetic checkpoint fixture'}]} as never,
      {callerHash:'fixture',callerAgent:'cto',correlationId:'fixture',dryRun:false,acknowledgeWarning:false});
    const data = result.data as {written:string[];unindexed:string[];storage_unconfirmed:number;checkpoint:boolean};
    assert.equal(writes, 2);
    assert.equal(resets, mode === 'complete' ? 1 : 0);
    assert.equal(data.checkpoint, mode === 'complete');
    assert.deepEqual(data.written, mode === 'storage-unknown' ? ['episode'] : ['explicit','episode']);
    assert.deepEqual(data.unindexed, mode === 'stored-unindexed' ? ['explicit'] : []);
    assert.equal(data.storage_unconfirmed, mode === 'storage-unknown' ? 1 : 0);
    assert.match(result.summary ?? '', mode === 'complete' ? /Capture pressure reset/ : /capture pressure retained/);
  }
});

// Pure network mocking via globalThis.fetch, the same seam src/memory/deep-retrieval.test.ts and
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

test('distillation distinguishes valid empty output from malformed or dropped memories', async () => {
  for (const raw of ['broken', '{}', '{"memories":{}}', '{"memories":[{"kind":"unknown","text":"fixture"}]}']) {
    await withStubbedFetch(async () => new Response(JSON.stringify({choices:[{message:{content:raw}}]})),
      () => assert.rejects(distillSummary('Synthetic summary'), /checkpoint_distillation_invalid/));
  }
  await withStubbedFetch(async () => new Response(JSON.stringify({choices:[{message:{content:'{"memories":[]}'}}]})),
    async () => assert.deepEqual(await distillSummary('Synthetic summary'), []));
});

test('actual checkpoint handler retains pressure on malformed distillation while preserving explicit writes', async () => {
  let handler: import('../registry.js').ToolHandler<never> | undefined;
  let resets = 0, writes = 0;
  registerCheckpoint({} as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, () => 'fixture', {
    register: (_server, definition) => { handler = definition.handler; }, configured: () => true,
    reset: () => { resets++; }, deliver: async () => ({id:`saved-${++writes}`,stored:true,indexed:true}),
  });
  await withStubbedFetch(async () => new Response(JSON.stringify({choices:[{message:{content:'invalid'}}]})), async () => {
    assert.ok(handler);
    const result = await handler({agent:'cto',summary:'Synthetic summary',memories:[{kind:'fact',text:'Synthetic explicit memory'}]} as never,
      {callerHash:'fixture',callerAgent:'cto',correlationId:'fixture',dryRun:false,acknowledgeWarning:false});
    const data = result.data as {checkpoint:boolean;distillation_complete:boolean;written:string[]};
    assert.equal(data.checkpoint,false);assert.equal(data.distillation_complete,false);
    assert.deepEqual(data.written,['saved-1','saved-2']);assert.equal(resets,0);
  });
});

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
