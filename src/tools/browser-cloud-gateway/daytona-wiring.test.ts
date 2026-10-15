import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requestContext } from '../../server/request-context.js';
import { websitePrincipalHash } from '../browser-cloud/website-login-service.js';
import { BrowserFileBroker, type BrowserFileRecord } from '../browser-cloud/file-broker.js';
import { registerCloudBrowserTools, type CloudBrowserGatewayRuntime, type DaytonaGatewayAdapter, type DaytonaGatewayRuntime } from './index.js';

for (const [key, value] of Object.entries({ CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test', PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32), N8N_WEBHOOK_SECRET: 'c'.repeat(32), CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 'test', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_ARTIFACT_BUCKET: 'test', READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true' })) process.env[key] = value;
type Result = { structuredContent?: { result?: Record<string, unknown> }; content?: Array<{ type: string; text?: string }> };
const SESSION = randomUUID();
const lanes = ['cto','cfo','clo','coo','cro','developer','wefunder-campaign-director'];
function fixture() {
  const handlers = new Map<string, (input: unknown) => Promise<Result>>();
  const calls: unknown[][] = [];
  const state = { enabled: true, owned: true, lookupError: false, providerError: false, checkpoint: true, checkpointReady: true, runtimeProtocol: 2 as number | undefined, multiMissionReady: true, proofProfile: 'exact-enrolled-server-profile', humanViewer: true, startFails: false, startProtocol: 2 as 2 | undefined };
  const browser: DaytonaGatewayRuntime['browser'] = {
    discover: async (...args) => { calls.push(['discover', ...args]); return { profileId: 'exact-enrolled-server-profile', allowedHosts: [], persistent: true, provider: 'daytona' }; },
    readiness: async (...args) => { calls.push(['readiness', ...args]); return { ready: true, profileKey: state.proofProfile, profilePath: '/home/otcbrowser/.local/share/otchealth-browser/exact-enrolled-server-profile/chromium', checkpointReady: state.checkpointReady, runtimeProtocol: state.runtimeProtocol, multiMissionReady: state.multiMissionReady }; },
    start: async (...args) => { calls.push(['start', ...args]); if (state.startFails) throw Object.assign(new Error('PRIVATE_PROVIDER_SECRET'), { code: 'daytona_multimission_unavailable' }); return { sessionId: SESSION, expiresAt: 1900000300000, ...(args[5]?.requireMultiMission ? { runtimeProtocol: state.startProtocol } : {}) }; },
    execute: async (...args) => { calls.push(['execute', ...args]); if (state.providerError) throw Object.assign(new Error('PRIVATE_PROVIDER_SECRET'), { code: 'effect_unknown' }); return { completed: true }; },
    snapshot: async (...args) => { calls.push(['snapshot', ...args]); return { title: 'public fixture' }; },
    savePersistentProfile: async (...args) => { calls.push(['save', ...args]); },
    stop: async (...args) => { calls.push(['stop', ...args]); },
  };
  const runtime: DaytonaGatewayRuntime = { browser, get capabilities() { return { checkpoint: state.checkpoint, humanViewer: state.humanViewer }; }, viewers: { issue: async (...args) => { calls.push(['issue', ...args]); return { login_url: 'https://mcp.otchealth.app/browser/daytona#token=private-short-lived', expires_at: 1900000200000 }; } } };
  const adapter: DaytonaGatewayAdapter = {
    get: async () => { calls.push(['get']); return state.enabled ? runtime : undefined; },
    forSession: async id => { calls.push(['lookup', id]); if (state.lookupError) throw Object.assign(new Error('PRIVATE_STORE_SECRET'), { code: 'daytona_store_unavailable' }); return id === SESSION && state.owned ? runtime : undefined; },
  };
  const aws = { browser: { start: async (...args: unknown[]) => { calls.push(['aws-start', ...args]); return { sessionId: 'ordinary-aws-session', expiresAt: 200000 }; }, execute: async (...args: unknown[]) => { calls.push(['aws-execute', ...args]); return {}; }, snapshot: async () => ({}), savePersistentProfile: async () => {}, stop: async () => {} } as never, jobs: {} as never, queue: {} as never, artifacts: {} as never } satisfies CloudBrowserGatewayRuntime;
  const server = { registerTool: (name: string, _config: unknown, handler: (input: unknown) => Promise<Result>) => { handlers.set(name, handler); return { remove() {} }; } } as unknown as McpServer;
  registerCloudBrowserTools(server, () => 'a'.repeat(64), aws, undefined, adapter);
  const call = (tool: string, input: unknown, lane = 'cto', oauth = true) => requestContext.run({ callerAgent: lane, callerHash: 'a'.repeat(64), correlationId: 'test', authKind: oauth ? 'oauth' : 'codex', ...(oauth ? { authSubject: 'client', authConnectionId: 'own-connection' } : {}) }, () => handlers.get(tool)!(input));
  return { call, calls, state };
}

