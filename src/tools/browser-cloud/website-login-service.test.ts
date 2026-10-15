import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudBrowserError, type CloudBrowserProfile, type CloudBrowserSession, type CloudBrowserStore } from './contract.js';
import type { CloudBrowserService } from './service.js';
import type { AgentCoreCloudBrowserTransport } from './agentcore-transport.js';
import type { IntercomProfileProvider } from './intercom-profile-provider.js';
import type { WebsiteLoginTicket, WebsiteLoginTicketStore, CreateWebsiteLoginTicket } from './website-login-store.js';
import { WebsiteLoginService, websitePrincipalHash, websiteProfileId } from './website-login-service.js';
import { intercomPrincipalHash } from './intercom-login-service.js';
import { resolveWebsiteLoginTarget, type WebsiteLoginTarget } from './website-login-policy.js';

const now = 1_700_000_000_000;
const key = 'connection:synthetic-owner';
const hasCode = (code: string) => (error: unknown) => error instanceof CloudBrowserError && error.code === code;
function fixture() {
  const profiles = new Map<string, CloudBrowserProfile>();
  const sessions = new Map<string, CloudBrowserSession>();
  const tickets = new Map<string, WebsiteLoginTicket>();
  const leases = new Map<string, string>();
  const leaseUntil = new Map<string, number>();
  const sessionLocks = new Map<string, string>();
  const state = { creates: 0, starts: 0, saves: 0, stops: 0, signs: 0, prepares: 0, verifies: 0, profileReads: 0, releaseCalls: 0, releaseFailures: 0, clockOffsetMs: 0, profileLookupAdvanceMs: 0, prepareAdvanceMs: 0, signAdvanceMs: 0, stealLeaseBeforeRenew: false, startError: undefined as Error | undefined, sessionExpiresAt: undefined as number | undefined, streamFailure: undefined as 'DISABLED' | 'ENABLED' | undefined, streamReceiptMismatch: false, createFails: false, prepareFails: false, verifyFails: false, saveFails: false, stopFails: false, suppressionSeen: [] as boolean[], names: [] as string[], startOptions: [] as Array<{ maxSeconds: number; actionBudget: number | undefined }>, leaseExpiries: [] as number[], leaseRenewals: [] as number[], signedLifetimes: [] as number[], flow: [] as string[], streamRequests: [] as Array<{ browserIdentifier: string; sessionId: string; streamStatus: 'DISABLED' | 'ENABLED'; suppressed: boolean }>, verifyEndpoints: [] as string[] };
  const controls = { streamGate: undefined as Promise<void> | undefined, gateStatus: 'DISABLED' as 'DISABLED' | 'ENABLED', enteredStream: undefined as (() => void) | undefined, onAcquire: undefined as (() => void) | undefined, fencedEndpointWrites: 0, lockDeadlines: [] as number[], unknownWrites: [] as boolean[], failUnknownWrite: undefined as 'intent' | 'clear' | 'clear-after-commit' | undefined };
  const store = {
    loadProfile: async (id: string) => { state.profileReads++; state.clockOffsetMs += state.profileLookupAdvanceMs; return profiles.get(id) ?? null; },
    createProfileIntent: async (profile: CloudBrowserProfile) => {
      if (profiles.has(profile.profileId)) return false;
      profiles.set(profile.profileId, { ...profile }); return true;
    },
    loadSession: async (id: string) => { const session = sessions.get(id); return session ? { ...session } : null; },
    saveSession: async (session: CloudBrowserSession) => { state.flow.push(session.automationEndpoint.endsWith('/resumed') ? 'persist-resumed' : 'persist-prepared'); sessions.set(session.sessionId, { ...session }); },
    acquireSessionLock: async (id: string, owner: string, until: number) => { controls.onAcquire?.(); if (sessionLocks.has(id)) return false; controls.lockDeadlines.push(until); sessionLocks.set(id, owner); return true; },
    releaseSessionLock: async (id: string, owner: string) => { if (sessionLocks.get(id) === owner) sessionLocks.delete(id); },
    saveSessionUnderLock: async (session: CloudBrowserSession, owner: string) => {
      assert.equal(sessionLocks.get(session.sessionId), owner);
      if ((controls.failUnknownWrite === 'intent' && session.effectUnknown === true) || (controls.failUnknownWrite === 'clear' && session.effectUnknown === false)) throw new Error('session store acknowledgement unknown');
      if (session.effectUnknown !== undefined) controls.unknownWrites.push(session.effectUnknown);
      if (session.automationEndpoint.endsWith('/resumed')) { controls.fencedEndpointWrites++; state.flow.push('persist-resumed'); }
      sessions.set(session.sessionId, { ...session });
      if (controls.failUnknownWrite === 'clear-after-commit' && session.effectUnknown === false) throw new Error('committed session clear acknowledgement lost');
    },
  } as unknown as CloudBrowserStore;
  const browser = {
    saveProfile: async (_owner: string, profile: CloudBrowserProfile) => { profiles.set(profile.profileId, { ...profile }); },
    start: async (owner: string, profileId: string, maxSeconds: number, actionBudget: number | undefined, ownerSubjectHash: string) => {
      if (state.startError) throw state.startError;
      state.startOptions.push({ maxSeconds, actionBudget });
      const profile = profiles.get(profileId)!;
      const sessionId = `session-${++state.starts}`;
      const session: CloudBrowserSession = { sessionId, owner, ownerSubjectHash, profileId, allowedHosts: profile.allowedHosts, expiresAt: state.sessionExpiresAt ?? now + state.clockOffsetMs + maxSeconds * 1000, actionsUsed: 0, providerSessionId: `remote-${sessionId}`, providerBrowserId: 'aws.browser.v1', automationEndpoint: 'wss://synthetic.example/automation' };
      sessions.set(sessionId, session); return { sessionId, expiresAt: session.expiresAt };
    },
    beginSensitiveOutputSuppression: async (_owner: string, id: string) => { sessions.get(id)!.sensitiveOutputSuppressed = true; },
    endSensitiveOutputSuppression: async () => { throw new Error('login must not unmask'); },
    savePersistentProfile: async (_owner: string, id: string) => { state.flow.push('save-profile'); state.saves++; state.suppressionSeen.push(sessions.get(id)!.sensitiveOutputSuppressed === true); if (state.saveFails) throw new Error('save acknowledgement unknown'); },
    stop: async (_owner: string, id: string) => { assert.equal(sessionLocks.has(id), false, 'stop must acquire its own lock after the viewer fence is released'); state.flow.push('stop'); state.stops++; state.suppressionSeen.push(sessions.get(id)?.sensitiveOutputSuppressed === true); if (state.stopFails) throw new Error('stop unavailable'); sessions.delete(id); },
  } as unknown as CloudBrowserService;
  const provider = {
    createProfile: async (input: { name: string }) => { state.creates++; state.names.push(input.name); if (state.createFails) throw new Error('create acknowledgement unknown'); return { providerProfileId: `${input.name}-created123` }; },
    generateLiveViewUrl: async (input: { expiresIn: number }) => { state.flow.push('live-view'); state.signs++; state.signedLifetimes.push(input.expiresIn); state.clockOffsetMs += state.signAdvanceMs; return { url: 'https://synthetic.example/live?signature=opaque', expiresIn: input.expiresIn }; },
    setAutomationStreamStatus: async (input: { browserIdentifier: string; sessionId: string; streamStatus: 'DISABLED' | 'ENABLED' }) => {
      state.flow.push(`stream-${input.streamStatus}`);
      const owned = [...sessions.values()].find(session => session.providerSessionId === input.sessionId);
      state.streamRequests.push({ ...input, suppressed: owned?.sensitiveOutputSuppressed === true });
      if (controls.streamGate && input.streamStatus === controls.gateStatus) { controls.enteredStream?.(); await controls.streamGate; }
      if (state.streamFailure === input.streamStatus) throw new Error('stream acknowledgement unknown');
      return { ...input, ...(state.streamReceiptMismatch ? { sessionId: 'foreign-provider-session' } : {}), ...(input.streamStatus === 'ENABLED' ? { automationEndpoint: 'wss://synthetic.example/resumed' } : {}) };
    },
  } as unknown as IntercomProfileProvider;
  const transport = {
    prepareWebsiteLogin: async (session: CloudBrowserSession) => { state.flow.push('prepare'); state.prepares++; state.clockOffsetMs += state.prepareAdvanceMs; assert.equal(session.sensitiveOutputSuppressed, true); if (state.prepareFails) throw new Error('prepare unavailable'); },
    verifyWebsiteLogin: async (session: CloudBrowserSession) => { state.flow.push('verify'); state.verifies++; state.verifyEndpoints.push(session.automationEndpoint); assert.equal(session.sensitiveOutputSuppressed, true); if (state.verifyFails) throw new Error('wrong website'); },
  } as unknown as AgentCoreCloudBrowserTransport;
  const ticketStore = {
    acquireProfileLease: async (profile: string, lease: string, until: number) => { state.leaseExpiries.push(until); if (leases.has(profile) && (leaseUntil.get(profile) ?? 0) >= now + state.clockOffsetMs) return false; leases.set(profile, lease); leaseUntil.set(profile, until); return true; },
    renewProfileLease: async (profile: string, lease: string, until: number) => { state.leaseRenewals.push(until); if (state.stealLeaseBeforeRenew) { leases.set(profile, 'successor-lease-owner'); leaseUntil.set(profile, now + state.clockOffsetMs + 3_630_000); } if (leases.get(profile) !== lease || (leaseUntil.get(profile) ?? 0) <= now + state.clockOffsetMs) return false; leaseUntil.set(profile, until); return true; },
    ownsProfileLease: async (profile: string, lease: string) => leases.get(profile) === lease && (leaseUntil.get(profile) ?? 0) > now + state.clockOffsetMs,
    releaseProfileLease: async (profile: string, lease: string) => { state.releaseCalls++; if (state.releaseFailures > 0) { state.releaseFailures--; throw new Error('lease release unavailable'); } if (leases.get(profile) === lease) { leases.delete(profile); leaseUntil.delete(profile); } },
    create: async ({ tokenHash, ...binding }: CreateWebsiteLoginTicket) => { state.flow.push('ticket-grant'); assert.equal(tickets.has(tokenHash), false); tickets.set(tokenHash, { ...binding, phase: 'NEW' }); },
    exchange: async (hash: string) => { const ticket = tickets.get(hash); if (!ticket || ticket.phase !== 'NEW') return null; ticket.phase = 'EXCHANGED'; const { phase: _phase, ...binding } = ticket; return binding; },
    load: async (hash: string) => { const ticket = tickets.get(hash); return ticket ? { ...ticket } : null; },
    finish: async (hash: string) => { const ticket = tickets.get(hash); if (!ticket || ticket.phase !== 'EXCHANGED') return false; ticket.phase = 'COMPLETING'; return true; },
    complete: async (hash: string, outcome: 'SAVED' | 'FAILED') => { const ticket = tickets.get(hash); if (!ticket || ticket.phase !== 'COMPLETING') return false; ticket.phase = outcome; return true; },
  } as unknown as WebsiteLoginTicketStore;
  const publicChecks: WebsiteLoginTarget[] = [];
  const make = () => new WebsiteLoginService(store, browser, transport, provider, ticketStore, () => now + state.clockOffsetMs, async target => { publicChecks.push(target); });
  return { service: make(), make, state, profiles, sessions, tickets, leases, leaseUntil, sessionLocks, controls, publicChecks };
}
const tokenFrom = (url: string) => url.split('#token=')[1]!;

