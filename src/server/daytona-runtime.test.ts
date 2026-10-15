import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { createDaytonaRuntimeController } from './daytona-runtime.js';
import type { DaytonaBrowserStore, DaytonaMission, DaytonaProvider } from '../tools/browser-daytona/contract.js';

const SESSION = randomUUID();
const env = { DAYTONA_BROWSER_ENABLED: 'true', DAYTONA_BROWSER_API_BASE_URL: 'https://app.daytona.io/api', DAYTONA_BROWSER_ORGANIZATION_ID: '501db94e-10ee-4bc8-9cca-23c793c67524', DAYTONA_BROWSER_API_TOKEN: 'SERVER_ONLY_PRIVATE_TEST_TOKEN', CLOUD_BROWSER_DDB_TABLE: 'browser-table', DAYTONA_BROWSER_PREVIEW_DOMAIN: 'proxy.daytona.works', DAYTONA_BROWSER_PREVIEW_PORT: '6080', DAYTONA_BROWSER_PREVIEW_PATH: '/vnc.html', DAYTONA_BROWSER_TOOLBOX_ALLOWED_ORIGINS: '["https://proxy.app.daytona.io"]' };
function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const calls: string[] = [];
  const state = { checkpoint: true, lookupError: false, session: null as DaytonaMission | null };
  const store: DaytonaBrowserStore = {
    loadBinding: async () => null, createBinding: async () => false,
    loadSession: async () => { calls.push('load'); if (state.lookupError) throw new Error('private-store-error'); return state.session; },
    createSession: async () => false, saveSessionUnderLock: async () => {}, acquireSessionLock: async () => false, releaseSessionLock: async () => {},
    acquireProfileLease: async () => false, ownsProfileLease: async () => false, releaseProfileLease: async () => {},
  };
  const provider: DaytonaProvider & { capabilities: { checkpoint: boolean } } = {
    get capabilities() { return { checkpoint: state.checkpoint }; },
    inspect: async () => { calls.push('inspect'); throw new Error('must not call provider in factory'); },
    openMission: async () => { calls.push('open'); }, execute: async () => { calls.push('execute'); }, checkpoint: async () => { calls.push('checkpoint'); }, releaseMission: async () => { calls.push('release'); },
    viewerGrant: async () => { throw new Error('no grant'); }, readViewerGrant: async () => { throw new Error('no read'); }, revokeViewerGrant: async () => { throw new Error('no revoke'); },
  };
  const viewer = { mint: provider.viewerGrant.bind(provider), read: provider.readViewerGrant.bind(provider), revoke: provider.revokeViewerGrant.bind(provider) };
  const controller = createDaytonaRuntimeController({ env: { ...env, ...overrides }, viewer: () => viewer, createStore: () => { calls.push('store'); return store; }, createProvider: options => { assert.equal(options.organizationId, env.DAYTONA_BROWSER_ORGANIZATION_ID); calls.push('provider'); return provider; } });
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

test('Daytona runtime composes real service+handoff and private route once without provider calls; unsupported checkpoint gates before effects', async () => {
  const f = fixture();
  const runtime = await f.controller.adapter.get();
  assert.ok(runtime);
  assert.equal(runtime, await f.controller.adapter.get());
  assert.deepEqual(f.calls, ['provider','store']);
  const app = Fastify();
  try { assert.equal(await f.controller.registerRoutes(app), true); assert.equal((await app.inject('/browser/daytona')).statusCode, 200); }
  finally { await app.close(); }
  const unavailable = fixture(); unavailable.state.checkpoint = false;
  assert.equal((await unavailable.controller.adapter.get())?.capabilities.checkpoint, false);
  const closed = Fastify();
  try { assert.equal(await unavailable.controller.registerRoutes(closed), false); assert.equal((await closed.inject('/browser/daytona')).statusCode, 404); }
  finally { await closed.close(); }
  assert.deepEqual(unavailable.calls, ['provider','store']);
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
