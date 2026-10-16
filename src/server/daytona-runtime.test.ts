import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Fastify from 'fastify';
import { createDaytonaRuntimeController, type DaytonaRuntimeDependencies } from './daytona-runtime.js';
import type { DaytonaBrowserStore, DaytonaMission, DaytonaProvider } from '../tools/browser-daytona/contract.js';
import type { DaytonaViewerGrantRecord, DaytonaViewerGrantStore } from '../tools/browser-daytona/viewer-grant-store.js';
import { EncryptedDaytonaViewerGrantPort } from '../tools/browser-daytona/viewer-grants.js';
import { DaytonaBrowserService } from '../tools/browser-daytona/service.js';
import { daytonaViewerGrantBindingHash, daytonaViewerPhysicalScopeHash } from '../tools/browser-daytona/viewer-grant-store.js';
import type { DaytonaViewerTicket, DaytonaViewerTicketStore } from './daytona-viewer-service.js';
import type { DaytonaViewerService } from './daytona-viewer.js';
import { requestContext } from './request-context.js';
import type { DaytonaBinding } from '../tools/browser-daytona/contract.js';

const SESSION = randomUUID();
const env = { DAYTONA_BROWSER_ENABLED: 'true', DAYTONA_BROWSER_API_BASE_URL: 'https://app.daytona.io/api', DAYTONA_BROWSER_ORGANIZATION_ID: '501db94e-10ee-4bc8-9cca-23c793c67524', DAYTONA_BROWSER_SANDBOX_ID: '11111111-1111-4111-8111-111111111111', DAYTONA_VIEWER_GRANT_KEY_BASE64: randomBytes(32).toString('base64'), DAYTONA_BROWSER_VIEWER_CONTROL_SHA256: '17f61b92692760ae7908a3987b593180bed0e8bf2f9a52afb1fa80d9489dcce2', DAYTONA_BROWSER_API_TOKEN: 'SERVER_ONLY_PRIVATE_TEST_TOKEN', CLOUD_BROWSER_DDB_TABLE: 'browser-table', DAYTONA_BROWSER_PREVIEW_DOMAIN: 'proxy.daytona.works', DAYTONA_BROWSER_PREVIEW_PORT: '6080', DAYTONA_BROWSER_PREVIEW_PATH: '/vnc.html', DAYTONA_BROWSER_TOOLBOX_ALLOWED_ORIGINS: '["https://proxy.app.daytona.io"]' };

test('release packages the exact compiled lifecycle helper without changing the existing runtime assets', async () => {
  const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^COPY --chown=app:app tools\/daytona-browser-runtime\/role-browser-helper\.py \.\/tools\/daytona-browser-runtime\/role-browser-helper\.py$/m);
  const helper = await readFile(new URL('../../tools/daytona-browser-runtime/role-browser-helper.py', import.meta.url));
  assert.equal(createHash('sha256').update(helper).digest('hex'), 'e39a1e0f9df08ec6db68fea1d696eb6f860cd08878e062be562b463541c1a529');
});

