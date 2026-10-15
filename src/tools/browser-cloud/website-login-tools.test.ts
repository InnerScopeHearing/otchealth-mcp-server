import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requestContext } from '../../server/request-context.js';
import { registerWebsiteBrowserLoginTools } from './website-login-tools.js';
import type { WebsiteLoginService } from './website-login-service.js';

for (const [key, value] of Object.entries({
  CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test',
  PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
  N8N_WEBHOOK_SECRET: 'c'.repeat(32), READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true',
})) process.env[key] ??= value;

type Result = { structuredContent?: { result?: Record<string, unknown> }; content?: unknown };
function fixture(runtime: Partial<WebsiteLoginService>) {
  const handlers = new Map<string, (input: unknown) => Promise<Result>>();
  const configs = new Map<string, Record<string, unknown>>();
  const server = { registerTool: (name: string, config: Record<string, unknown>, handler: (input: unknown) => Promise<Result>) => {
    handlers.set(name, handler); configs.set(name, config); return { remove() {} };
  } } as unknown as McpServer;
  registerWebsiteBrowserLoginTools(server, () => 'a'.repeat(64), () => runtime as WebsiteLoginService);
  const call = (lane: string, operation = 'start', extra = {}, key = 'connection-1') => requestContext.run({
    callerHash: 'a'.repeat(64), correlationId: 'website-login-test', callerAgent: lane,
    authKind: 'oauth', authSubject: 'client-id', authConnectionId: key,
  }, () => handlers.get(`browser_cloud_login_${operation}`)!({ site: 'linkedin', dry_run: false, ...extra }));
  return { call, handlers, configs };
}

test('login tool derives owner and connection from authentication for each company lane', async () => {
  const calls: unknown[][] = [];
  const f = fixture({ start: async (...args) => {
    calls.push(args);
    return { login_url: 'https://mcp.otchealth.app/browser/connect#token=ephemeral', profile_id: 'owned-profile', session_id: 'owned-session', expires_at: 1900000000000, status: 'human_login_required' };
  } });
  for (const lane of ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director']) {
    const result = await f.call(lane);
    assert.equal(result.structuredContent?.result?.status, 'human_login_required');
    assert.deepEqual(calls.at(-1), [lane, 'connection:connection-1', 'linkedin', undefined]);
  }
});

test('login tool refuses unbound and protected connections before runtime effects', async () => {
  let calls = 0;
  const f = fixture({ start: async () => { calls++; throw new Error('should not reach runtime'); } });
  for (const lane of ['clo-personal', 'external-read', 'unknown', 'exec']) {
    const result = await f.call(lane);
    assert.equal(result.structuredContent?.result?.error, 'company_connection_required');
  }
  const result = await requestContext.run({ callerAgent: 'cto', callerHash: 'a'.repeat(64), correlationId: 'test', authKind: 'codex' }, () => f.handlers.get('browser_cloud_login_start')!({ site: 'linkedin', dry_run: false }));
  assert.equal(result.structuredContent?.result?.error, 'oauth_connection_required');
  assert.equal(calls, 0);
});

test('discovery does not start a browser and keeps per-connection identity', async () => {
  const calls: unknown[][] = [];
  const f = fixture({ discover: async (...args) => {
    calls.push(args); return { profile_id: 'owned-profile', persistent: true, allowed_hosts: ['www.linkedin.com'] };
  } });
  const result = await f.call('wefunder-campaign-director', 'profile_discover', {}, 'second-authorization');
  assert.equal(result.structuredContent?.result?.persistent, true);
  assert.deepEqual(calls, [['wefunder-campaign-director', 'connection:second-authorization', 'linkedin', undefined]]);
});

test('provider errors never disclose sign-in URLs or credential-bearing details', async () => {
  const f = fixture({ start: async () => { throw new Error('private token and signed endpoint must remain inside runtime'); } });
  const result = await f.call('cto');
  assert.equal(result.structuredContent?.result?.error, 'website_login_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private token|signed endpoint/);
});

test('dry-run creates no login session', async () => {
  let calls = 0;
  const f = fixture({ start: async () => { calls++; throw new Error('unexpected'); } });
  const result = await f.call('cto', 'start', { dry_run: true });
  assert.equal(result.structuredContent?.result?.dry_run, true);
  assert.equal(calls, 0);
});