test('reserved Daytona alias starts exact enrolled real service for each original OAuth company lane without AWS effects', async () => {
  const f = fixture();
  for (const lane of lanes) {
    const result = await f.call('browser_cloud_session_start', { profile_id: 'daytona-desktop', max_seconds: 180, action_budget: 25, dry_run: false }, lane);
    assert.equal(result.structuredContent?.result?.sessionId, SESSION);
    assert.equal(result.structuredContent?.result?.provider, 'daytona');
    assert.equal(result.structuredContent?.result?.profile_id, 'daytona-desktop');
    assert.deepEqual(f.calls.filter(row => row[0] === 'start').at(-1), ['start', lane, 'exact-enrolled-server-profile', 180, 25, websitePrincipalHash(lane, 'connection:own-connection')]);
    assert.deepEqual(f.calls.filter(row => row[0] === 'issue').at(-1), ['issue', lane, SESSION, websitePrincipalHash(lane, 'connection:own-connection'), 180]);
  }
  assert.equal(f.calls.some(row => row[0] === 'aws-start'), false);
});

test('Daytona alias rejects protected seats, static auth, disabled runtime and dry runs before provider effects', async () => {
  const f = fixture();
  await f.call('browser_cloud_session_start', { profile_id: 'daytona-desktop', max_seconds: 180, dry_run: true });
  assert.deepEqual(f.calls, []);
  for (const lane of ['clo-personal','exec','unknown']) assert.equal((await f.call('browser_cloud_session_start', { profile_id: 'daytona-desktop', max_seconds: 180, dry_run: false }, lane)).structuredContent?.result?.error, 'company_connection_required');
  assert.equal((await f.call('browser_cloud_session_start', { profile_id: 'daytona-desktop', max_seconds: 180, dry_run: false }, 'cto', false)).structuredContent?.result?.error, 'oauth_connection_required');
  assert.deepEqual(f.calls, []);
  f.state.enabled = false;
  assert.equal((await f.call('browser_cloud_session_start', { profile_id: 'daytona-desktop', max_seconds: 180, dry_run: false })).structuredContent?.result?.error, 'daytona_not_configured');
  assert.deepEqual(f.calls, [['get']]);
});

test('native UUID sessions route by server lookup only and known Daytona failures never fall through to AWS', async () => {
  const f = fixture();
  await f.call('browser_cloud_session_action', { session_id: SESSION, action: { type: 'navigate', url: 'https://example.com/' }, timeout_seconds: 20, dry_run: false });
  await f.call('browser_cloud_session_snapshot', { session_id: SESSION });
  await f.call('browser_cloud_profile_save', { session_id: SESSION, dry_run: false });
  await f.call('browser_cloud_session_stop', { session_id: SESSION, dry_run: false });
  for (const operation of ['execute','snapshot','save','stop']) assert.equal(f.calls.some(row => row[0] === operation), true);
  f.state.providerError = true;
  const failed = await f.call('browser_cloud_session_action', { session_id: SESSION, action: { type: 'navigate', url: 'https://example.com/' }, timeout_seconds: 20, dry_run: false });
  assert.equal(failed.structuredContent?.result?.error, 'effect_unknown');
  assert.equal(JSON.stringify(failed).includes('PRIVATE_PROVIDER_SECRET'), false);
  f.state.lookupError = true;
  const unknown = await f.call('browser_cloud_session_action', { session_id: SESSION, action: { type: 'navigate', url: 'https://example.com/' }, timeout_seconds: 20, dry_run: false });
  assert.equal(unknown.structuredContent?.result?.error, 'daytona_store_unavailable');
  assert.equal(f.calls.some(row => row[0] === 'aws-execute'), false);
});

