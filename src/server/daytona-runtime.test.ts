import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { createDaytonaRuntimeController } from './daytona-runtime.js';
import type { DaytonaBrowserStore, DaytonaMission, DaytonaProvider } from '../tools/browser-daytona/contract.js';
import type { DaytonaViewerGrantRecord, DaytonaViewerGrantStore } from '../tools/browser-daytona/viewer-grant-store.js';
import { EncryptedDaytonaViewerGrantPort } from '../tools/browser-daytona/viewer-grants.js';
import { DaytonaBrowserService } from '../tools/browser-daytona/service.js';
import { daytonaViewerGrantBindingHash, daytonaViewerPhysicalScopeHash } from '../tools/browser-daytona/viewer-grant-store.js';
import type { DaytonaViewerTicket, DaytonaViewerTicketStore } from './daytona-viewer-service.js';
import type { DaytonaViewerService } from './daytona-viewer.js';

const SESSION = randomUUID();
const env = { DAYTONA_BROWSER_ENABLED: 'true', DAYTONA_BROWSER_API_BASE_URL: 'https://app.daytona.io/api', DAYTONA_BROWSER_ORGANIZATION_ID: '501db94e-10ee-4bc8-9cca-23c793c67524', DAYTONA_BROWSER_SANDBOX_ID: '11111111-1111-4111-8111-111111111111', DAYTONA_VIEWER_GRANT_KEY_BASE64: randomBytes(32).toString('base64'), DAYTONA_BROWSER_VIEWER_CONTROL_SHA256: '17f61b92692760ae7908a3987b593180bed0e8bf2f9a52afb1fa80d9489dcce2', DAYTONA_BROWSER_API_TOKEN: 'SERVER_ONLY_PRIVATE_TEST_TOKEN', CLOUD_BROWSER_DDB_TABLE: 'browser-table', DAYTONA_BROWSER_PREVIEW_DOMAIN: 'proxy.daytona.works', DAYTONA_BROWSER_PREVIEW_PORT: '6080', DAYTONA_BROWSER_PREVIEW_PATH: '/vnc.html', DAYTONA_BROWSER_TOOLBOX_ALLOWED_ORIGINS: '["https://proxy.app.daytona.io"]' };
function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const calls: string[] = [];
  const state = { checkpoint: true, lookupError: false, scopeError: false, scopeErrors: new Set<string>(), scopeReads: [] as string[], scopeGrants: new Map<string, DaytonaViewerGrantRecord>(), tickets: new Map<string, DaytonaViewerTicket>(), ticketTransitions: [] as string[], ticks: [] as (() => void)[], scheduleFails: false, uploadConfigured: false, captureConfigured: false, sandbox: env.DAYTONA_BROWSER_SANDBOX_ID, scheduled: 0, cancelled: 0, tick: undefined as (() => void) | undefined, session: null as DaytonaMission | null };
  const store: DaytonaBrowserStore = {
    loadBinding: async profileKey => ({ provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: state.sandbox, profileKey, profilePath: `/home/otcbrowser/.local/share/otchealth-browser/${profileKey}/chromium`, readinessReceiptSha256: 'b'.repeat(64) }), createBinding: async () => false,
    loadSession: async () => { calls.push('load'); if (state.lookupError) throw new Error('private-store-error'); return state.session; },
    createSession: async () => false, saveSessionUnderLock: async () => {}, acquireSessionLock: async () => false, releaseSessionLock: async () => {},
    acquireProfileLease: async () => false, ownsProfileLease: async () => false, releaseProfileLease: async () => {},
  };
  const provider: DaytonaProvider & { capabilities: { checkpoint: boolean } } = {
    capabilities: { checkpoint: false },
    probe: async binding => { calls.push('probe'); return { ready: true, profileKey: binding.profileKey, profilePath: binding.profilePath, checkpointReady: state.checkpoint }; },
    inspect: async () => { calls.push('inspect'); throw new Error('must not call provider in factory'); },
    openMission: async () => { calls.push('open'); }, execute: async () => { calls.push('execute'); }, checkpoint: async () => { calls.push('checkpoint'); }, releaseMission: async () => { calls.push('release'); },
    viewerGrant: async () => { throw new Error('no grant'); }, readViewerGrant: async () => { throw new Error('no read'); }, revokeViewerGrant: async () => { throw new Error('no revoke'); },
  };
  const grants: DaytonaViewerGrantStore = { reserve: async () => { throw new Error('no mint'); }, load: async handle => [...state.scopeGrants.values()].find(row => row.grantHandle === handle) ?? null, compareAndSwap: async () => { throw new Error('no write'); }, readPhysicalScope: async scope => { calls.push('scope'); state.scopeReads.push(scope); if (state.scopeError || state.scopeErrors.has(scope)) throw new Error('PRIVATE_BACKEND_ERROR'); return state.scopeGrants.get(scope)?.grantHandle ?? null; } };
  const tickets: DaytonaViewerTicketStore = { create: async (hash, row) => { if (state.tickets.has(hash)) return false; state.tickets.set(hash, structuredClone(row)); return true; }, load: async hash => structuredClone(state.tickets.get(hash) ?? null), transition: async (hash, phase, row) => { const current = state.tickets.get(hash); if (current?.phase !== phase || row.version !== current.version + 1) return false; state.ticketTransitions.push(row.phase); state.tickets.set(hash, structuredClone(row)); return true; }, acquireMissionLease: async () => true, ownsMissionLease: async () => true, releaseMissionLease: async () => {} };
  const controller = createDaytonaRuntimeController({ env: { ...env, ...overrides }, createTickets: () => tickets, createGrantStore: () => grants, createStore: () => { calls.push('store'); return store; }, createProvider: options => { assert.equal(options.organizationId, env.DAYTONA_BROWSER_ORGANIZATION_ID); state.uploadConfigured = typeof options.files?.forUpload === 'function'; state.captureConfigured = typeof options.captures?.createCapture === 'function'; if (!Object.hasOwn(overrides, 'DAYTONA_BROWSER_PREVIEW_PATH')) assert.ok(options.viewer instanceof EncryptedDaytonaViewerGrantPort); calls.push('provider'); return provider; },
    scheduleTick: (tick, milliseconds) => { assert.equal(milliseconds, 1000); if (state.scheduleFails) throw new Error('PRIVATE_SCHEDULER_ERROR'); state.scheduled++; state.tick = tick; state.ticks.push(tick); return () => { state.cancelled++; }; }, onWatchdogStatus: () => {} });
  return { controller, calls, state };
}