test('cookie-authenticated viewer resume reuses the exchanged ticket and original session without extending any lifetime', async () => {
  const h = fixture();
  const started = await h.service.start('cto', key, 'linkedin');
  const token = tokenFrom(started.login_url);
  await h.service.exchange(token);
  const originalTicket = { ...[...h.tickets.values()][0]! };
  const leaseExpiry = h.leaseUntil.get(started.profile_id);
  const sessionExpiry = h.sessions.get(started.session_id)!.expiresAt;
  for (const elapsed of [100_000, 400_000, 599_000]) {
    h.state.clockOffsetMs = elapsed;
    const viewer = await h.service.resume(token);
    assert.equal(viewer.status, 'login_required');
    assert.ok(viewer.expires_at <= originalTicket.expiresAt);
    assert.ok(viewer.expires_at > now + elapsed);
    assert.equal(h.controls.lockDeadlines.at(-1), now + elapsed + 120_000);
    assert.equal(h.sessions.get(started.session_id)!.expiresAt, sessionExpiry);
    assert.equal(h.sessionLocks.size, 0);
  }
  assert.deepEqual([...h.tickets.values()][0], originalTicket);
  assert.equal(h.leaseUntil.get(started.profile_id), leaseExpiry);
  assert.equal(h.state.starts, 1); assert.equal(h.state.creates, 1); assert.equal(h.state.saves, 0); assert.equal(h.state.stops, 0);
  assert.equal(h.state.leaseRenewals.length, 1);
  assert.equal(h.state.signedLifetimes.at(-1), 1);
});

