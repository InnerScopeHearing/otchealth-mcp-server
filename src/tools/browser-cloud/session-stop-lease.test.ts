import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudBrowserError, type CloudBrowserProfile, type CloudBrowserSession, type CloudBrowserStore, type CloudBrowserTransport } from './contract.js';
import { CloudBrowserService } from './service.js';
import { WebsiteLoginService, websitePrincipalHash, websiteProfileId } from './website-login-service.js';
import type { WebsiteLoginTicketStore } from './website-login-store.js';
import type { AgentCoreCloudBrowserTransport } from './agentcore-transport.js';
import type { IntercomProfileProvider } from './intercom-profile-provider.js';

function harness() {
  let now = 1_700_000_000_000;
  const owner = 'cto';
  const key = 'connection:stop-lease-test';
  const principal = websitePrincipalHash(owner, key);
  const profileId = websiteProfileId(owner, principal, 'linkedin');
  const profile: CloudBrowserProfile = { profileId, owner, ownerSubjectHash: principal, allowedHosts: ['www.linkedin.com'], persistent: true, providerProfileId: 'owned-profile', maxSessionSeconds: 3600 };
  const sessions = new Map<string, CloudBrowserSession>();
  const leases = new Map<string, string>();
  const locks = new Map<string, string>();
  const events: string[] = [];
  const state = { starts: 0, stops: 0, stopEffects: 0, leaseReleases: 0, releaseFailures: 0, deleteFailures: 0, markerFailures: 0, ambiguousStop: false, stopTokens: [] as Array<string | undefined>, actionCalls: 0 };
  const completedStopTokens = new Set<string>();
  const store = {
    loadProfile: async (id: string) => id === profileId ? profile : null,
    loadSession: async (id: string) => { const session = sessions.get(id); return session ? { ...session } : null; },
    saveSession: async (session: CloudBrowserSession) => { sessions.set(session.sessionId, { ...session }); },
    saveSessionUnderLock: async (session: CloudBrowserSession, lockOwner: string) => {
      assert.equal(locks.get(session.sessionId), lockOwner);
      if (session.providerStopped && state.markerFailures-- > 0) throw new Error('stopped receipt write unavailable');
      events.push(session.providerStopped ? 'persist-stopped' : 'persist-intent');
      sessions.set(session.sessionId, { ...session });
    },
    verifyLoginLease: async (id: string, leaseOwner?: string) => !leases.has(id) || leases.get(id) === leaseOwner,
    releaseStoppedLoginLease: async (session: CloudBrowserSession, lockOwner: string) => {
      assert.equal(locks.get(session.sessionId), lockOwner);
      assert.equal(session.providerStopped, true);
      assert.equal(session.owner, owner);
      assert.equal(session.ownerSubjectHash, principal);
      assert.equal(session.profileId, profileId);
      state.leaseReleases += 1;
      events.push('release-login-lease');
      if (state.releaseFailures-- > 0) throw new Error('lease release unavailable');
      if (leases.get(session.profileId) === session.loginLeaseOwner) leases.delete(session.profileId);
    },
    acquireSessionLock: async (id: string, lockOwner: string) => { if (locks.has(id)) return false; locks.set(id, lockOwner); return true; },
    releaseSessionLock: async (id: string, lockOwner: string) => { if (locks.get(id) === lockOwner) locks.delete(id); },
    acquireProfileLock: async () => true,
    releaseProfileLock: async () => {},
    reserveDailySession: async () => true,
    deleteSession: async (id: string) => {
      events.push('delete-session');
      if (state.deleteFailures-- > 0) throw new Error('session delete unavailable');
      sessions.delete(id);
    },
    claimExpiredSessionCleanup: async (id: string, inputOwner: string, at: number, lockOwner: string) => {
      const session = sessions.get(id);
      if (!session || session.owner !== inputOwner || session.expiresAt > at || locks.has(id)) return false;
      locks.set(id, lockOwner); return true;
    },
    deleteExpiredSessionUnderLock: async (id: string, inputOwner: string, lockOwner: string) => {
      const session = sessions.get(id);
      if (!session || session.owner !== inputOwner || locks.get(id) !== lockOwner) return false;
      events.push('delete-session'); sessions.delete(id); return true;
    },
  } as unknown as CloudBrowserStore;
  const transport = {
    start: async () => ({ providerSessionId: `provider-session-${++state.starts}`, providerBrowserId: 'aws.browser.v1', automationEndpoint: 'wss://provider.example/automation' }),
    execute: async () => { state.actionCalls++; return null; },
    stop: async (session: CloudBrowserSession) => {
      state.stops++;
      state.stopTokens.push(session.providerStopToken);
      events.push('stop-provider');
      if (state.ambiguousStop) throw new Error('provider stop acknowledgement unknown');
      if (!session.providerStopToken || !completedStopTokens.has(session.providerStopToken)) state.stopEffects++;
      if (session.providerStopToken) completedStopTokens.add(session.providerStopToken);
    },
    prepareWebsiteLogin: async () => {},
  } as unknown as CloudBrowserTransport & AgentCoreCloudBrowserTransport;
  const ticketStore = {
    acquireProfileLease: async (id: string, leaseOwner: string) => { if (leases.has(id)) return false; leases.set(id, leaseOwner); return true; },
    releaseProfileLease: async (id: string, leaseOwner: string) => { if (leases.get(id) === leaseOwner) leases.delete(id); },
    ownsProfileLease: async (id: string, leaseOwner: string) => leases.get(id) === leaseOwner,
    create: async () => {},
  } as unknown as WebsiteLoginTicketStore;
  const provider = { setAutomationStreamStatus: async (input: unknown) => input } as unknown as IntercomProfileProvider;
  const browser = new CloudBrowserService(store, transport, () => now);
  const login = new WebsiteLoginService(store, browser, transport, provider, ticketStore, () => now);
  return { browser, login, store, transport, owner, key, principal, profileId, sessions, leases, events, state, advance: (ms: number) => { now += ms; } };
}

