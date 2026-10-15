import assert from 'node:assert/strict';
import test from 'node:test';
import { IntercomProfileProvider, IntercomProfileProviderError } from './intercom-profile-provider.js';
import type { AwsCredentials } from '../../search/sigv4.js';

const CREDS: AwsCredentials = { accessKeyId: 'ASIATEST', secretAccessKey: 'not-a-real-secret', sessionToken: 'not-a-real-token' };
const PROFILE_ID = 'cooIntercom-abc1234567';
const OWNER_HASH = 'a'.repeat(64);
const CLIENT_TOKEN = 'idempotency-token-0123456789';
const AUTOMATION_ENDPOINT = 'wss://bedrock-agentcore.us-east-1.amazonaws.com/browser-streams/aws.browser.v1/sessions/session-abc/automation';

function identityXml(account = '900915535335', arn = 'arn:aws:sts::900915535335:assumed-role/otchealth-gateway/task-123'): Response {
  return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${arn}</Arn><Account>${account}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`, { status: 200 });
}

function provider(overrides: {
  sts?: (url: string, init?: RequestInit) => Promise<Response>;
  controlSend?: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
  dataSend?: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
  createBrowser?: (input: { region: string; identifier: string; credentials: AwsCredentials }) => { attachSession(sessionId: string): void; generateLiveViewUrl(expiresIn?: number): Promise<string> };
} = {}) {
  const state = { commandInput: undefined as unknown, sendCount: 0, dataSendCount: 0, dataCommand: undefined as unknown, dataConfig: undefined as unknown, attached: '', liveExpiry: 0, controlRegion: '', browserConfig: undefined as unknown };
  const instance = new IntercomProfileProvider({ region: 'us-east-1', browserIdentifier: 'aws.browser.v1' }, {
    resolveCredentials: async () => CREDS,
    fetch: overrides.sts ?? (async () => identityXml()),
    createControlClient: (region) => ({ send: async (command, options) => {
      state.controlRegion = region;
      state.sendCount += 1;
      assert.ok(options?.abortSignal);
      return overrides.controlSend ? overrides.controlSend(command, options) : { profileId: PROFILE_ID };
    } }),
    createProfileCommand: (input) => { state.commandInput = input; return { operation: 'CreateBrowserProfile', input }; },
    createDataClient: (config) => {
      state.dataConfig = config;
      return { send: async (command, options) => {
        state.dataSendCount += 1;
        state.dataCommand = command;
        assert.ok(options?.abortSignal);
        return overrides.dataSend ? overrides.dataSend(command, options) : {
          browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc',
          streams: { automationStream: { streamStatus: 'DISABLED' } },
        };
      } };
    },
    createBrowser: (config) => {
      state.browserConfig = config;
      if (overrides.createBrowser) return overrides.createBrowser(config);
      return {
        attachSession: (sessionId) => { state.attached = sessionId; },
        generateLiveViewUrl: async (expiresIn) => {
          state.liveExpiry = expiresIn ?? 0;
          return `https://bedrock-agentcore.us-east-1.amazonaws.com/browser-streams/aws.browser.v1/sessions/session-abc/live-view?X-Amz-Signature=opaque`;
        },
      };
    },
  });
  return { instance, state };
}

