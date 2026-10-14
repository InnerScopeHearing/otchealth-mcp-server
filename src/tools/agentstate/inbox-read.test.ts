import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requestContext } from '../../server/request-context.js';

process.env.CIO_SITE_ID ??= 'test';
process.env.CIO_TRACK_KEY ??= 'test';
process.env.CIO_APP_API_BEARER ??= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
process.env.STATE_BACKEND = 'cosmos';
process.env.AGENT_INBOX_STORAGE_ACCOUNT = 'testaccount';
process.env.AGENT_INBOX_STORAGE_KEY = Buffer.alloc(32).toString('base64');

const { registerInboxRead } = await import('./inbox-read.js');
const TARGET = '00000000-0000-4000-8000-000000000000';

function queue(overrides: Partial<{
  isConfigured: () => boolean;
  supportsExactAcknowledgment: () => boolean;
  acknowledgeMessage: (agent: string, id: string) => Promise<boolean>;
  readMessages: (agent: string, opts: Record<string, unknown>) => Promise<never[]>;
}> = {}) {
  const calls: { ack: unknown[][]; read: unknown[][] } = { ack: [], read: [] };
  return {
    calls,
    deps: {
      isConfigured: () => true,
      supportsExactAcknowledgment: () => true,
      acknowledgeMessage: async (...args: [string, string]) => { calls.ack.push(args); return true; },
      readMessages: async (...args: [string, Record<string, unknown>]) => { calls.read.push(args); return []; },
      ...overrides,
    },
  };
}

async function invokeAs(handlers: Record<string, (args: unknown) => Promise<unknown>>, agent: string, args: unknown) {
  return requestContext.run({ callerAgent: agent, callerHash: `hash-${agent}`, correlationId: 'test', authKind: 'codex' },
    () => handlers.inbox_read!(args));
}