test('normal owned stop persists the exact login lease binding and releases it before deleting session metadata, permitting another login', async () => {
  const h = harness();
  const started = await h.login.start(h.owner, h.key, 'linkedin');
  assert.equal(h.sessions.get(started.session_id)?.loginLeaseOwner, h.leases.get(h.profileId));
  await h.browser.stop(h.owner, started.session_id, h.principal);
  assert.equal(h.leases.has(h.profileId), false);
  assert.equal(h.sessions.has(started.session_id), false);
  assert.ok(h.events.indexOf('persist-stopped') > h.events.indexOf('stop-provider'));
  assert.ok(h.events.indexOf('release-login-lease') > h.events.indexOf('persist-stopped'));
  assert.ok(h.events.indexOf('delete-session') > h.events.indexOf('release-login-lease'));
  const next = await h.login.start(h.owner, h.key, 'linkedin');
  assert.notEqual(next.session_id, started.session_id);
});

test('ambiguous provider stop preserves the exact lease, session metadata and sensitive-output suppression', async () => {
  const h = harness();
  const started = await h.login.start(h.owner, h.key, 'linkedin');
  const leaseOwner = h.leases.get(h.profileId);
  h.state.ambiguousStop = true;
  await assert.rejects(h.browser.stop(h.owner, started.session_id, h.principal), /acknowledgement unknown/);
  assert.equal(h.leases.get(h.profileId), leaseOwner);
  assert.equal(h.sessions.get(started.session_id)?.sensitiveOutputSuppressed, true);
  assert.notEqual(h.sessions.get(started.session_id)?.providerStopped, true);
  assert.equal(h.state.leaseReleases, 0);
});

test('foreign agent or principal cannot stop the provider or release its login lease', async () => {
  const h = harness();
  const started = await h.login.start(h.owner, h.key, 'linkedin');
  for (const [caller, principal] of [['coo', h.principal], [h.owner, 'b'.repeat(64)]]) {
    await assert.rejects(h.browser.stop(caller, started.session_id, principal), (error: unknown) => error instanceof CloudBrowserError && error.code === 'owner_forbidden');
  }
  assert.equal(h.state.stops, 0);
  assert.equal(h.state.leaseReleases, 0);
  assert.equal(h.leases.has(h.profileId), true);
});

