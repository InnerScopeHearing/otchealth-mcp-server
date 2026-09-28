import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars and explicitly select the supported OpenAI path. Synthetic
// model names plus a local fetch stub make the cost-routing assertion deterministic without
// contacting any provider.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
// Pin synthetic configuration for this isolated process. Foundry and its router are retired.
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.SEARCH_BACKEND ||= 'azure';
process.env.LLM_PROVIDER = 'openai';
process.env.EMBEDDINGS_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'synthetic-test-key';
process.env.OPENAI_CHAT_MODEL = 'gpt-5.6-terra';
process.env.OPENAI_HIGH_MODEL = 'gpt-5.6-sol';
process.env.OPENAI_ROUTER_MODEL = 'gpt-5.6-luna';
process.env.WEB_SEARCH_PROVIDER ||= 'azure';

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

// ── distillSummary: the LLM call site itself requests the cost-conscious router tier ──────────────

function isChatUrl(url: string): boolean {
  return url.includes('/chat/completions');
}

test('COST ROUTING: distillSummary uses the OpenAI router-tier model, not standard/high', async () => {
  // The retired Azure Model Router has no live route. distillSummary still requests tier:'router';
  // on the supported OpenAI path that resolves to gpt-5.6-luna. Inspect the actual request body
  // to prove the requested cost tier is used end to end, not merely passed as an option.
  let hitUrl: string | undefined;
  let hitModel: string | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isChatUrl(u)) {
        hitUrl = u;
        const body = init?.body ? JSON.parse(String(init.body)) as { model?: string } : {};
        hitModel = body.model;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ memories: [{ kind: 'fact', text: 'routed via the router tier' }] }) } }],
            model: 'gpt-5.6-luna',
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const out = await distillSummary('Matt decided to ship build 46 today.');
      assert.deepEqual(out, [{ kind: 'fact', text: 'routed via the router tier' }]);
    },
  );
  assert.ok(hitUrl, 'distillSummary must call the chat completions endpoint');
  assert.equal(hitUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(hitModel, 'gpt-5.6-luna', 'router tier must not collapse to the standard or high model');
});