test('seven-role map automatically enrolls watchdogs and rejects a role routed to another enrolled desktop before provider calls', async () => {
  const roles = ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director'];
  const agents = Object.fromEntries(roles.map((role, i) => [role, { sandboxId: `${i + 1}1111111-1111-4111-8111-111111111111`, readinessReceiptSha256: String(i + 1).repeat(64) }]));
  const f = fixture({ DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'true', DAYTONA_AGENT_DESKTOP_TEMPLATES: JSON.stringify({ schema: 'daytona-agent-desktops/v1', agents }) }, { withReady: async (_binding, run) => run(), tick: async () => {}, shutdown: () => {}, touch: async () => {} });
  f.state.bindings = new Map(); f.state.enrollmentReady = true;
  try {
    assert.equal(await f.controller.initialize(), true); assert.equal(f.state.scheduled, 8); assert.equal(new Set(f.state.scopeReads).size, 7); assert.equal(f.controller.status().enrollmentConfigured, true);
    const browser = (await f.controller.adapter.get())!.browser;
    const connection = '22222222-2222-4222-8222-222222222222';
    for (const owner of roles) {
      const principal = createHash('sha256').update(`${owner}\0connection:${connection}`).digest('hex');
      await requestContext.run({ callerAgent: owner, callerHash: 'a'.repeat(64), correlationId: 'synthetic', authKind: 'oauth', authSubject: 'signed-client', authConnectionId: connection }, () => browser.discover(owner, principal));
      assert.equal(f.state.bindings.get(`${owner}-${principal}`)!.sandboxId, agents[owner]!.sandboxId);
    }
    const cto = [...f.state.bindings.values()].find(binding => binding.owner === 'cto')!;
    cto.sandboxId = agents.cfo!.sandboxId;
    const probes = f.calls.filter(call => call === 'probe').length;
    await assert.rejects(browser.readiness('cto', cto.profileKey, cto.ownerSubjectHash));
    assert.equal(f.calls.filter(call => call === 'probe').length, probes);
  } finally { f.controller.shutdown(); }
});
test('invalid dedicated role map does not silently use shared enrollment or destroy legacy revocation watchdogs', async () => {
  const f = fixture({ DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'true', DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID: env.DAYTONA_BROWSER_SANDBOX_ID, DAYTONA_COMPANY_ENROLLMENT_READINESS_SHA256: 'b'.repeat(64), DAYTONA_AGENT_DESKTOP_TEMPLATES: '{"schema":"daytona-agent-desktops/v1","agents":{}}' });
  try {
    assert.equal(await f.controller.initialize(), true); assert.equal(f.state.scheduled, 1); assert.equal(f.controller.status().enrollmentConfigured, false);
    assert.deepEqual(f.controller.status().enrollmentMissing, ['DAYTONA_AGENT_DESKTOP_TEMPLATES']);
    await assert.rejects((await f.controller.adapter.get())!.browser.readiness('cto', 'profile-one', 'a'.repeat(64)));
    assert.equal(f.calls.includes('probe'), false);
  } finally { f.controller.shutdown(); }
});
test('dedicated readiness and start keep lifecycle admission through the real service call and schedule idle lifecycle without waking cleanup', async t => {
  let admitted = false, admissions = 0, ticks = 0, shutdowns = 0, touches = 0;
  const lifecycle = {
    withReady: async <T>(binding: DaytonaBinding, run: () => Promise<T>) => { assert.equal(binding.owner, 'cto'); admitted = true; admissions++; try { return await run(); } finally { admitted = false; } },
    tick: async () => { ticks++; }, shutdown: () => { shutdowns++; }, touch: async (binding: DaytonaBinding) => { assert.equal(admitted, false); assert.equal(binding.sandboxId, env.DAYTONA_BROWSER_SANDBOX_ID); touches++; },
  };
  const roles = ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director'];
  const agents = Object.fromEntries(roles.map((role, i) => [role, { sandboxId: `${i + 1}1111111-1111-4111-8111-111111111111`, readinessReceiptSha256: String(i + 1).repeat(64) }]));
  const f = fixture({ DAYTONA_AGENT_DESKTOP_TEMPLATES: JSON.stringify({ schema: 'daytona-agent-desktops/v1', agents }) }, lifecycle);
  const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileKey: `cto-${'a'.repeat(64)}`, sharedProfileKey: 'company-browser', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium', ...agents.cto! };
  f.state.bindings = new Map([[binding.profileKey, binding]]); f.state.enrollmentReady = true;
  f.state.session = { provider: 'daytona', sessionId: SESSION, owner: binding.owner, ownerSubjectHash: binding.ownerSubjectHash, profileKey: binding.profileKey, sandboxId: binding.sandboxId, expiresAt: Date.now() + 1000, actionsUsed: 0, actionBudget: 10, effectUnknown: false, phase: 'ACTIVE' };
  t.mock.method(DaytonaBrowserService.prototype, 'start', async () => { assert.equal(admitted, true); return { sessionId: SESSION, expiresAt: Date.now() + 1000 }; });
  t.mock.method(DaytonaBrowserService.prototype, 'readiness', async () => { assert.equal(admitted, true); return { ready: true, profileKey: binding.profileKey, profilePath: binding.profilePath, checkpointReady: true }; });
  t.mock.method(DaytonaBrowserService.prototype, 'stop', async () => { assert.equal(admitted, false); });
  await f.controller.initialize(); const browser = (await f.controller.adapter.get())!.browser;
  await browser.readiness('cto', binding.profileKey, binding.ownerSubjectHash);
  await browser.start('cto', binding.profileKey, 180, 5, binding.ownerSubjectHash);
  await assert.rejects(browser.start('cto', binding.profileKey, 0, 5, binding.ownerSubjectHash));
  await browser.stop('cto', SESSION, binding.ownerSubjectHash);
  assert.equal(touches, 1); assert.equal(admissions, 2); assert.ok(ticks > 0); f.controller.shutdown(); assert.equal(shutdowns, 1);
});
test('valid dedicated map with incompatible lifecycle configuration never falls back to an already-running desktop', async () => {
  const roles = ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director'];
  const agents = Object.fromEntries(roles.map((role, i) => [role, { sandboxId: `${i + 1}1111111-1111-4111-8111-111111111111`, readinessReceiptSha256: String(i + 1).repeat(64) }]));
  const f = fixture({ DAYTONA_AGENT_DESKTOP_TEMPLATES: JSON.stringify({ schema: 'daytona-agent-desktops/v1', agents }), DAYTONA_ROLE_LIFECYCLE_HELPER_SHA256: '0'.repeat(64) });
  const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileKey: `cto-${'a'.repeat(64)}`, sharedProfileKey: 'company-browser', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium', ...agents.cto! };
  f.state.bindings = new Map([[binding.profileKey, binding]]);
  try {
    assert.equal(await f.controller.initialize(), true); assert.equal(f.state.scheduled, 7);
    assert.equal(f.controller.status().enrollmentConfigured, false);
    assert.deepEqual(f.controller.status().enrollmentMissing, ['DAYTONA_AGENT_DESKTOP_TEMPLATES/LIFECYCLE']);
    await assert.rejects((await f.controller.adapter.get())!.browser.readiness('cto', binding.profileKey, binding.ownerSubjectHash));
    assert.equal(f.calls.includes('probe'), false); assert.equal(f.calls.includes('open'), false);
  } finally { f.controller.shutdown(); }
});