test('viewer resume rejects non-exchanged, expired, stopped, foreign-principal and replaced-lease sessions before provider effects', async () => {
  for (const invalid of ['NEW', 'COMPLETING', 'SAVED', 'FAILED', 'expired-ticket', 'expired-session', 'stopped', 'stop-pending', 'foreign-principal', 'replaced-lease']) {
    const h = fixture(); const started = await h.service.start('cto', key, 'linkedin'); const token = tokenFrom(started.login_url);
    if (invalid !== 'NEW') await h.service.exchange(token);
    const ticket = [...h.tickets.values()][0]!;
    if (['COMPLETING', 'SAVED', 'FAILED'].includes(invalid)) ticket.phase = invalid as 'COMPLETING' | 'SAVED' | 'FAILED';
    if (invalid === 'expired-ticket') h.state.clockOffsetMs = 600_001;
    if (invalid === 'expired-session') h.sessions.get(started.session_id)!.expiresAt = now;
    if (invalid === 'stopped') h.sessions.get(started.session_id)!.providerStopped = true;
    if (invalid === 'stop-pending') h.sessions.get(started.session_id)!.providerStopToken = 'unacknowledged-stop-intent';
    if (invalid === 'foreign-principal') h.sessions.get(started.session_id)!.ownerSubjectHash = 'b'.repeat(64);
    if (invalid === 'replaced-lease') h.leases.set(started.profile_id, 'new-lease-owner');
    const requests = h.state.streamRequests.length; const signs = h.state.signs;
    await assert.rejects(h.service.resume(token));
    assert.equal(h.state.streamRequests.length, requests, invalid);
    assert.equal(h.state.signs, signs, invalid);
    assert.equal(h.state.stops, 0, invalid);
  }
});

test('viewer resume and Done serialize on the same real session fence without consuming an unclaimed Done attempt', async () => {
  const h = fixture(); const started = await h.service.start('cto', key, 'linkedin'); const token = tokenFrom(started.login_url); await h.service.exchange(token);
  let release!: () => void; let entered!: () => void;
  h.controls.streamGate = new Promise<void>(resolve => { release = resolve; });
  const gateEntered = new Promise<void>(resolve => { entered = resolve; }); h.controls.enteredStream = entered;
  const resumed = h.service.resume(token);
  await gateEntered;
  await assert.rejects(h.service.complete(token), hasCode('session_busy'));
  assert.equal([...h.tickets.values()][0]!.phase, 'EXCHANGED'); assert.equal(h.state.stops, 0);
  release(); await resumed;
  h.controls.streamGate = undefined;
  await h.service.complete(token);
  assert.equal(h.controls.lockDeadlines.at(-1), now + 300_000);
  assert.equal(h.controls.fencedEndpointWrites, 1);
  assert.equal(h.sessionLocks.size, 0);
  assert.equal(h.state.saves, 1); assert.equal(h.state.stops, 1);
});

