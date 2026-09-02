import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAgentCoreBrowserBrokerTools } from './tools.js';
import type { AgentCoreBrowserTransport, InspectResult } from '../browser-agentcore/transport.js';
import { requestContext } from '../../server/request-context.js';

// FND-20260829-e454: browser_broker_inspect_public's max_seconds bound was 300 (default 300),
// and transport.ts's own setup-step timeouts (pre-fix) were independent of it entirely -- see
// transport.test.ts for the pure timeout-policy tests and tools.ts's own comment for the full
// worst-case-wall-time accounting. These tests cover the TOOL-LEVEL wiring: the tightened schema
// bound, and honest partial/skipped_targets surfacing when the (injectable) transport reports a
// bounded-deadline stop -- mirroring registry.m365-alias.test.ts's fakeServer() pattern, since
// this handler (like most in this repo) is defined inline in registerTool() rather than exported
// standalone.

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
  // agentCoreRuntimeConfig()/assertAgentCoreConfigured must pass for the handler to reach the
  // (fake) transport at all -- these are read fresh from process.env, values never dialed for real.
  process.env.ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY = 'true';
  process.env.AWS_AGENTCORE_ACCESS_KEY_ID = 'test-key-id';
  process.env.AWS_AGENTCORE_SECRET_ACCESS_KEY = 'test-secret';
});

/** Minimal fake McpServer capturing registered handlers, mirroring registry.m365-alias.test.ts's
 *  fakeServer(). */
function fakeServer(): { server: McpServer; handlers: Map<string, (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>> } {
  const handlers = new Map<string, (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>) => {
      handlers.set(name, handler);
      return { remove: () => handlers.delete(name) };
    },
  } as unknown as McpServer;
  return { server, handlers };
}

/** Runs fn inside a request context for `callerAgent` -- `cto` is enrolled for public_read with
 *  otchealth.app in its host allowlist (see enrollment.ts). */
function withCaller<T>(callerAgent: string, fn: () => T): T {
  return requestContext.run({ callerHash: 'test-hash', correlationId: 'test-corr', callerAgent }, fn);
}

function fakeTransport(inspect: (targets: URL[], maxSeconds: number) => Promise<InspectResult>): AgentCoreBrowserTransport {
  return { inspect };
}

test('browser_broker_inspect_public: max_seconds schema is tightened to 25 (was 300) -- values above it are rejected before the handler even runs', async () => {
  const { server, handlers } = fakeServer();
  registerAgentCoreBrowserBrokerTools(server, () => 'caller-hash', fakeTransport(async () => ({ receipts: [], partial: false })));
  const handler = handlers.get('browser_broker_inspect_public')!;
  const res = await withCaller('cto', () =>
    handler({ targets: ['https://otchealth.app/page'], max_seconds: 300 }),
  );
  const error = res.structuredContent?.error as { code?: string } | undefined;
  assert.equal(error?.code, 'invalid_input', 'a max_seconds above the new 25s cap must be rejected, not silently clamped');
});

test('browser_broker_inspect_public: a normal (non-partial) transport result carries no partial/skipped_targets fields, and passes the DEFAULT (20s) max_seconds through when the caller omits it', async () => {
  const { server, handlers } = fakeServer();
  let receivedMaxSeconds: number | undefined;
  registerAgentCoreBrowserBrokerTools(server, () => 'caller-hash', fakeTransport(async (_targets, maxSeconds) => {
    receivedMaxSeconds = maxSeconds;
    return { receipts: [{ url: 'https://otchealth.app/page', title: 'ok', status: 200, cleanup_success: true } as unknown as InspectResult['receipts'][number]], partial: false };
  }));
  const handler = handlers.get('browser_broker_inspect_public')!;
  const res = await withCaller('cto', () => handler({ targets: ['https://otchealth.app/page'] }));
  const data = res.structuredContent?.result as Record<string, unknown>;
  assert.equal(receivedMaxSeconds, 20, 'DEFAULT_INSPECT_SECONDS must be passed through when the caller omits max_seconds');
  assert.equal(data.mode, 'public_read');
  assert.ok(Array.isArray(data.receipts) && (data.receipts as unknown[]).length === 1);
  assert.equal('partial' in data, false);
  assert.equal('skipped_targets' in data, false);
});

test('browser_broker_inspect_public: a partial transport result (bounded deadline reached) surfaces partial:true, skipped_targets, and says so in the summary', async () => {
  const { server, handlers } = fakeServer();
  registerAgentCoreBrowserBrokerTools(server, () => 'caller-hash', fakeTransport(async () => ({
    receipts: [{ url: 'https://otchealth.app/a', title: 'a', status: 200, cleanup_success: true } as unknown as InspectResult['receipts'][number]],
    partial: true,
    skipped_targets: ['https://otchealth.app/b'],
  })));
  const handler = handlers.get('browser_broker_inspect_public')!;
  const res = await withCaller('cto', () =>
    handler({ targets: ['https://otchealth.app/a', 'https://otchealth.app/b'], max_seconds: 5 }),
  );
  const data = res.structuredContent?.result as Record<string, unknown>;
  assert.equal(data.partial, true);
  assert.deepEqual(data.skipped_targets, ['https://otchealth.app/b']);
  assert.equal(Array.isArray(data.receipts) && (data.receipts as unknown[]).length, 1, 'the already-completed receipt is still returned, not discarded');
  const text = ((res as unknown as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? '';
  assert.match(text, /before the bounded time budget was reached/);
  assert.match(text, /1 target\(s\) were not inspected/);
});