test('company enrollment uses only current OAuth context and exact healthy worker before existing alias discovery', async () => {
  const f = fixture({ DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'true', DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID: env.DAYTONA_BROWSER_SANDBOX_ID, DAYTONA_COMPANY_ENROLLMENT_READINESS_SHA256: 'b'.repeat(64) });
  f.state.bindings = new Map(); f.state.enrollmentReady = true;
  await f.controller.initialize(); const browser = (await f.controller.adapter.get())!.browser;
  assert.equal(f.controller.status().enrollmentConfigured, true); assert.deepEqual(f.controller.status().enrollmentMissing, []);
  const connection = '22222222-2222-4222-8222-222222222222';
  const principal = createHash('sha256').update(`cto\0connection:${connection}`).digest('hex');
  const own = <T>(run: () => T) => requestContext.run({ callerAgent: 'cto', callerHash: 'a'.repeat(64), correlationId: 'synthetic', authKind: 'oauth', authSubject: 'signed-client', authConnectionId: connection }, run);
  assert.equal((await own(() => browser.discover('cto', principal))).profileId, `cto-${principal}`);
  assert.equal(f.calls.filter(call => call === 'create-binding').length, 1);
  assert.equal((await own(() => browser.readiness('cto', `cto-${principal}`, principal))).checkpointReady, true);
  await assert.rejects(browser.discover('cto', principal));
  f.state.scopeError = true; f.state.tick!(); await new Promise(resolve => setImmediate(resolve));
  const count = f.calls.filter(call => call === 'probe').length;
  await assert.rejects(own(() => browser.discover('cto', principal)));
  assert.equal(f.calls.filter(call => call === 'probe').length, count); f.controller.shutdown();
});
test('malformed optional enrollment preserves the core watchdog but cannot create a binding', async () => {
  for (const invalid of [
    { DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'true', DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID: '22222222-2222-4222-8222-222222222222', DAYTONA_COMPANY_ENROLLMENT_READINESS_SHA256: 'b'.repeat(64) },
    { DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'yes' },
    { DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'true', DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID: env.DAYTONA_BROWSER_SANDBOX_ID },
  ]) {
    const f = fixture(invalid); f.state.bindings = new Map(); f.state.enrollmentReady = true;
    try {
      assert.equal(await f.controller.initialize(), true);
      assert.equal(f.controller.status().configured, true); assert.equal(f.controller.status().watchdogReady, true);
      assert.equal(f.controller.status().enrollmentConfigured, false);
      assert.deepEqual(f.controller.status().missing, []);
      assert.deepEqual(f.controller.status().enrollmentMissing, ['DAYTONA_COMPANY_ENROLLMENT_ENABLED/SANDBOX_ID/READINESS_SHA256']);
      assert.equal(f.state.scheduled, 1);
      const runtime = (await f.controller.adapter.get())!; assert.ok(runtime);
      const connection = '22222222-2222-4222-8222-222222222222';
      const principal = createHash('sha256').update(`cto\0connection:${connection}`).digest('hex');
      await assert.rejects(requestContext.run({ callerAgent: 'cto', callerHash: 'a'.repeat(64), correlationId: 'synthetic', authKind: 'oauth', authSubject: 'signed-client', authConnectionId: connection }, () => runtime.browser.discover('cto', principal)));
      assert.equal(f.state.bindings.size, 0); assert.equal(f.calls.includes('create-binding'), false);
      assert.equal(f.calls.includes('inspect'), false); assert.equal(f.calls.includes('probe'), false);
    } finally { f.controller.shutdown(); }
    assert.equal(f.state.cancelled, 1);
  }
});
test('malformed optional enrollment retains real HTTP cleanup routes for already-exchanged owned tickets', async t => {
  const effects: string[] = [];
  t.mock.method(DaytonaBrowserService.prototype, 'completeHumanInput', async (owner: string, id: string, principal: string) => {
    assert.deepEqual([owner, id, principal], ['cto', SESSION, 'a'.repeat(64)]);
    effects.push('complete'); return { status: 'saved', human_input_revoked: true } as const;
  });
  t.mock.method(DaytonaBrowserService.prototype, 'stop', async (owner: string, id: string, principal: string) => {
    assert.deepEqual([owner, id, principal], ['cto', SESSION, 'a'.repeat(64)]); effects.push('expire');
  });
  for (const operation of ['complete', 'expire'] as const) {
    const f = fixture({ DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'true', DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID: 'foreign' });
    const token = 'C'.repeat(43), hash = createHash('sha256').update(token).digest('hex'), selector = hash.slice(0, 32), handle = randomUUID();
    const expiresAt = Date.now() + (operation === 'expire' ? -1000 : 60000);
    f.state.session = { provider: 'daytona', sessionId: SESSION, owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileKey: 'profile-one', sandboxId: env.DAYTONA_BROWSER_SANDBOX_ID, expiresAt, actionsUsed: 0, actionBudget: 10, effectUnknown: false, phase: 'ACTIVE', viewerGrantHandle: handle, viewerExpiresAt: expiresAt, sensitiveOutputSuppressed: true };
    f.state.tickets.set(hash, { owner: 'cto', principalHash: 'a'.repeat(64), sessionId: SESSION, expiresAt, phase: 'EXCHANGED', version: 0, grantHandle: handle, grantExpiresAt: expiresAt });
    const app = Fastify();
    try {
      assert.equal(await f.controller.registerRoutes(app), true);
      assert.equal(f.state.scheduled, 1); assert.equal(f.controller.status().watchdogReady, true);
      const response = await app.inject({ method: 'POST', url: `/browser/daytona/${operation}`, headers: { origin: 'https://mcp.otchealth.app', cookie: `__Host-otc-daytona-login-${selector}=${token}` }, payload: { handoff_id: selector } });
      assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { status: operation === 'complete' ? 'saved' : 'expired', human_input_revoked: true });
      assert.equal(f.state.tickets.get(hash)!.phase, operation === 'complete' ? 'SAVED' : 'EXPIRED');
      assert.deepEqual(f.state.ticketTransitions, operation === 'complete' ? ['COMPLETING', 'SAVED'] : ['EXPIRING', 'EXPIRED']);
      assert.equal(f.calls.includes('create-binding'), false);
    } finally { await app.close(); f.controller.shutdown(); }
    assert.equal(f.state.cancelled, 1);
  }
  assert.deepEqual(effects, ['complete', 'expire']);
});
test('misconfigured new enrollment cannot destroy sealed cleanup routing after opt-out', async () => {
  const f = fixture({ DAYTONA_BROWSER_ENABLED: undefined, DAYTONA_BROWSER_SANDBOX_ID: undefined, DAYTONA_BROWSER_PREVIEW_PATH: undefined, DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'true', DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID: 'foreign' });
  f.state.session = { provider: 'daytona', sessionId: SESSION, owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileKey: 'profile-one', sandboxId: env.DAYTONA_BROWSER_SANDBOX_ID, expiresAt: 1900000300000, actionsUsed: 0, actionBudget: 10, effectUnknown: false, phase: 'ACTIVE' };
  assert.equal(await f.controller.adapter.get(), undefined);
  assert.equal(typeof (await f.controller.adapter.forSession(SESSION))!.browser.stop, 'function');
  assert.equal(f.calls.includes('create-binding'), false); f.controller.shutdown();
});
function fixture(overrides: NodeJS.ProcessEnv = {}, lifecycle?: DaytonaRuntimeDependencies['lifecycle']) {
  const calls: string[] = [];
  const state = { enrollmentReady: false, bindings: undefined as Map<string, DaytonaBinding> | undefined, checkpoint: true, lookupError: false, scopeError: false, scopeErrors: new Set<string>(), scopeReads: [] as string[], scopeGrants: new Map<string, DaytonaViewerGrantRecord>(), tickets: new Map<string, DaytonaViewerTicket>(), ticketTransitions: [] as string[], ticks: [] as (() => void)[], scheduleFails: false, uploadConfigured: false, captureConfigured: false, sandbox: env.DAYTONA_BROWSER_SANDBOX_ID, scheduled: 0, cancelled: 0, tick: undefined as (() => void) | undefined, session: null as DaytonaMission | null };
  const store: DaytonaBrowserStore = {
    loadBinding: async profileKey => state.bindings ? state.bindings.get(profileKey) ?? null : ({ provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: state.sandbox, profileKey, profilePath: `/home/otcbrowser/.local/share/otchealth-browser/${profileKey}/chromium`, readinessReceiptSha256: 'b'.repeat(64) }), createBinding: async binding => { calls.push('create-binding'); if (!state.bindings || state.bindings.has(binding.profileKey)) return false; state.bindings.set(binding.profileKey, { ...binding }); return true; },
    loadSession: async () => { calls.push('load'); if (state.lookupError) throw new Error('private-store-error'); return state.session; },
    createSession: async () => false, saveSessionUnderLock: async () => {}, acquireSessionLock: async () => false, releaseSessionLock: async () => {},
    acquireProfileLease: async () => false, ownsProfileLease: async () => false, releaseProfileLease: async () => {},
  };
  const provider: DaytonaProvider & { capabilities: { checkpoint: boolean } } = {
    capabilities: { checkpoint: false },
    probe: async binding => { calls.push('probe'); return { ready: true, profileKey: binding.profileKey, profilePath: binding.profilePath, checkpointReady: state.checkpoint, ...(state.enrollmentReady ? { browserPid: 101, supervisorPid: 100, runtimeProtocol: 2 as const, multiMissionReady: true } : {}) }; },
    inspect: async binding => { calls.push('inspect'); if (state.enrollmentReady) return { sandboxId: binding.sandboxId, public: false, state: 'started' }; throw new Error('must not call provider in factory'); },
    openMission: async () => { calls.push('open'); }, execute: async () => { calls.push('execute'); }, checkpoint: async () => { calls.push('checkpoint'); }, releaseMission: async () => { calls.push('release'); },
    viewerGrant: async () => { throw new Error('no grant'); }, readViewerGrant: async () => { throw new Error('no read'); }, revokeViewerGrant: async () => { throw new Error('no revoke'); },
  };
  const grants: DaytonaViewerGrantStore = { reserve: async () => { throw new Error('no mint'); }, load: async handle => [...state.scopeGrants.values()].find(row => row.grantHandle === handle) ?? null, compareAndSwap: async () => { throw new Error('no write'); }, readPhysicalScope: async scope => { calls.push('scope'); state.scopeReads.push(scope); if (state.scopeError || state.scopeErrors.has(scope)) throw new Error('PRIVATE_BACKEND_ERROR'); return state.scopeGrants.get(scope)?.grantHandle ?? null; } };
  const tickets: DaytonaViewerTicketStore = { create: async (hash, row) => { if (state.tickets.has(hash)) return false; state.tickets.set(hash, structuredClone(row)); return true; }, load: async hash => structuredClone(state.tickets.get(hash) ?? null), transition: async (hash, phase, row) => { const current = state.tickets.get(hash); if (current?.phase !== phase || row.version !== current.version + 1) return false; state.ticketTransitions.push(row.phase); state.tickets.set(hash, structuredClone(row)); return true; }, acquireMissionLease: async () => true, ownsMissionLease: async () => true, releaseMissionLease: async () => {} };
  const controller = createDaytonaRuntimeController({ env: { ...env, ...overrides }, ...(lifecycle ? { lifecycle } : {}), createTickets: () => tickets, createGrantStore: () => grants, createStore: () => { calls.push('store'); return store; }, createProvider: options => { assert.equal(options.organizationId, env.DAYTONA_BROWSER_ORGANIZATION_ID); state.uploadConfigured = typeof options.files?.forUpload === 'function'; state.captureConfigured = typeof options.captures?.createCapture === 'function'; if (!Object.hasOwn(overrides, 'DAYTONA_BROWSER_PREVIEW_PATH')) assert.ok(options.viewer instanceof EncryptedDaytonaViewerGrantPort); calls.push('provider'); return provider; },
    scheduleTick: (tick, milliseconds) => { assert.equal(milliseconds, 1000); if (state.scheduleFails) throw new Error('PRIVATE_SCHEDULER_ERROR'); state.scheduled++; state.tick = tick; state.ticks.push(tick); return () => { state.cancelled++; }; }, onWatchdogStatus: () => {} });
  return { controller, calls, state, store, provider };
}