test('ambiguous resumed input transfer or rejected durable clear fences later resume and Done without retry or guessed cleanup', async () => {
  for (const failure of ['provider', 'mismatch', 'clear']) {
    const h = fixture(); const started = await h.service.start('cto', key, 'linkedin'); const token = tokenFrom(started.login_url); await h.service.exchange(token);
    const leaseOwner = h.leases.get(started.profile_id); const leaseExpiry = h.leaseUntil.get(started.profile_id);
    const sessionExpiry = h.sessions.get(started.session_id)!.expiresAt; const ticket = { ...[...h.tickets.values()][0]! };
    if (failure === 'provider') h.state.streamFailure = 'DISABLED';
    if (failure === 'mismatch') h.state.streamReceiptMismatch = true;
    if (failure === 'clear') h.controls.failUnknownWrite = 'clear';
    const requests = h.state.streamRequests.length; const signs = h.state.signs;
    await assert.rejects(h.service.resume(token));
    assert.deepEqual(h.controls.unknownWrites, [true]);
    assert.equal(h.state.streamRequests.length, requests + 1);
    assert.equal(h.sessions.get(started.session_id)!.effectUnknown, true);
    assert.equal(h.sessions.get(started.session_id)!.sensitiveOutputSuppressed, true);
    assert.equal(h.sessionLocks.size, 0);
    h.state.streamFailure = undefined; h.state.streamReceiptMismatch = false; h.controls.failUnknownWrite = undefined;
    await assert.rejects(h.service.resume(token)); await assert.rejects(h.service.complete(token));
    assert.equal(h.state.streamRequests.length, requests + 1); assert.equal(h.state.signs, signs);
    assert.equal(h.state.verifies, 0); assert.equal(h.state.saves, 0); assert.equal(h.state.stops, 0);
    assert.equal(h.leases.get(started.profile_id), leaseOwner); assert.equal(h.leaseUntil.get(started.profile_id), leaseExpiry);
    assert.equal(h.sessions.get(started.session_id)!.expiresAt, sessionExpiry);
    assert.deepEqual([...h.tickets.values()][0], ticket);
  }
});

test('lost acknowledgement after a committed clear returns failure without retry and permits only a fresh manually authorized Done', async () => {
  const h = fixture(); const started = await h.service.start('cto', key, 'linkedin'); const token = tokenFrom(started.login_url); await h.service.exchange(token);
  const sessionExpiry = h.sessions.get(started.session_id)!.expiresAt;
  const leaseExpiry = h.leaseUntil.get(started.profile_id); const ticket = { ...[...h.tickets.values()][0]! };
  h.controls.failUnknownWrite = 'clear-after-commit';
  const requests = h.state.streamRequests.length; const signs = h.state.signs;
  await assert.rejects(h.service.resume(token));
  assert.deepEqual(h.controls.unknownWrites, [true, false]);
  assert.equal(h.sessions.get(started.session_id)!.effectUnknown, false, 'DISABLED was exactly confirmed before this clear committed');
  assert.equal(h.state.streamRequests.length, requests + 1); assert.equal(h.state.signs, signs);
  assert.equal(h.state.verifies, 0); assert.equal(h.state.saves, 0); assert.equal(h.state.stops, 0);
  assert.equal(h.sessionLocks.size, 0); assert.equal(h.sessions.get(started.session_id)!.sensitiveOutputSuppressed, true);
  assert.equal(h.sessions.get(started.session_id)!.expiresAt, sessionExpiry); assert.equal(h.leaseUntil.get(started.profile_id), leaseExpiry);
  assert.deepEqual([...h.tickets.values()][0], ticket);
  h.controls.failUnknownWrite = undefined;
  h.sessions.get(started.session_id)!.ownerSubjectHash = 'b'.repeat(64);
  await assert.rejects(h.service.complete(token));
  assert.equal(h.state.streamRequests.length, requests + 1); assert.equal([...h.tickets.values()][0]!.phase, 'EXCHANGED');
  h.sessions.get(started.session_id)!.ownerSubjectHash = ticket.ownerSubjectHash;
  assert.equal((await h.service.complete(token)).status, 'saved');
  assert.equal(h.state.streamRequests.length, requests + 2); assert.equal(h.state.streamRequests.at(-1)!.streamStatus, 'ENABLED');
  assert.equal(h.state.saves, 1); assert.equal(h.state.stops, 1);
});

test('resume persists its unknown-effect intent before any provider call and aborts when that write fails', async () => {
  const h = fixture(); const started = await h.service.start('cto', key, 'linkedin'); const token = tokenFrom(started.login_url); await h.service.exchange(token);
  h.controls.failUnknownWrite = 'intent';
  const requests = h.state.streamRequests.length; const signs = h.state.signs;
  await assert.rejects(h.service.resume(token));
  assert.equal(h.state.streamRequests.length, requests); assert.equal(h.state.signs, signs);
  assert.equal(h.sessionLocks.size, 0); assert.equal(h.state.stops, 0);
  assert.equal([...h.tickets.values()][0]!.phase, 'EXCHANGED');
});

