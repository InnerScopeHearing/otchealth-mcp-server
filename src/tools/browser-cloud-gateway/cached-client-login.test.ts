import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestContext } from '../../server/request-context.js';
import { registerCloudBrowserTools, type CloudBrowserGatewayRuntime } from './index.js';
import type { WebsiteLoginService } from '../browser-cloud/website-login-service.js';

for (const [key, value] of Object.entries({
  CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test',
  PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
  N8N_WEBHOOK_SECRET: 'c'.repeat(32), CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 'test',
  CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_ARTIFACT_BUCKET: 'test',
  READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true',
})) process.env[key] = value;

type Result = { structuredContent?: { result?: Record<string, unknown> }; content?: unknown };
const lanes = ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director'];
function fixture() {
  const handlers = new Map<string, (input: unknown) => Promise<Result>>();
  const configs = new Map<string, Record<string, unknown>>();
  const calls = { normal: [] as unknown[][], login: [] as unknown[][], discover: [] as unknown[][], factories: 0 };
  const state = { loginError: false, missingSavedProfile: false };
  const server = { registerTool: (name: string, config: Record<string, unknown>, handler: (input: unknown) => Promise<Result>) => {
    handlers.set(name, handler); configs.set(name, config); return { remove() {} };
  } } as unknown as McpServer;
  const runtime = {
    browser: {
      start: async (...args: unknown[]) => { calls.normal.push(args); return { sessionId: 'ordinary-session', expiresAt: 200_000 }; },
      publicTrialProfile: async () => ({ profileId: 'public-profile', allowedHosts: [], persistent: false }),
      publicWebProfile: async () => ({ profileId: 'public-profile', allowedHosts: [], persistent: false, mode: 'public_web' }),
    } as never,
    jobs: {} as never, queue: {} as never, artifacts: {} as never,
  } satisfies CloudBrowserGatewayRuntime;
  const login = {
    start: async (...args: unknown[]) => {
      calls.login.push(args);
      if (state.loginError) throw new Error('private https://secret.invalid/#token=do-not-disclose');
      return { login_url: 'https://mcp.otchealth.app/browser/connect#token=synthetic-ephemeral', profile_id: 'owned-website-profile', session_id: 'human-session', expires_at: 100_000, session_expires_at: 300_000, status: 'human_login_required' };
    },
    discover: async (...args: unknown[]) => {
      calls.discover.push(args);
      if (state.missingSavedProfile) throw Object.assign(new Error('not connected'), { code: 'profile_not_enrolled' });
      return { profile_id: `owned-${args[2]}`, persistent: true, allowed_hosts: ['synthetic.example'] };
    },
  } as unknown as WebsiteLoginService;
  registerCloudBrowserTools(server, () => 'a'.repeat(64), runtime, () => { calls.factories++; return login; });
  const call = (tool: string, input: unknown, lane = 'wefunder-campaign-director', oauth = true) => requestContext.run({
    callerHash: 'a'.repeat(64), correlationId: 'cached-client-test', callerAgent: lane,
    authKind: oauth ? 'oauth' : 'codex', ...(oauth ? { authSubject: 'client', authConnectionId: 'own-connection' } : {}),
  }, () => handlers.get(tool)!(input));
  return { call, calls, configs, state };
}

test('existing session-start schema opens the same owned human login for both named sites and every company lane', async () => {
  const f = fixture();
  for (const lane of lanes) for (const site of ['linkedin', 'wefunder']) {
    const result = await f.call('browser_cloud_session_start', { profile_id: `website-login:${site}`, max_seconds: 180, action_budget: 25, dry_run: false }, lane);
    assert.deepEqual(f.calls.login.at(-1), [lane, 'connection:own-connection', site, undefined, { maxSeconds: 180, actionBudget: 25 }]);
    assert.deepEqual(result.structuredContent?.result, {
      sessionId: 'human-session', expiresAt: 300_000, profile_id: 'owned-website-profile',
      login_url: 'https://mcp.otchealth.app/browser/connect#token=synthetic-ephemeral',
      login_expires_at: 100_000, status: 'human_login_required',
    });
  }
  assert.equal(f.calls.normal.length, 0);
});