test('Daytona human alias refuses missing exact per-binding checkpoint proof or viewer revocation before any mission start', async () => {
  for (const missing of ['checkpointReady', 'humanViewer'] as const) {
    const f = fixture(); f.state[missing] = false;
    const result = await f.call('browser_cloud_session_start', { profile_id: 'daytona-desktop', max_seconds: 180, dry_run: false });
    assert.equal(result.structuredContent?.result?.error, 'daytona_handoff_unavailable');
    assert.equal(f.calls.some(call => call[0] === 'start' || call[0] === 'issue' || call[0] === 'aws-start'), false);
  }
});
test('static checkpoint=false stays honest while exact current binding readiness gates before starting each mission', async () => {
  const f = fixture(); f.state.checkpoint = false;
  const result = await f.call('browser_cloud_session_start', { profile_id: 'daytona-desktop', max_seconds: 180, dry_run: false });
  assert.equal(result.structuredContent?.result?.sessionId, SESSION);
  assert.deepEqual(f.calls.map(call => call[0]), ['get', 'discover', 'readiness', 'start', 'issue']);
  assert.deepEqual(f.calls[2], ['readiness', 'cto', 'exact-enrolled-server-profile', websitePrincipalHash('cto', 'connection:own-connection')]);
  const foreign = fixture(); foreign.state.proofProfile = 'other-profile';
  const refused = await foreign.call('browser_cloud_session_start', { profile_id: 'daytona-desktop', max_seconds: 180, dry_run: false });
  assert.equal(refused.structuredContent?.result?.error, 'daytona_handoff_unavailable');
  assert.equal(foreign.calls.some(call => call[0] === 'start' || call[0] === 'issue' || call[0] === 'aws-start'), false);
});
test('company automation alias requires exact V2 proof, forwards mandatory no-fallback mode and never issues a human viewer', async () => {
  const f = fixture(); f.state.checkpoint = false; f.state.checkpointReady = false; f.state.humanViewer = false;
  for (const lane of lanes) {
    const result = await f.call('browser_cloud_session_start', { profile_id: 'daytona-company', max_seconds: 180, action_budget: 25, dry_run: false }, lane);
    assert.equal(result.structuredContent?.result?.sessionId, SESSION); assert.equal(result.structuredContent?.result?.provider, 'daytona');
    assert.equal(result.structuredContent?.result?.profile_id, 'daytona-company'); assert.equal(result.structuredContent?.result?.login_url, undefined);
    assert.equal(result.structuredContent?.result?.runtime_protocol, 2); assert.equal(result.structuredContent?.result?.status, 'ready');
    assert.deepEqual(f.calls.filter(row => row[0] === 'start').at(-1), ['start', lane, 'exact-enrolled-server-profile', 180, 25, websitePrincipalHash(lane, 'connection:own-connection'), { requireMultiMission: true }]);
  }
  assert.equal(f.calls.some(row => row[0] === 'issue' || row[0] === 'aws-start'), false);
});
test('company automation alias rejects absent/old V2 protocol, missing readiness and foreign proofs before any start', async () => {
  for (const invalid of [{ runtimeProtocol: undefined }, { runtimeProtocol: 1 }, { multiMissionReady: false }, { proofProfile: 'foreign' }]) {
    const f = fixture(); Object.assign(f.state, invalid);
    const result = await f.call('browser_cloud_session_start', { profile_id: 'daytona-company', max_seconds: 180, dry_run: false });
    assert.equal(result.structuredContent?.result?.error, 'daytona_multimission_unavailable');
    assert.equal(f.calls.some(row => row[0] === 'start' || row[0] === 'issue' || row[0] === 'aws-start'), false);
  }
});
test('company alias preserves OAuth lane checks, dry runs and off-default runtime refusal without AWS fallback', async () => {
  const f = fixture();
  const input = { profile_id: 'daytona-company', max_seconds: 180, dry_run: false };
  await f.call('browser_cloud_session_start', { ...input, dry_run: true }); assert.deepEqual(f.calls, []);
  for (const lane of ['clo-personal', 'exec', 'unknown']) assert.equal((await f.call('browser_cloud_session_start', input, lane)).structuredContent?.result?.error, 'company_connection_required');
  assert.equal((await f.call('browser_cloud_session_start', input, 'cto', false)).structuredContent?.result?.error, 'oauth_connection_required');
  assert.deepEqual(f.calls, []); f.state.enabled = false;
  assert.equal((await f.call('browser_cloud_session_start', input)).structuredContent?.result?.error, 'daytona_not_configured');
  assert.deepEqual(f.calls, [['get']]);
});
test('company alias remains its own opt-in provider when the unrelated AWS browser switch is off', async () => {
  const previous = process.env.CLOUD_BROWSER_ENABLED; process.env.CLOUD_BROWSER_ENABLED = 'false';
  try {
    const f = fixture(); const result = await f.call('browser_cloud_session_start', { profile_id: 'daytona-company', max_seconds: 180, dry_run: false });
    assert.equal(result.structuredContent?.result?.sessionId, SESSION);
    assert.equal(f.calls.some(row => row[0] === 'aws-start' || row[0] === 'issue'), false);
  } finally { process.env.CLOUD_BROWSER_ENABLED = previous; }
});
test('company start refusal or missing V2 receipt never produces ready, a human viewer or an AWS fallback', async () => {
  for (const scenario of ['refusal', 'receipt']) {
    const f = fixture(); f.state.startFails = scenario === 'refusal'; f.state.startProtocol = scenario === 'receipt' ? undefined : 2;
    const result = await f.call('browser_cloud_session_start', { profile_id: 'daytona-company', max_seconds: 180, dry_run: false });
    assert.equal(result.structuredContent?.result?.error, 'daytona_multimission_unavailable');
    assert.equal(result.structuredContent?.result?.status, undefined); assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER_SECRET'), false);
    assert.equal(f.calls.filter(row => row[0] === 'start').length, 1);
    assert.equal(f.calls.some(row => row[0] === 'issue' || row[0] === 'aws-start'), false);
  }
});