test('Daytona runtime is off by default and malformed/partial private viewer configuration never creates a provider', async () => {
  const f = fixture({ DAYTONA_BROWSER_ENABLED: undefined });
  assert.equal(await f.controller.adapter.get(), undefined);
  assert.deepEqual(f.calls, []);
  for (const bad of [{ DAYTONA_BROWSER_PREVIEW_PORT: undefined }, { DAYTONA_BROWSER_ORGANIZATION_ID: undefined }, { DAYTONA_BROWSER_API_TOKEN: undefined }, { DAYTONA_BROWSER_TOOLBOX_ALLOWED_ORIGINS: '["http://evil.example"]' }]) {
    const current = fixture(bad);
    assert.equal(await current.controller.adapter.get(), undefined);
    assert.equal(current.calls.includes('provider'), false);
    assert.equal(JSON.stringify(current.controller.status()).includes(env.DAYTONA_BROWSER_API_TOKEN), false);
  }
});

test('Daytona runtime composes concrete encrypted vault and reconciles before routes without global checkpoint claims', async () => {
  const f = fixture();
  assert.equal(await f.controller.adapter.get(), undefined); assert.deepEqual(f.calls, []);
  assert.equal(await f.controller.initialize(), true);
  const runtime = await f.controller.adapter.get();
  assert.ok(runtime);
  assert.equal(runtime, await f.controller.adapter.get());
  assert.deepEqual(f.calls, ['provider','store','scope']); assert.equal(runtime.capabilities.checkpoint, false);
  const app = Fastify();
  try { assert.equal(await f.controller.registerRoutes(app), true); assert.equal(await f.controller.registerRoutes(app), true); assert.equal((await app.inject('/browser/daytona')).statusCode, 200); assert.equal(f.state.scheduled, 1); }
  finally { await app.close(); }
  assert.equal(f.state.cancelled, 1);
  const unavailable = fixture(); unavailable.state.checkpoint = false;
  await unavailable.controller.initialize();
  assert.equal((await unavailable.controller.adapter.get())?.capabilities.checkpoint, false);
  const closed = Fastify();
  try { assert.equal(await unavailable.controller.registerRoutes(closed), true); assert.equal((await closed.inject('/browser/daytona')).statusCode, 200);
    assert.equal((await (await unavailable.controller.adapter.get())!.browser.readiness('cto', 'profile-one', 'a'.repeat(64))).checkpointReady, false);
  }
  finally { await closed.close(); }
  assert.equal(unavailable.calls.includes('inspect'), false); assert.equal(unavailable.calls.includes('probe'), true);
});