test('dedicated company start holds one admission through enrollment and the real final service readiness guard', async () => {
  for (const existing of [false, true]) {
    let admissions = 0, admitted = false, reserved = 0, wakeUnknown = false;
    const roles = ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director'];
    const agents = Object.fromEntries(roles.map((role, i) => [role, { sandboxId: `${i + 1}1111111-1111-4111-8111-111111111111`, readinessReceiptSha256: String(i + 1).repeat(64) }]));
    const f = fixture({ DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'true', DAYTONA_AGENT_DESKTOP_TEMPLATES: JSON.stringify({ schema: 'daytona-agent-desktops/v1', agents }) }, {
      withReady: async (_binding, run, options) => { if (wakeUnknown) throw new Error('owned wake remains unknown'); admissions++; reserved = options?.maxSeconds ?? 0; admitted = true; try { return await run(); } finally { admitted = false; } },
      tick: async () => {}, touch: async () => {}, shutdown: () => {},
    });
    const connection = '22222222-2222-4222-8222-222222222222';
    const principal = createHash('sha256').update(`cto\0connection:${connection}`).digest('hex');
    const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: principal, profileKey: `cto-${principal}`, sharedProfileKey: 'company-browser', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium', ...agents.cto! };
    f.state.bindings = new Map(existing ? [[binding.profileKey, binding]] : []); f.state.enrollmentReady = true;
    f.store.acquireProfileLease = async () => true; f.store.acquireSessionLock = async () => true;
    f.store.createSession = async session => { assert.equal(admitted, true); f.state.session = structuredClone(session); return true; };
    f.store.saveSessionUnderLock = async session => { f.state.session = structuredClone(session); };
    const originalProbe = f.provider.probe!;
    f.provider.probe = async binding => { assert.equal(admitted, true); return originalProbe(binding); };
    const originalOpen = f.provider.openMission;
    f.provider.openMission = async (...args) => { assert.equal(admitted, true); return originalOpen(...args); };
    try {
      await f.controller.initialize(); const browser = (await f.controller.adapter.get())!.browser;
      assert.equal(typeof browser.startCompany, 'function');
      const start = browser.startCompany!;
      const ownStart = () => requestContext.run({ callerAgent: 'cto', callerHash: 'a'.repeat(64), correlationId: 'synthetic', authKind: 'oauth', authSubject: 'signed-client', authConnectionId: connection }, () => start('cto', 600, 5, principal));
      const result = await ownStart();
      assert.equal(result.runtimeProtocol, 2); assert.equal(admissions, 1); assert.equal(reserved, 600);
      assert.equal(f.calls.filter(call => call === 'probe').length, existing ? 1 : 2);
      assert.equal(f.calls.filter(call => call === 'create-binding').length, existing ? 0 : 1);
      assert.equal(f.calls.filter(call => call === 'open').length, 1);
      // Readiness is not cached: the next final service proof can forbid V1
      // before any new logical mission even though enrollment is unchanged.
      f.calls.length = 0;
      f.provider.probe = async binding => { assert.equal(admitted, true); return { ready: true, profileKey: binding.profileKey, profilePath: binding.profilePath, checkpointReady: true }; };
      await assert.rejects(ownStart(), error => (error as { code?: string }).code === 'daytona_multimission_unavailable');
      assert.equal(admissions, 2); assert.equal(f.calls.includes('open'), false); assert.equal(f.calls.includes('create-binding'), false);
      f.calls.length = 0; wakeUnknown = true;
      await assert.rejects(ownStart(), /wake remains unknown/);
      assert.equal(admissions, 2); assert.equal(f.calls.includes('probe'), false); assert.equal(f.calls.includes('open'), false);
      assert.equal(f.calls.includes('create-binding'), false);
      await assert.rejects(start('cto', 600, 5, principal)); // missing signed request context
      assert.equal(admissions, 2);
    } finally { f.controller.shutdown(); }
  }
});

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
  assert.equal(f.controller.status().enrollmentConfigured, false); assert.deepEqual(f.controller.status().enrollmentMissing, []);
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