test('creates AgentCore profile only after fresh STS identity confirms the permitted assumed role account', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const { instance, state } = provider({ sts: async (url, init) => { calls.push({ url, init }); return identityXml(); } });
  const result = await instance.createProfile({ name: 'coo-intercom', clientToken: CLIENT_TOKEN, ownerSubjectHash: OWNER_HASH });
  assert.equal(result.providerProfileId, PROFILE_ID);
  assert.deepEqual(result.roleReceipt, { accountId: '900915535335', principalType: 'assumed-role', roleName: 'otchealth-gateway' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sts.us-east-1.amazonaws.com/');
  assert.equal(calls[0].init?.method, 'POST');
  assert.match(String(calls[0].init?.headers && (calls[0].init?.headers as Record<string, string>).Authorization), /^AWS4-HMAC-SHA256 /);
  assert.deepEqual(state.commandInput, { name: 'coo-intercom', clientToken: CLIENT_TOKEN });
  assert.equal(state.controlRegion, 'us-east-1');
  assert.equal(state.sendCount, 1);
  assert.equal(JSON.stringify(result).includes(OWNER_HASH), false);
});

test('refuses wrong account, root, and non-assumed principals before creating a profile', async () => {
  const denied = [
    identityXml('000000000000'),
    identityXml('900915535335', 'arn:aws:iam::900915535335:root'),
    identityXml('900915535335', 'arn:aws:iam::900915535335:user/operator'),
  ];
  for (const response of denied) {
    const { instance, state } = provider({ sts: async () => response });
    await assert.rejects(instance.createProfile({ name: 'coo-intercom', clientToken: CLIENT_TOKEN, ownerSubjectHash: OWNER_HASH }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'principal_forbidden');
    assert.equal(state.sendCount, 0);
  }
});

test('does not retry or expose AWS errors from profile creation', async () => {
  const { instance, state } = provider({ controlSend: async () => { throw new Error('Sensitive AWS response details'); } });
  await assert.rejects(instance.createProfile({ name: 'coo-intercom', clientToken: CLIENT_TOKEN, ownerSubjectHash: OWNER_HASH }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'profile_create_failed' && !error.message.includes('Sensitive'));
  assert.equal(state.sendCount, 1);
});

test('generates a bounded AWS-signed live-view URL for the fixed region and attached session', async () => {
  const { instance, state } = provider();
  const result = await instance.generateLiveViewUrl({ browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc' });
  assert.equal(result.expiresIn, 300);
  assert.equal(new URL(result.url).hostname, 'bedrock-agentcore.us-east-1.amazonaws.com');
  assert.equal(state.attached, 'session-abc');
  assert.equal(state.liveExpiry, 300);
  assert.deepEqual(state.browserConfig, { region: 'us-east-1', identifier: 'aws.browser.v1', credentials: CREDS });
});

test('rejects browser substitution, overlong live-view expiry, and unsafe SDK URL', async () => {
  const { instance } = provider();
  await assert.rejects(instance.generateLiveViewUrl({ browserIdentifier: 'different-browser', sessionId: 'session-abc' }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'browser_identifier_forbidden');
  await assert.rejects(instance.generateLiveViewUrl({ browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc', expiresIn: 301 }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'live_view_expiry_invalid');
  const hostile = provider({ createBrowser: () => ({ attachSession() {}, generateLiveViewUrl: async () => 'https://attacker.invalid/steal' }) });
  await assert.rejects(hostile.instance.generateLiveViewUrl({ browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc' }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'live_view_url_invalid');
});

test('fails closed when provider credentials are unavailable', async () => {
  const instance = new IntercomProfileProvider({ region: 'us-east-1', browserIdentifier: 'aws.browser.v1' }, { resolveCredentials: async () => null });
  await assert.rejects(instance.createProfile({ name: 'coo-intercom', clientToken: CLIENT_TOKEN, ownerSubjectHash: OWNER_HASH }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'credentials_unavailable');
  await assert.rejects(instance.generateLiveViewUrl({ browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc' }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'credentials_unavailable');
  await assert.rejects(instance.setAutomationStreamStatus({ browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc', streamStatus: 'DISABLED' }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'credentials_unavailable');
});

test('automation handoff sends the official SDK command once with explicit credentials, bounded timeout and exact owned IDs', async () => {
  const { instance, state } = provider();
  const result = await instance.setAutomationStreamStatus({ browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc', streamStatus: 'DISABLED' });
  assert.deepEqual(result, { browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc', streamStatus: 'DISABLED' });
  assert.equal(state.dataSendCount, 1);
  const config = state.dataConfig as { region: string; maxAttempts: number; credentials: () => Promise<AwsCredentials> };
  assert.equal(config.region, 'us-east-1');
  assert.equal(config.maxAttempts, 1);
  assert.deepEqual(await config.credentials(), CREDS);
  assert.equal((state.dataCommand as { constructor: { name: string } }).constructor.name, 'UpdateBrowserStreamCommand');
  const input = (state.dataCommand as { input: Record<string, unknown> }).input;
  assert.equal(input.browserIdentifier, 'aws.browser.v1');
  assert.equal(input.sessionId, 'session-abc');
  assert.deepEqual(input.streamUpdate, { automationStreamUpdate: { streamStatus: 'DISABLED' } });
  assert.match(String(input.clientToken), /^[a-f0-9-]{36}$/);
});

test('automation re-enable returns only the validated current session endpoint', async () => {
  const { instance } = provider({ dataSend: async () => ({
    browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc',
    streams: { automationStream: { streamStatus: 'ENABLED', streamEndpoint: AUTOMATION_ENDPOINT } },
  }) });
  assert.deepEqual(await instance.setAutomationStreamStatus({ browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc', streamStatus: 'ENABLED' }), {
    browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc', streamStatus: 'ENABLED', automationEndpoint: AUTOMATION_ENDPOINT,
  });
});

test('automation handoff fails closed on substituted IDs, status mismatch and unsafe re-enabled endpoints', async () => {
  const valid = { browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc', streams: { automationStream: { streamStatus: 'ENABLED', streamEndpoint: AUTOMATION_ENDPOINT } } };
  const responses = [
    { ...valid, browserIdentifier: 'other-browser' },
    { ...valid, sessionId: 'other-session' },
    { ...valid, browserIdentifier: undefined },
    { ...valid, sessionId: undefined },
    { ...valid, streams: { automationStream: { streamStatus: 'DISABLED', streamEndpoint: AUTOMATION_ENDPOINT } } },
    { ...valid, streams: { automationStream: { streamStatus: 'ENABLED' } } },
    { ...valid, streams: { automationStream: { streamStatus: 'ENABLED', streamEndpoint: AUTOMATION_ENDPOINT.replace('session-abc', 'session-other') } } },
    { ...valid, streams: { automationStream: { streamStatus: 'ENABLED', streamEndpoint: 'wss://attacker.invalid/automation' } } },
  ];
  for (const response of responses) {
    const { instance, state } = provider({ dataSend: async () => response });
    await assert.rejects(instance.setAutomationStreamStatus({ browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc', streamStatus: 'ENABLED' }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'automation_stream_receipt_invalid');
    assert.equal(state.dataSendCount, 1);
  }
});

test('automation handoff rejects invalid input before AWS and sanitizes a single failed attempt', async () => {
  const { instance, state } = provider({ dataSend: async () => { throw new Error(`AWS private ${CREDS.secretAccessKey} ${CREDS.sessionToken}`); } });
  await assert.rejects(instance.setAutomationStreamStatus({ browserIdentifier: 'other-browser', sessionId: 'session-abc', streamStatus: 'DISABLED' }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'browser_identifier_forbidden');
  await assert.rejects(instance.setAutomationStreamStatus({ browserIdentifier: 'aws.browser.v1', sessionId: '../other', streamStatus: 'DISABLED' }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'session_id_invalid');
  assert.equal(state.dataSendCount, 0);
  await assert.rejects(instance.setAutomationStreamStatus({ browserIdentifier: 'aws.browser.v1', sessionId: 'session-abc', streamStatus: 'DISABLED' }), (error: unknown) => error instanceof IntercomProfileProviderError && error.code === 'automation_stream_update_failed' && !error.message.includes(CREDS.secretAccessKey) && !error.message.includes(CREDS.sessionToken!));
  assert.equal(state.dataSendCount, 1);
});