test('Daytona session selection uses only owned sealed store records and never catches a lookup error into AWS fallback', async () => {
  const f = fixture();
  assert.equal(await f.controller.adapter.forSession(SESSION), undefined);
  f.state.lookupError = true;
  await assert.rejects(f.controller.adapter.forSession(SESSION));
  assert.equal(f.calls.includes('provider'), false);
});

test('existing sealed Daytona missions retain native cleanup routing after opt-out and checkpoint downgrade', async () => {
  const f = fixture({ DAYTONA_BROWSER_ENABLED: undefined, DAYTONA_BROWSER_PREVIEW_PATH: undefined });
  f.state.checkpoint = false;
  f.state.session = { provider: 'daytona', sessionId: SESSION, owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileKey: `cto-${'a'.repeat(64)}`, sandboxId: randomUUID(), expiresAt: 1900000300000, actionsUsed: 0, actionBudget: 10, effectUnknown: false, phase: 'ACTIVE' };
  assert.equal(await f.controller.adapter.get(), undefined);
  const native = await f.controller.adapter.forSession(SESSION);
  assert.ok(native);
  assert.equal(native.capabilities.checkpoint, false);
  assert.equal(typeof native.browser.stop, 'function');
  assert.equal(f.calls.includes('inspect'), false);
});
test('runtime requires dedicated canonical32-byte key, exact sandbox UUID and native helper pin before effects', async () => {
  for (const missing of [{ DAYTONA_VIEWER_GRANT_KEY_BASE64: undefined }, { DAYTONA_VIEWER_GRANT_KEY_BASE64: Buffer.alloc(32).toString('base64') }, { DAYTONA_VIEWER_GRANT_KEY_BASE64: 'not-base64' }, { DAYTONA_BROWSER_SANDBOX_ID: 'guess' }, { DAYTONA_BROWSER_VIEWER_CONTROL_SHA256: undefined }]) {
    const f = fixture(missing); assert.equal(await f.controller.adapter.get(), undefined); assert.equal(f.calls.includes('provider'), false);
    assert.equal(JSON.stringify(f.controller.status()).includes(env.DAYTONA_VIEWER_GRANT_KEY_BASE64), false);
  }
});
test('runtime cannot expose a human alias until explicit boot reconciliation and stops scheduling on shutdown', async () => {
  const f = fixture(); assert.equal(await f.controller.adapter.get(), undefined);
  assert.equal(typeof f.controller.initialize, 'function'); assert.equal(typeof f.controller.shutdown, 'function');
  assert.deepEqual(await Promise.all([f.controller.initialize(), f.controller.initialize()]), [true, true]);
  assert.equal(f.calls.filter(call => call === 'scope').length, 1); assert.equal(f.state.scheduled, 1);
  assert.ok(await f.controller.adapter.get()); f.controller.shutdown(); assert.equal(f.state.cancelled, 1);
  assert.equal(await f.controller.adapter.get(), undefined); assert.equal(await f.controller.initialize(), false);
  const count = f.calls.length; f.state.tick!(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, count);
});
test('watchdog errors close issuance and resume but never remove sealed cleanup routing or leak backend errors', async () => {
  const f = fixture(); await f.controller.initialize();
  f.state.scopeError = true; f.state.tick!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.status().watchdogReady, false); assert.equal(await f.controller.adapter.get(), undefined);
  const app = Fastify();
  try {
    await f.controller.registerRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers: { origin: 'https://mcp.otchealth.app' }, payload: { token: 'A'.repeat(43) } });
    assert.equal(response.statusCode, 409); assert.equal(response.body.includes('PRIVATE'), false);
    f.state.session = { provider: 'daytona', sessionId: SESSION, owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileKey: 'profile-one', sandboxId: env.DAYTONA_BROWSER_SANDBOX_ID, expiresAt: Date.now() + 60000, actionsUsed: 0, actionBudget: 10, effectUnknown: false, phase: 'ACTIVE' };
    assert.equal(typeof (await f.controller.adapter.forSession(SESSION))!.browser.stop, 'function');
  } finally { await app.close(); }
});
test('exact configured sandbox and principal are checked before any per-binding provider probe', async () => {
  const f = fixture(); await f.controller.initialize(); const runtime = (await f.controller.adapter.get())!;
  await assert.rejects(runtime.browser.readiness('cto', 'profile-one', 'c'.repeat(64)));
  f.state.sandbox = '22222222-2222-4222-8222-222222222222';
  await assert.rejects(runtime.browser.readiness('cto', 'profile-one', 'a'.repeat(64)));
  assert.equal(f.calls.includes('probe'), false); assert.equal(f.calls.includes('inspect'), false); f.controller.shutdown();
});
test('a failed scheduler installation cannot enable human handoffs even after a successful initial idle tick', async () => {
  const f = fixture(); f.state.scheduleFails = true;
  assert.equal(await f.controller.initialize(), false); assert.equal(f.controller.status().watchdogReady, false);
  assert.equal(await f.controller.adapter.get(), undefined);
});
test('normal runtime passes real lazy file/capture ports only for configured shared artifact storage and AV scanner', async () => {
  const storage = { CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue', CLOUD_BROWSER_ARTIFACT_BUCKET: 'browser-artifacts', BROWSER_FILE_CLAMAV_HOST: 'clamav.browser-security.internal', BROWSER_FILE_CLAMAV_PORT: '3310' };
  const configured = fixture(storage); await configured.controller.initialize();
  assert.equal(configured.state.uploadConfigured, true); assert.equal(configured.state.captureConfigured, true); configured.controller.shutdown();
  const scannerMissing = fixture({ ...storage, BROWSER_FILE_CLAMAV_HOST: undefined }); await scannerMissing.controller.initialize();
  assert.equal(scannerMissing.state.uploadConfigured, false); assert.equal(scannerMissing.state.captureConfigured, true); scannerMissing.controller.shutdown();
  const missing = fixture(); await missing.controller.initialize();
  assert.equal(missing.state.uploadConfigured, false); assert.equal(missing.state.captureConfigured, false); missing.controller.shutdown();
});
test('runtime forwards the mandatory V2 mode to the real service without weakening binding or health gates', async t => {
  const f = fixture(); await f.controller.initialize();
  const calls: unknown[][] = [];
  t.mock.method(DaytonaBrowserService.prototype, 'start', async (...args: Parameters<DaytonaBrowserService['start']>) => { calls.push(args); return { sessionId: SESSION, expiresAt: 1900000300000, runtimeProtocol: 2 as const }; });
  try {
    const browser = (await f.controller.adapter.get())!.browser;
    assert.equal((await browser.start('cto', 'profile-one', 180, 25, 'a'.repeat(64), { requireMultiMission: true })).runtimeProtocol, 2);
    assert.deepEqual(calls, [['cto', 'profile-one', 180, 25, 'a'.repeat(64), { requireMultiMission: true }]]);
    await assert.rejects(browser.start('cto', 'profile-one', 180, 25, 'c'.repeat(64), { requireMultiMission: true }));
    assert.equal(calls.length, 1);
    f.controller.shutdown();
    await assert.rejects(browser.start('cto', 'profile-one', 180, 25, 'a'.repeat(64), { requireMultiMission: true }));
    assert.equal(calls.length, 1);
  } finally { f.controller.shutdown(); }
});

const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const pool = { DAYTONA_BROWSER_SANDBOX_IDS: JSON.stringify([env.DAYTONA_BROWSER_SANDBOX_ID, SECOND, THIRD]) };
test('worker enrollment is explicit unique bounded UUID configuration, never a malformed-list singular fallback', async () => {
  for (const value of ['null', '{}', '[]', '["guess"]', JSON.stringify([SECOND]), JSON.stringify([env.DAYTONA_BROWSER_SANDBOX_ID, SECOND, SECOND]), JSON.stringify([env.DAYTONA_BROWSER_SANDBOX_ID, SECOND, THIRD, randomUUID()])]) {
    const f = fixture({ DAYTONA_BROWSER_SANDBOX_IDS: value });
    assert.equal(await f.controller.initialize(), false, value);
    assert.equal(await f.controller.adapter.get(), undefined);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture({ ...pool, DAYTONA_BROWSER_SANDBOX_ID: undefined });
  assert.equal(await f.controller.initialize(), true); assert.equal(f.state.scheduled, 3); f.controller.shutdown();
});
test('three exact worker scopes reconcile and expire independently, without granting another worker readiness', async () => {
  const f = fixture(pool);
  assert.equal(await f.controller.initialize(), true); assert.equal(f.state.scheduled, 3);
  assert.deepEqual(new Set(f.state.scopeReads), new Set([env.DAYTONA_BROWSER_SANDBOX_ID, SECOND, THIRD].map(id => daytonaViewerPhysicalScopeHash(env.DAYTONA_BROWSER_ORGANIZATION_ID, id))));
  const runtime = (await f.controller.adapter.get())!;
  f.state.sandbox = SECOND;
  assert.equal((await runtime.browser.readiness('cto', 'profile-one', 'a'.repeat(64))).checkpointReady, true);
  f.state.checkpoint = false;
  assert.equal((await runtime.browser.readiness('cto', 'profile-one', 'a'.repeat(64))).checkpointReady, false);
  const probes = f.calls.filter(call => call === 'probe').length;
  f.state.sandbox = randomUUID();
  await assert.rejects(runtime.browser.readiness('cto', 'profile-one', 'a'.repeat(64)));
  assert.equal(f.calls.filter(call => call === 'probe').length, probes);
  f.state.scopeErrors.add(daytonaViewerPhysicalScopeHash(env.DAYTONA_BROWSER_ORGANIZATION_ID, SECOND));
  for (const tick of f.state.ticks) tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.status().watchdogReady, false);
  assert.ok(await f.controller.adapter.get(), 'one failed worker must not remove healthy workers');
  f.state.sandbox = SECOND;
  await assert.rejects(runtime.browser.readiness('cto', 'profile-one', 'a'.repeat(64)));
  f.state.sandbox = env.DAYTONA_BROWSER_SANDBOX_ID;
  assert.equal((await runtime.browser.readiness('cto', 'profile-one', 'a'.repeat(64))).checkpointReady, false);
  f.controller.shutdown(); assert.equal(f.state.cancelled, 3);
});
test('sealed session routing cannot bypass worker admission, but exact-owned cleanup survives opt-out', async t => {
  const effects: string[] = [];
  t.mock.method(DaytonaBrowserService.prototype, 'execute', async () => { effects.push('execute'); });
  t.mock.method(DaytonaBrowserService.prototype, 'stop', async () => { effects.push('stop'); });
  const f = fixture(); await f.controller.initialize();
  f.state.sandbox = SECOND;
  f.state.session = { provider: 'daytona', sessionId: SESSION, owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileKey: 'profile-one', sandboxId: SECOND, expiresAt: Date.now() + 60000, actionsUsed: 0, actionBudget: 10, effectUnknown: false, phase: 'ACTIVE' };
  const runtime = (await f.controller.adapter.forSession(SESSION))!;
  await assert.rejects(runtime.browser.execute('cto', SESSION, { type: 'snapshot' }, 20, 'a'.repeat(64)));
  assert.deepEqual(effects, []);
  f.controller.shutdown();
  await runtime.browser.stop('cto', SESSION, 'a'.repeat(64));
  assert.deepEqual(effects, ['stop']);
});
test('one durable unknown viewer scope remains fenced without suppressing another worker or replaying its mint', async () => {
  const f = fixture(pool), scopeHash = daytonaViewerPhysicalScopeHash(env.DAYTONA_BROWSER_ORGANIZATION_ID, SECOND);
  const binding = { provider: 'daytona' as const, owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: SECOND, profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
  f.state.scopeGrants.set(scopeHash, { version: 2, organizationId: env.DAYTONA_BROWSER_ORGANIZATION_ID, binding, scopeHash, bindingHash: daytonaViewerGrantBindingHash(env.DAYTONA_BROWSER_ORGANIZATION_ID, binding), grantHandle: randomUUID(), expiresAt: Date.now() - 1000, phase: 'MINTING' });
  assert.equal(await f.controller.initialize(), false);
  assert.equal(f.state.scheduled, 3); const runtime = (await f.controller.adapter.get())!; assert.ok(runtime);
  assert.equal((await runtime.browser.readiness('cto', 'profile-one', 'a'.repeat(64))).ready, true);
  f.state.sandbox = SECOND;
  await assert.rejects(runtime.browser.readiness('cto', 'profile-one', 'a'.repeat(64)));
  assert.equal(f.state.scopeGrants.get(scopeHash)!.phase, 'MINTING');
  f.controller.shutdown();
});
test('a degraded target worker refuses exchange and resume before the durable ticket phase changes', async () => {
  for (const phase of ['NEW', 'EXCHANGED'] as const) {
    const f = fixture(pool), token = 'A'.repeat(43), hash = createHash('sha256').update(token).digest('hex'), handle = randomUUID(), expiresAt = Date.now() + 60000;
    f.state.sandbox = SECOND;
    f.state.session = { provider: 'daytona', sessionId: SESSION, owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileKey: 'profile-one', sandboxId: SECOND, expiresAt, actionsUsed: 0, actionBudget: 10, effectUnknown: false, phase: 'ACTIVE', ...(phase === 'EXCHANGED' ? { viewerGrantHandle: handle, viewerExpiresAt: expiresAt, sensitiveOutputSuppressed: true } : {}) };
    f.state.tickets.set(hash, { owner: 'cto', principalHash: 'a'.repeat(64), sessionId: SESSION, expiresAt, phase, version: 0, ...(phase === 'EXCHANGED' ? { grantHandle: handle, grantExpiresAt: expiresAt } : {}) });
    f.state.scopeErrors.add(daytonaViewerPhysicalScopeHash(env.DAYTONA_BROWSER_ORGANIZATION_ID, SECOND));
    await f.controller.initialize(); const runtime = (await f.controller.adapter.get())!;
    const viewers = (runtime as unknown as { viewers: DaytonaViewerService }).viewers;
    await assert.rejects(phase === 'NEW' ? viewers.exchange(token) : viewers.resume(token));
    assert.equal(f.state.tickets.get(hash)!.phase, phase); assert.deepEqual(f.state.ticketTransitions, []);
    f.controller.shutdown();
  }
});
test('the separate sealed cleanup boundary completes and expires exact tickets while admission is opted out', async t => {
  const effects: string[] = [];
  t.mock.method(DaytonaBrowserService.prototype, 'stop', async () => { effects.push('stop'); });
  t.mock.method(DaytonaBrowserService.prototype, 'completeHumanInput', async () => { effects.push('complete'); return { status: 'saved', human_input_revoked: true } as const; });
  for (const operation of ['complete', 'expire'] as const) {
    const f = fixture({ ...pool, DAYTONA_BROWSER_ENABLED: undefined }), token = 'B'.repeat(43), hash = createHash('sha256').update(token).digest('hex'), handle = randomUUID(), expiresAt = Date.now() + (operation === 'expire' ? -1000 : 60000);
    f.state.sandbox = SECOND;
    f.state.session = { provider: 'daytona', sessionId: SESSION, owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileKey: 'profile-one', sandboxId: SECOND, expiresAt, actionsUsed: 0, actionBudget: 10, effectUnknown: false, phase: 'ACTIVE', viewerGrantHandle: handle, viewerExpiresAt: expiresAt, sensitiveOutputSuppressed: true };
    f.state.tickets.set(hash, { owner: 'cto', principalHash: 'a'.repeat(64), sessionId: SESSION, expiresAt, phase: 'EXCHANGED', version: 0, grantHandle: handle, grantExpiresAt: expiresAt });
    assert.equal(await f.controller.initialize(), false); assert.equal(await f.controller.adapter.get(), undefined);
    const runtime = (await f.controller.adapter.forSession(SESSION))!;
    const viewers = (runtime as unknown as { viewers: DaytonaViewerService }).viewers;
    const receipt = await viewers[operation](token);
    assert.equal(receipt.human_input_revoked, true);
    assert.equal(f.state.tickets.get(hash)!.phase, operation === 'complete' ? 'SAVED' : 'EXPIRED');
    assert.equal(f.state.scheduled, 0); f.controller.shutdown();
  }
  assert.deepEqual(effects, ['complete', 'stop']);
});