test('Done claimed first and phase or principal changes during lock acquisition fail closed before resumed input control', async () => {
  const doneFirst = fixture(); const started = await doneFirst.service.start('cto', key, 'linkedin'); const token = tokenFrom(started.login_url); await doneFirst.service.exchange(token);
  let release!: () => void; let entered!: () => void;
  doneFirst.controls.gateStatus = 'ENABLED';
  doneFirst.controls.streamGate = new Promise<void>(resolve => { release = resolve; });
  const gateEntered = new Promise<void>(resolve => { entered = resolve; }); doneFirst.controls.enteredStream = entered;
  const completed = doneFirst.service.complete(token); await gateEntered;
  const before = doneFirst.state.streamRequests.length;
  await assert.rejects(doneFirst.service.resume(token)); assert.equal(doneFirst.state.streamRequests.length, before);
  release(); await completed;
  for (const changed of ['phase', 'principal']) {
    const h = fixture(); const fresh = await h.service.start('cto', key, 'linkedin'); const raw = tokenFrom(fresh.login_url); await h.service.exchange(raw);
    h.controls.onAcquire = () => { if (changed === 'phase') [...h.tickets.values()][0]!.phase = 'COMPLETING'; else h.sessions.get(fresh.session_id)!.ownerSubjectHash = 'b'.repeat(64); };
    const requests = h.state.streamRequests.length;
    await assert.rejects(h.service.resume(raw));
    assert.equal(h.state.streamRequests.length, requests); assert.equal(h.sessionLocks.size, 0); assert.equal(h.state.stops, 0);
  }
});

test('default handoff keeps its one-hour session and separates session expiry from the ten-minute login ticket', async () => {
  const { service, state, tickets } = fixture();
  const result = await service.start('cto', key, 'linkedin');
  assert.deepEqual(state.startOptions, [{ maxSeconds: 3600, actionBudget: undefined }]);
  assert.deepEqual(state.leaseExpiries, [now + 3_630_000]);
  assert.deepEqual(state.leaseRenewals, [now + 3_630_000]);
  assert.equal(result.session_expires_at, now + 3_600_000);
  assert.equal(result.expires_at, now + 600_000);
  assert.equal([...tickets.values()][0]?.expiresAt, result.expires_at);
});

test('requested handoff duration and action budget reach the browser and bound lease and ticket expiry', async () => {
  for (const [maxSeconds, actionBudget] of [[1, 1], [180, 25], [3600, 10_000]]) {
    const { service, state, tickets } = fixture();
    const result = await service.start('developer', key, 'wefunder', undefined, { maxSeconds, actionBudget });
    assert.deepEqual(state.startOptions, [{ maxSeconds, actionBudget }]);
    assert.deepEqual(state.leaseExpiries, [now + 3_630_000]);
    assert.deepEqual(state.leaseRenewals, [now + (maxSeconds + 30) * 1000]);
    assert.equal(result.session_expires_at, now + maxSeconds * 1000);
    assert.equal(result.expires_at, now + Math.min(maxSeconds * 1000, 600_000));
    assert.equal([...tickets.values()][0]?.expiresAt, result.expires_at);
  }
});

test('actual shorter provider session expiry caps the returned login ticket', async () => {
  const { service, state, tickets } = fixture(); state.sessionExpiresAt = now + 45_000;
  const result = await service.start('cto', key, 'linkedin', undefined, { maxSeconds: 180 });
  assert.equal(result.session_expires_at, now + 45_000); assert.equal(result.expires_at, now + 45_000);
  assert.equal([...tickets.values()][0]?.expiresAt, now + 45_000);
});

test('delayed profile setup renews the owned lease through the actual later session expiry', async () => {
  const { service, state, leaseUntil } = fixture(); state.profileLookupAdvanceMs = 45_000;
  const result = await service.start('cto', key, 'linkedin', undefined, { maxSeconds: 180 });
  assert.equal(result.session_expires_at, now + 225_000); assert.equal(result.expires_at, now + 225_000);
  assert.equal(leaseUntil.get(result.profile_id), now + 255_000);
  state.clockOffsetMs = 211_000;
  const exchanged = await service.exchange(tokenFrom(result.login_url));
  assert.equal(exchanged.status, 'login_required'); assert.equal(exchanged.expires_at, result.expires_at);
});

test('lost setup lease ownership fails closed and cleanup never removes the successor lease', async () => {
  const { service, state, leases, sessions, tickets } = fixture(); state.stealLeaseBeforeRenew = true;
  await assert.rejects(service.start('cto', key, 'linkedin', undefined, { maxSeconds: 180 }), hasCode('profile_login_lease_lost'));
  assert.equal(state.stops, 1); assert.equal(sessions.size, 0); assert.equal(tickets.size, 0); assert.equal(state.signs, 0);
  assert.deepEqual([...leases.values()], ['successor-lease-owner']);
});

test('invalid handoff budgets reject before profile, lease or provider operations', async () => {
  const invalidSeconds = [0, -1, 3601, 1.5, NaN, Infinity];
  const invalidBudgets = [0, -1, 10_001, 1.5, NaN, Infinity];
  for (const [option, values, code] of [['maxSeconds', invalidSeconds, 'invalid_duration'], ['actionBudget', invalidBudgets, 'invalid_action_budget']] as const) {
    for (const value of values) {
      const { service, state, profiles, leases, tickets } = fixture();
      await assert.rejects(service.start('cto', key, 'linkedin', undefined, { [option]: value }), hasCode(code));
      assert.equal(state.profileReads, 0); assert.equal(state.leaseExpiries.length, 0); assert.equal(state.creates, 0); assert.equal(state.starts, 0);
      assert.equal(profiles.size, 0); assert.equal(leases.size, 0); assert.equal(tickets.size, 0);
    }
  }
});