test('ordinary AWS starts and unknown UUIDs retain the existing provider path', async () => {
  const f = fixture();
  await f.call('browser_cloud_session_start', { profile_id: 'ordinary-profile', max_seconds: 180, dry_run: false });
  await f.call('browser_cloud_session_action', { session_id: randomUUID(), action: { type: 'navigate', url: 'https://example.com/' }, timeout_seconds: 20, dry_run: false });
  assert.equal(f.calls.some(row => row[0] === 'aws-start'), true);
  assert.equal(f.calls.some(row => row[0] === 'aws-execute'), true);
  assert.equal(f.calls.some(row => row[0] === 'start'), false);
});

test('file staging publishes exact scan receipt truthfully without claiming every ready file is unscanned text or an uploaded website file', async () => {
  const handlers = new Map<string, (input: unknown) => Promise<Result>>();
  const server = { registerTool: (name: string, _config: unknown, handler: (input: unknown) => Promise<Result>) => { handlers.set(name, handler); return { remove() {} }; } } as unknown as McpServer;
  let stored: { record: BrowserFileRecord; body: Uint8Array } | null = null;
  const files = new BrowserFileBroker({ put: async (_key, record, body) => { stored = { record, body }; }, get: async () => stored }, { allowValidatedText: true, scanner: { scan: async ({ body }) => ({ verdict: 'clean', scanner: 'clamav', sha256: createHash('sha256').update(body).digest('hex'), byteLength: body.length, scannedAt: Date.now(), engineVersion: '1.4.3', signatureVersion: '27832', signaturesUpdatedAt: Date.now() - 1000 }) } });
  registerCloudBrowserTools(server, () => 'a'.repeat(64), { browser: {} as never, jobs: {} as never, queue: {} as never, artifacts: {} as never, files });
  const result = await requestContext.run({ callerAgent: 'cto', callerHash: 'a'.repeat(64), correlationId: 'test', authKind: 'oauth', authSubject: 'client', authConnectionId: 'own-connection' }, () => handlers.get('browser_cloud_file_stage')!({ filename: 'public.txt', content_type: 'text/plain', body_base64: Buffer.from('public fixture').toString('base64'), dry_run: false }));
  assert.equal(result.structuredContent?.result?.status, 'ready');
  assert.equal((result.structuredContent?.result?.scan_receipt as { scanner?: string })?.scanner, 'clamav');
  const rendered = result.content?.map(item => item.text ?? '').join('\n') ?? '';
  assert.match(rendered, /ClamAV/);
  assert.equal(rendered.includes('No antivirus'), false);
  assert.match(rendered, /not.*completed|not.*website upload|not.*uploaded/i);
});