test('lease release failure retains a stopped receipt so explicit cleanup retry never stops the provider twice', async () => {
  const h = harness();
  const started = await h.login.start(h.owner, h.key, 'linkedin');
  h.state.releaseFailures = 1;
  await assert.rejects(h.browser.stop(h.owner, started.session_id, h.principal), /lease release unavailable/);
  assert.equal(h.sessions.get(started.session_id)?.providerStopped, true);
  assert.equal(h.sessions.get(started.session_id)?.sensitiveOutputSuppressed, true);
  assert.equal(h.leases.has(h.profileId), true);
  await assert.rejects(h.browser.snapshot(h.owner, started.session_id, h.principal), (error: unknown) => error instanceof CloudBrowserError && error.code === 'session_stopped');
  await h.browser.stop(h.owner, started.session_id, h.principal);
  assert.equal(h.state.stops, 1);
  assert.equal(h.state.actionCalls, 0);
  assert.equal(h.leases.size, 0);
  assert.equal(h.sessions.has(started.session_id), false);
});

test('retrying an old stopped session after deletion failure cannot release a newer login lease', async () => {
  const h = harness();
  const first = await h.login.start(h.owner, h.key, 'linkedin');
  const firstLease = h.leases.get(h.profileId);
  h.state.deleteFailures = 1;
  await assert.rejects(h.browser.stop(h.owner, first.session_id, h.principal), /delete unavailable/);
  const next = await h.login.start(h.owner, h.key, 'linkedin');
  const nextLease = h.leases.get(h.profileId);
  assert.notEqual(nextLease, firstLease);
  await h.browser.stop(h.owner, first.session_id, h.principal);
  assert.equal(h.state.stops, 1);
  assert.equal(h.leases.get(h.profileId), nextLease);
  assert.equal(h.sessions.has(next.session_id), true);
});

test('a failed stopped-receipt write keeps durable stop idempotency metadata for a safe explicit retry', async () => {
  const h = harness();
  const started = await h.login.start(h.owner, h.key, 'linkedin');
  h.state.markerFailures = 1;
  await assert.rejects(h.browser.stop(h.owner, started.session_id, h.principal), /receipt write unavailable/);
  assert.equal(h.leases.has(h.profileId), true);
  assert.match(h.sessions.get(started.session_id)?.providerStopToken ?? '', /^[a-f0-9-]{36}$/);
  await h.browser.stop(h.owner, started.session_id, h.principal);
  assert.equal(h.state.stops, 2);
  assert.equal(h.state.stopEffects, 1);
  assert.equal(h.state.stopTokens[0], h.state.stopTokens[1]);
  assert.equal(h.leases.size, 0);
});

test('exact-ID expiry cleanup also releases only its confirmed stopped login lease', async () => {
  const h = harness();
  const started = await h.login.start(h.owner, h.key, 'linkedin', undefined, { maxSeconds: 180 });
  h.advance(180_001);
  await assert.rejects(h.browser.snapshot(h.owner, started.session_id, h.principal), (error: unknown) => error instanceof CloudBrowserError && error.code === 'session_expired');
  assert.equal(h.state.stops, 1);
  assert.equal(h.leases.size, 0);
  assert.equal(h.sessions.has(started.session_id), false);
});

test('legacy session without a trusted lease token never guesses or deletes a profile-level login lease', async () => {
  const h = harness();
  const started = await h.login.start(h.owner, h.key, 'linkedin');
  delete h.sessions.get(started.session_id)!.loginLeaseOwner;
  await h.browser.stop(h.owner, started.session_id, h.principal);
  assert.equal(h.state.stops, 1);
  assert.equal(h.state.leaseReleases, 0);
  assert.equal(h.leases.has(h.profileId), true);
});