test('viewer signature and returned expiry stay within the short session and original ticket', async () => {
  for (const maxSeconds of [180, 3600]) {
    const { service, state } = fixture();
    const result = await service.start('cto', key, 'linkedin', undefined, { maxSeconds });
    const exchange = await service.exchange(tokenFrom(result.login_url));
    assert.deepEqual(state.signedLifetimes, [Math.min(300, maxSeconds)]);
    assert.equal(exchange.expires_at, now + Math.min(300, maxSeconds) * 1000);
    assert.ok(exchange.expires_at <= result.expires_at); assert.ok(exchange.expires_at <= result.session_expires_at);
  }
});

test('very short sessions that expire during preparation stop and release without returning a stale link', async () => {
  const { service, state, leases, sessions } = fixture(); state.prepareAdvanceMs = 1100;
  await assert.rejects(service.start('cto', key, 'linkedin', undefined, { maxSeconds: 1 }), hasCode('login_expired'));
  assert.equal(state.stops, 1); assert.equal(leases.size, 0); assert.equal(sessions.size, 0);
});

test('viewer exchange refuses subsecond lifetime or a URL whose signing outlasted session expiry', async () => {
  const almostExpired = fixture();
  const first = await almostExpired.service.start('cto', key, 'linkedin', undefined, { maxSeconds: 180 });
  almostExpired.state.clockOffsetMs = 179_100;
  await assert.rejects(almostExpired.service.exchange(tokenFrom(first.login_url)), hasCode('login_expired'));
  assert.equal(almostExpired.state.signs, 0);
  const slowSigning = fixture();
  const second = await slowSigning.service.start('cto', key, 'linkedin', undefined, { maxSeconds: 180 });
  slowSigning.state.signAdvanceMs = 180_001;
  await assert.rejects(slowSigning.service.exchange(tokenFrom(second.login_url)), hasCode('login_expired'));
  assert.equal(slowSigning.state.signs, 1);
});

test('human handoff disables automation before granting viewer access and resumes suppressed automation before verification', async () => {
  const { service, state } = fixture();
  const result = await service.start('cto', key, 'linkedin'); const token = tokenFrom(result.login_url);
  assert.ok(state.flow.indexOf('stream-DISABLED') > state.flow.indexOf('persist-prepared'));
  assert.ok(state.flow.indexOf('persist-prepared') > state.flow.indexOf('prepare'));
  assert.ok(state.flow.indexOf('ticket-grant') > state.flow.indexOf('stream-DISABLED'));
  await service.exchange(token);
  assert.equal(state.streamRequests.filter(request => request.streamStatus === 'DISABLED').length, 2);
  assert.ok(state.flow.lastIndexOf('stream-DISABLED') < state.flow.indexOf('live-view'));
  await service.complete(token);
  assert.ok(state.flow.indexOf('stream-ENABLED') < state.flow.indexOf('persist-resumed'));
  assert.ok(state.flow.indexOf('persist-resumed') < state.flow.indexOf('verify'));
  assert.ok(state.flow.indexOf('verify') < state.flow.indexOf('save-profile'));
  assert.deepEqual(state.verifyEndpoints, ['wss://synthetic.example/resumed']);
  assert.deepEqual(state.streamRequests.map(request => [request.browserIdentifier, request.sessionId, request.suppressed]), Array.from({ length: 3 }, () => ['aws.browser.v1', 'remote-session-1', true]));
});

test('unconfirmed automation disable grants no login link or ticket and cleans up a confirmed stopped session', async () => {
  const { service, state, tickets, leases, sessions } = fixture(); state.streamFailure = 'DISABLED';
  await assert.rejects(service.start('cto', key, 'linkedin'), /stream acknowledgement unknown/);
  assert.equal(tickets.size, 0); assert.equal(state.signs, 0); assert.equal(state.stops, 1); assert.equal(leases.size, 0); assert.equal(sessions.size, 0);
});

test('exchange rechecks disabled automation and cannot sign a viewer link after an ambiguous handoff', async () => {
  const { service, state, sessions, leases } = fixture();
  const result = await service.start('cto', key, 'linkedin'); state.streamFailure = 'DISABLED';
  await assert.rejects(service.exchange(tokenFrom(result.login_url)), /stream acknowledgement unknown/);
  assert.equal(state.signs, 0); assert.equal(sessions.get(result.session_id)?.sensitiveOutputSuppressed, true); assert.equal(leases.has(result.profile_id), true);
});

test('failed automation resume does not verify or save and keeps suppression and lease after ambiguous cleanup', async () => {
  const { service, state, sessions, leases, tickets } = fixture();
  const result = await service.start('cto', key, 'linkedin'); const token = tokenFrom(result.login_url); await service.exchange(token);
  state.streamFailure = 'ENABLED'; state.stopFails = true;
  await assert.rejects(service.complete(token), /stream acknowledgement unknown/);
  assert.equal(state.verifies, 0); assert.equal(state.saves, 0); assert.equal(sessions.get(result.session_id)?.sensitiveOutputSuppressed, true); assert.equal(leases.has(result.profile_id), true);
  assert.equal([...tickets.values()][0]?.phase, 'FAILED');
});

test('stream acknowledgement must confirm the exact owned provider session', async () => {
  const { service, state, tickets } = fixture(); state.streamReceiptMismatch = true;
  await assert.rejects(service.start('cto', key, 'linkedin'), hasCode('automation_stream_state_unknown'));
  assert.equal(tickets.size, 0); assert.equal(state.signs, 0);
});