test('dry-run login alias has no runtime, profile or browser effects', async () => {
  const f = fixture();
  const result = await f.call('browser_cloud_session_start', { profile_id: 'website-login:linkedin', max_seconds: 180, dry_run: true });
  assert.equal(result.structuredContent?.result?.dry_run, true);
  assert.equal(f.calls.factories, 0); assert.equal(f.calls.normal.length, 0); assert.equal(f.calls.login.length, 0);
});

test('login aliases reject protected seats and missing OAuth binding before runtime effects', async () => {
  const f = fixture();
  for (const lane of ['clo-personal', 'unknown', 'external-read']) {
    const result = await f.call('browser_cloud_session_start', { profile_id: 'website-login:linkedin', max_seconds: 180, dry_run: false }, lane);
    assert.equal(result.structuredContent?.result?.error, 'company_connection_required');
  }
  const result = await f.call('browser_cloud_session_start', { profile_id: 'website-login:linkedin', max_seconds: 180, dry_run: false }, 'cto', false);
  assert.equal(result.structuredContent?.result?.error, 'oauth_connection_required');
  assert.equal(f.calls.factories, 0); assert.equal(f.calls.normal.length, 0);
});

test('unrecognized login aliases are not a generic operation or URL dispatcher', async () => {
  const f = fixture();
  for (const alias of ['website-login:custom', 'website-login:https://example.com', 'website-login:linkedin:foreign']) {
    const result = await f.call('browser_cloud_session_start', { profile_id: alias, max_seconds: 180, dry_run: false });
    assert.equal(result.structuredContent?.result?.error, 'website_login_profile_invalid');
  }
  assert.equal(f.calls.factories, 0); assert.equal(f.calls.normal.length, 0);
});

test('ordinary profile start remains ordinary and does not initialize the login runtime', async () => {
  const f = fixture();
  const result = await f.call('browser_cloud_session_start', { profile_id: 'public-profile', max_seconds: 180, dry_run: false });
  assert.equal(result.structuredContent?.result?.sessionId, 'ordinary-session');
  assert.equal(f.calls.factories, 0); assert.equal(f.calls.login.length, 0);
  assert.equal(f.calls.normal[0]?.[1], 'public-profile');
});

test('cached session-start input needs no additional fields to request a named login profile', () => {
  const f = fixture();
  const shape = f.configs.get('browser_cloud_session_start')!.inputSchema as z.ZodRawShape;
  assert.equal(z.object(shape).safeParse({ profile_id: 'website-login:linkedin', max_seconds: 180, dry_run: false }).success, true);
  assert.equal('site' in shape, false); assert.equal('url' in shape, false);
});

test('existing profile discovery advertises owned saved profiles and login aliases without starting anything', async () => {
  const f = fixture();
  const result = await f.call('browser_cloud_profile_discover', {});
  assert.deepEqual(result.structuredContent?.result?.website_profiles, [
    { site: 'linkedin', login_profile_id: 'website-login:linkedin', saved_profile_id: 'owned-linkedin', status: 'saved_profile_available' },
    { site: 'wefunder', login_profile_id: 'website-login:wefunder', saved_profile_id: 'owned-wefunder', status: 'saved_profile_available' },
  ]);
  assert.deepEqual(f.calls.discover, [
    ['wefunder-campaign-director', 'connection:own-connection', 'linkedin'],
    ['wefunder-campaign-director', 'connection:own-connection', 'wefunder'],
  ]);
  assert.equal(f.calls.login.length, 0); assert.equal(f.calls.normal.length, 0);
});

test('missing saved profiles advertise login-required without treating public profile as persistent', async () => {
  const f = fixture(); f.state.missingSavedProfile = true;
  const result = await f.call('browser_cloud_profile_discover', {});
  assert.deepEqual(result.structuredContent?.result?.website_profiles, [
    { site: 'linkedin', login_profile_id: 'website-login:linkedin', status: 'login_required' },
    { site: 'wefunder', login_profile_id: 'website-login:wefunder', status: 'login_required' },
  ]);
  assert.equal(result.structuredContent?.result?.persistent, false);
  assert.equal(f.calls.login.length, 0);
});

test('login provider errors through existing tool remain sanitized', async () => {
  const f = fixture(); f.state.loginError = true;
  const result = await f.call('browser_cloud_session_start', { profile_id: 'website-login:linkedin', max_seconds: 180, dry_run: false });
  assert.equal(result.structuredContent?.result?.error, 'cloud_browser_failed');
  assert.doesNotMatch(JSON.stringify(result), /secret\.invalid|do-not-disclose/);
});