function fakeServer(): {
  server: McpServer;
  handlers: Record<string, (args: unknown) => Promise<unknown>>;
  configs: Record<string, { inputSchema: Record<string, { safeParse: (value: unknown) => { success: boolean } }> }>;
} {
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
  const configs: Record<string, { inputSchema: Record<string, { safeParse: (value: unknown) => { success: boolean } }> }> = {};
  const server = {
    registerTool: (name: string, config: typeof configs[string], handler: (args: unknown) => Promise<unknown>) => {
      configs[name] = config;
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  return { server, handlers, configs };
}

test('inbox_read keeps max bounded to 1..32 and exposes newest_first as optional boolean', () => {
  const { server, configs } = fakeServer();
  registerInboxRead(server, () => 'inbox-read-test');
  const shape = configs.inbox_read!.inputSchema;
  assert.equal(shape.max.safeParse(1).success, true);
  assert.equal(shape.max.safeParse(32).success, true);
  assert.equal(shape.max.safeParse(0).success, false);
  assert.equal(shape.max.safeParse(33).success, false);
  assert.equal(shape.newest_first.safeParse(true).success, true);
  assert.equal(shape.newest_first.safeParse('true').success, false);
  assert.equal(shape.expected_message_id.safeParse('00000000-0000-4000-8000-000000000000').success, true);
  assert.equal(shape.expected_message_id.safeParse('not-an-id').success, false);
});

test('exact acknowledgment rejects a forged recipient before touching the queue', async () => {
  const { server, handlers } = fakeServer();
  const q = queue();
  registerInboxRead(server, () => 'inbox-read-test', q.deps);
  const result = await invokeAs(handlers, 'developer', { agent: 'cto', expected_message_id: TARGET });
  assert.equal((result as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(result), /authenticated caller/);
  assert.deepEqual(q.calls, { ack: [], read: [] });
});

test('exact acknowledgment succeeds for authenticated own inbox and never falls back to a drain', async () => {
  const { server, handlers } = fakeServer();
  const q = queue();
  registerInboxRead(server, () => 'inbox-read-test', q.deps);
  const result = await invokeAs(handlers, 'developer', { agent: 'developer', expected_message_id: TARGET }) as { structuredContent: { result: { acknowledged: boolean; message_id: string } } };
  assert.equal(result.structuredContent.result.acknowledged, true);
  assert.equal(result.structuredContent.result.message_id, TARGET);
  assert.deepEqual(q.calls.ack, [['developer', TARGET]]);
  assert.deepEqual(q.calls.read, []);
});

test('exact miss, unconfigured backend, unsupported backend, modifiers, and storage errors stay explicit and never drain', async () => {
  const { server, handlers } = fakeServer();
  // A dedicated counter keeps each branch's effect observable.
  let ackCalls = 0;
  let readCalls = 0;
  const base = queue();
  const deps = {
    ...base.deps,
    acknowledgeMessage: async () => { ackCalls++; return false; },
    readMessages: async () => { readCalls++; return []; },
  };
  registerInboxRead(server, () => 'inbox-read-test', deps);
  const miss = await invokeAs(handlers, 'developer', { agent: 'developer', expected_message_id: TARGET }) as { structuredContent: { result: { outcome: string } } };
  assert.equal(miss.structuredContent.result.outcome, 'not_acknowledged');
  assert.equal(ackCalls, 1);
  assert.equal(readCalls, 0);
  for (const modifier of [{ ack: false }, { newest_first: false }, { dead_letter: false }, { max: 1 }]) {
    const wrongMode = await invokeAs(handlers, 'developer', { agent: 'developer', expected_message_id: TARGET, ...modifier });
    assert.equal((wrongMode as { isError: boolean }).isError, true, 'any provided mode modifier is rejected, including false');
  }
  assert.equal(ackCalls, 1);
  assert.equal(readCalls, 0);
});

test('exact acknowledgment reports unavailable, Azure unsupported, and unknown storage outcome without fallback', async () => {
  for (const [label, overrides, expected] of [
    ['unavailable', { isConfigured: () => false }, /unavailable/],
    ['azure', { supportsExactAcknowledgment: () => false }, /unsupported by the active Azure Queue backend/],
    ['storage error', { acknowledgeMessage: async () => { throw new Error('connection lost'); } }, /connection lost/],
  ] as const) {
    const { server, handlers } = fakeServer();
    let reads = 0;
    let acks = 0;
    const base = queue();
    const deps = {
      ...base.deps,
      ...overrides,
      acknowledgeMessage: async (...args: [string, string]) => {
        acks++;
        if (overrides.acknowledgeMessage) return overrides.acknowledgeMessage(...args);
        return true;
      },
      readMessages: async () => { reads++; return []; },
    };
    registerInboxRead(server, () => 'inbox-read-test', deps);
    const result = await invokeAs(handlers, 'developer', { agent: 'developer', expected_message_id: TARGET });
    assert.match(JSON.stringify(result), expected, label);
    assert.equal(reads, 0, `${label} must not fall back to reading/draining`);
    if (label === 'unavailable' || label === 'azure') assert.equal(acks, 0);
    else assert.equal(acks, 1, 'a lost response is one unknown attempt, not a retry');
  }
});

test('newest_first rejects drains and identifies Azure backend as unsupported', async () => {
  const { server, handlers } = fakeServer();
  registerInboxRead(server, () => 'inbox-read-test');

  const drain = await handlers.inbox_read!({ agent: 'developer', newest_first: true });
  assert.equal((drain as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(drain), /only for live read-only peeks/);

  const azurePeek = await handlers.inbox_read!({ agent: 'developer', ack: false, newest_first: true });
  assert.equal((azurePeek as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(azurePeek), /unsupported by the active Azure Queue backend/);
});

test('over-limit inbox_read requests fail validation before touching the queue', async () => {
  const { server, handlers } = fakeServer();
  registerInboxRead(server, () => 'inbox-read-test');
  const result = await handlers.inbox_read!({ agent: 'developer', max: 33 });
  assert.equal((result as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(result), /Invalid input/);
});