test('website login isolates each owner, OAuth connection and site while retaining COO principal compatibility', async () => {
  assert.equal(websitePrincipalHash('coo', key), intercomPrincipalHash(key));
  const ids = new Set<string>();
  for (const owner of ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director']) {
    const { service, state, profiles } = fixture();
    const result = await service.start(owner, key, 'linkedin');
    const profile = profiles.get(result.profile_id)!;
    assert.equal(profile.owner, owner); assert.equal(profile.ownerSubjectHash, websitePrincipalHash(owner, key));
    assert.deepEqual(profile.allowedHosts, ['www.linkedin.com']); assert.equal(profile.persistent, true);
    assert.ok(result.profile_id.length <= 64); assert.ok(state.names[0]!.length <= 48);
    assert.match(state.names[0]!, /^companyWebsiteAuth_/); ids.add(result.profile_id);
    assert.equal(result.status, 'human_login_required'); assert.equal(result.login_url.startsWith('https://mcp.otchealth.app/browser/connect#token='), true);
  }
  assert.equal(ids.size, 7);
  const hash = websitePrincipalHash('cto', key);
  assert.notEqual(websiteProfileId('cto', hash, 'linkedin'), websiteProfileId('cto', hash, 'wefunder'));
  assert.notEqual(websiteProfileId('cto', hash, 'linkedin'), websiteProfileId('cto', websitePrincipalHash('cto', 'connection:other'), 'linkedin'));
  const { service, state } = fixture();
  await assert.rejects(service.start('clo-personal', key, 'linkedin'), hasCode('owner_forbidden'));
  await assert.rejects(service.start('cto', undefined, 'linkedin'), hasCode('oauth_subject_required'));
  await assert.rejects(service.start('cto', key, 'unsupported' as never), hasCode('website_not_supported'));
  assert.equal(state.creates, 0);
});

test('new service discovers and restarts the saved owned profile without duplicate provider creation', async () => {
  const { service, make, state } = fixture();
  await assert.rejects(service.discover('cto', key, 'wefunder'), hasCode('profile_not_enrolled'));
  assert.equal(state.creates, 0);
  const first = await service.start('cto', key, 'wefunder');
  const token = tokenFrom(first.login_url);
  await service.exchange(token); await service.complete(token);
  const restarted = make();
  assert.deepEqual(await restarted.discover('cto', key, 'wefunder'), { profile_id: first.profile_id, persistent: true, allowed_hosts: ['wefunder.com'] });
  await assert.rejects(restarted.discover('cto', 'connection:other', 'wefunder'), hasCode('profile_not_enrolled'));
  const second = await restarted.start('cto', key, 'wefunder');
  assert.equal(second.profile_id, first.profile_id); assert.equal(state.creates, 1); assert.equal(state.starts, 2);
});

test('ambiguous profile creation remains a durable pending intent and is not retried', async () => {
  const { service, state, profiles } = fixture(); state.createFails = true;
  await assert.rejects(service.start('cro', key, 'linkedin'), /acknowledgement unknown/);
  assert.equal([...profiles.values()][0]?.providerProfileId, undefined);
  await assert.rejects(service.start('cro', key, 'linkedin'), hasCode('profile_preparation_unknown'));
  await assert.rejects(service.discover('cro', key, 'linkedin'), hasCode('profile_not_enrolled'));
  assert.equal(state.creates, 1); assert.equal(state.starts, 0);
});

test('foreign principal, site or unsuppressed session cannot be signed or completed', async () => {
  for (const field of ['ownerSubjectHash', 'profileId', 'sensitiveOutputSuppressed', 'owner', 'providerBrowserId'] as const) {
    const { service, state, sessions } = fixture();
    const result = await service.start('cto', key, 'wefunder');
    const session = sessions.get(result.session_id)!;
    if (field === 'sensitiveOutputSuppressed') session[field] = false;
    else session[field] = field === 'profileId' ? websiteProfileId('cto', websitePrincipalHash('cto', key), 'linkedin') : 'foreign';
    await assert.rejects(service.exchange(tokenFrom(result.login_url)), hasCode('owner_forbidden'));
    assert.equal(state.signs, 0); assert.equal(state.saves, 0);
  }
});

test('single-use completion saves once while suppressed and stops before confirming saved', async () => {
  const { service, state, sessions, tickets } = fixture();
  const result = await service.start('cto', key, 'wefunder');
  const token = tokenFrom(result.login_url);
  const exchanged = await service.exchange(token);
  assert.equal(exchanged.site_label, 'WeFunder'); assert.equal(exchanged.workspace_id, 'wefunder');
  await assert.rejects(service.exchange(token), hasCode('login_expired'));
  const outcomes = await Promise.allSettled([service.complete(token), service.complete(token)]);
  assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(state.saves, 1); assert.equal(state.stops, 1); assert.equal(sessions.size, 0);
  assert.deepEqual(state.suppressionSeen, [true, true]); assert.equal([...tickets.values()][0]?.phase, 'SAVED');
  assert.equal(JSON.stringify([...tickets]).includes(token), false);
});

test('verification and save failures never return saved or retry provider save', async () => {
  for (const failure of ['verifyFails', 'saveFails'] as const) {
    const { service, state, tickets } = fixture();
    const result = await service.start('cro', key, 'linkedin'); const token = tokenFrom(result.login_url);
    await service.exchange(token); state[failure] = true;
    await assert.rejects(service.complete(token));
    await assert.rejects(service.complete(token), hasCode('login_expired'));
    assert.equal(state.saves, failure === 'saveFails' ? 1 : 0); assert.equal([...tickets.values()][0]?.phase, 'FAILED');
  }
});

test('failed setup stops its suppressed session and creates no handoff ticket', async () => {
  const { service, state, tickets } = fixture(); state.prepareFails = true;
  await assert.rejects(service.start('cto', key, 'wefunder'));
  assert.equal(state.stops, 1); assert.equal(tickets.size, 0); assert.deepEqual(state.suppressionSeen, [true]);
});

test('failed cleanup leaves the login session suppressed and does not claim saved', async () => {
  const { service, state, sessions, tickets, leases } = fixture();
  const result = await service.start('cto', key, 'linkedin'); const token = tokenFrom(result.login_url);
  await service.exchange(token); state.stopFails = true;
  await assert.rejects(service.complete(token), /stop unavailable/);
  assert.equal(state.saves, 1); assert.equal(sessions.get(result.session_id)?.sensitiveOutputSuppressed, true);
  assert.equal([...tickets.values()][0]?.phase, 'FAILED');
  assert.equal(leases.has(result.profile_id), true);
  await assert.rejects(service.complete(token), hasCode('login_expired'));
  assert.equal(state.saves, 1);
});

test('generic websites bind canonical owner-selected policy through discovery, handoff and completion', async () => {
  const target = await resolveWebsiteLoginTarget({ url: 'https://example.com/account/', allowed_hosts: ['accounts.google.com'] }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  const other = await resolveWebsiteLoginTarget({ url: 'https://example.com/other/' }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  const { service, state, tickets, publicChecks, leases, profiles } = fixture();
  const result = await service.start('developer', key, 'custom', target); const token = tokenFrom(result.login_url);
  const profile = profiles.get(result.profile_id)!;
  assert.deepEqual(profile.allowedHosts, ['accounts.google.com', 'example.com']);
  assert.equal(profile.actionBudget, 10_000); assert.equal(profile.maxSessionSeconds, 28_800); assert.equal(profile.maxActionSeconds, 120);
  assert.deepEqual([...tickets.values()][0]?.target, target);
  assert.notEqual(websiteProfileId('developer', websitePrincipalHash('developer', key), 'custom', target), websiteProfileId('developer', websitePrincipalHash('developer', key), 'custom', other));
  assert.equal((await service.discover('developer', key, 'custom', target)).profile_id, result.profile_id);
  const exchange = await service.exchange(token); assert.equal(exchange.site_label, 'example.com');
  const receipt = await service.complete(token); assert.equal(receipt.site, 'custom');
  assert.equal(publicChecks.length, 4); assert.equal(state.saves, 1); assert.equal(leases.has(result.profile_id), false);
});

test('profile handoff lease blocks another onboarding and rejects a stale ticket before signing', async () => {
  const { service, state, leases } = fixture(); const first = await service.start('cto', key, 'wefunder');
  await assert.rejects(service.start('cto', key, 'wefunder'), hasCode('profile_busy')); assert.equal(state.starts, 1);
  leases.set(first.profile_id, 'new-lease-owner');
  await assert.rejects(service.exchange(tokenFrom(first.login_url)), hasCode('owner_forbidden')); assert.equal(state.signs, 0);
});

test('known pre-effect start rejections release their handoff lease and permit a later start', async () => {
  for (const code of ['principal_binding_invalid', 'owner_forbidden', 'profile_login_in_progress', 'invalid_profile', 'profile_state_invalid', 'invalid_duration', 'invalid_action_budget', 'profile_busy', 'daily_session_limit']) {
    const { service, state, leases } = fixture(); state.startError = new CloudBrowserError(code, 'synthetic rejection before provider start');
    await assert.rejects(service.start('cto', key, 'wefunder'), hasCode(code));
    assert.equal(leases.size, 0, `${code} must not strand a login lease`); assert.equal(state.stops, 0);
    state.startError = undefined;
    await service.start('cto', key, 'wefunder'); assert.equal(state.creates, 1); assert.equal(state.starts, 1);
  }
});

test('ambiguous start and post-start credential/store errors retain the handoff fence', async () => {
  for (const error of [new Error('lost provider acknowledgement'), new CloudBrowserError('aws_credentials_unavailable', 'could have failed saving an already-created session'), new CloudBrowserError('session_store_failed', 'session persistence acknowledgement unknown'), new CloudBrowserError('provider_timeout', 'remote outcome unknown')]) {
    const { service, state, leases } = fixture(); state.startError = error;
    await assert.rejects(service.start('cto', key, 'wefunder'));
    assert.equal(leases.size, 1); assert.equal(state.releaseCalls, 0); assert.equal(state.stops, 0);
    await assert.rejects(service.start('cto', key, 'wefunder'), hasCode('profile_busy'));
  }
});

test('transient lease cleanup failure after confirmed stop retries release without stopping a deleted session', async () => {
  const { service, state, leases, sessions, tickets } = fixture();
  const result = await service.start('cto', key, 'linkedin'); const token = tokenFrom(result.login_url);
  await service.exchange(token); state.releaseFailures = 1;
  await assert.rejects(service.complete(token), /lease release unavailable/);
  assert.equal(state.stops, 1); assert.equal(state.releaseCalls, 2); assert.equal(leases.size, 0); assert.equal(sessions.size, 0);
  assert.equal([...tickets.values()][0]?.phase, 'FAILED');
});
