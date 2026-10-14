import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudBrowserError, type CloudBrowserProfile, type CloudBrowserSession, type CloudBrowserStore } from './contract.js';
import { IntercomLoginService, intercomPrincipalHash, intercomProfileId } from './intercom-login-service.js';
import type { AgentCoreCloudBrowserTransport } from './agentcore-transport.js';
import type { IntercomProfileProvider } from './intercom-profile-provider.js';
import type { IntercomLoginTicketStore } from './intercom-login-store.js';

const subject = 'coo-oauth-subject';
const workspace = 'abc123';
const now = 1_700_000_000_000;
const loginToken = 'A'.repeat(43);

function fixture(overrides: {
  existingProfile?: CloudBrowserProfile;
  allowIntent?: boolean;
  createProfileError?: Error;
  prepareError?: Error;
  exchangeBinding?: { ownerSubjectHash: string; profileId: string; sessionId: string; expectedWorkspaceId: string; expiresAt: number } | null;
  sessionOwnerSubjectHash?: string;
} = {}) {
  const profiles = new Map<string, CloudBrowserProfile>();
  const sessions = new Map<string, CloudBrowserSession>();
  if (overrides.existingProfile) profiles.set(overrides.existingProfile.profileId, overrides.existingProfile);

  const state = {
    intentCalls: 0,
    profileLockCalls: 0,
    providerCreateCalls: 0,
    browserStartCalls: 0,
    stopCalls: 0,
    prepareCalls: 0,
    ticketCreates: [] as Array<Record<string, unknown>>,
    liveViewCalls: 0,
  };

  const store = {
    loadProfile: async (id: string) => profiles.get(id) ?? null,
    saveProfile: async (profile: CloudBrowserProfile) => { profiles.set(profile.profileId, profile); },
    createProfileIntent: async (profile: CloudBrowserProfile) => {
      state.intentCalls += 1;
      if (profiles.has(profile.profileId) || overrides.allowIntent === false) return false;
      profiles.set(profile.profileId, profile);
      return true;
    },
    acquireProfileLock: async () => { state.profileLockCalls += 1; return true; },
    loadSession: async (id: string) => sessions.get(id) ?? null,
    saveSession: async (session: CloudBrowserSession) => { sessions.set(session.sessionId, { ...session }); },
  } as unknown as CloudBrowserStore;

  const browser = {
    saveProfile: async (_owner: string, profile: CloudBrowserProfile) => { profiles.set(profile.profileId, profile); },
    start: async (_owner: string, profileId: string, _seconds: number, _unused?: unknown, ownerHash?: string) => {
      state.browserStartCalls += 1;
      const profile = profiles.get(profileId);
      assert.ok(profile?.providerProfileId);
      const session: CloudBrowserSession = {
        sessionId: 'browser-session-1', owner: 'coo', ownerSubjectHash: overrides.sessionOwnerSubjectHash ?? ownerHash,
        profileId, allowedHosts: profile.allowedHosts, expiresAt: now + 3_600_000, actionsUsed: 0,
        providerSessionId: 'remote-session-1', providerBrowserId: 'aws.browser.v1', automationEndpoint: 'wss://browser.example/endpoint',
      };
      sessions.set(session.sessionId, session);
      return { sessionId: session.sessionId, expiresAt: session.expiresAt };
    },
    beginSensitiveOutputSuppression: async (_owner: string, id: string) => {
      const session = sessions.get(id)!;
      session.sensitiveOutputSuppressed = true;
    },
    savePersistentProfile: async () => undefined,
    endSensitiveOutputSuppression: async () => undefined,
    stop: async (_owner: string, id: string) => { state.stopCalls += 1; sessions.delete(id); },
  };

  const provider = {
    createProfile: async (input: { name: string }) => {
      state.providerCreateCalls += 1;
      if (overrides.createProfileError) throw overrides.createProfileError;
      return { providerProfileId: `${input.name}-created123` };
    },
    generateLiveViewUrl: async () => {
      state.liveViewCalls += 1;
      return { url: 'https://browser.example/live-view?signature=opaque', expiresIn: 300 };
    },
  };

  const transport = {
    prepareIntercomLogin: async () => {
      state.prepareCalls += 1;
      if (overrides.prepareError) throw overrides.prepareError;
    },
    verifyIntercomLogin: async () => undefined,
  };

  const tickets = {
    create: async (input: Record<string, unknown>) => { state.ticketCreates.push(input); },
    exchange: async (tokenHash: string) => {
      if (overrides.exchangeBinding !== undefined) return overrides.exchangeBinding;
      const index = state.ticketCreates.findIndex(v => v.tokenHash === tokenHash);
      if (index < 0) return null;
      const {tokenHash: _hash, ...binding} = state.ticketCreates.splice(index, 1)[0]!;
      return binding;
    },
    load: async () => null,
    finish: async () => true,
    complete: async () => true,
  };

  const service = new IntercomLoginService(
    store,
    browser as never,
    transport as unknown as AgentCoreCloudBrowserTransport,
    provider as unknown as IntercomProfileProvider,
    tickets as unknown as IntercomLoginTicketStore,
    () => now,
  );
  return { service, state, profiles, sessions, store };
}

test('absent profile bootstrap uses atomic create intent instead of a profile lock', async () => {
  const { service, state, profiles } = fixture();
  const result = await service.start(subject, workspace);
  const ownerHash = intercomPrincipalHash(subject);
  const profile = profiles.get(result.profile_id)!;
  assert.equal(state.intentCalls, 1);
  assert.equal(state.profileLockCalls, 0);
  assert.equal(state.providerCreateCalls, 1);
  assert.equal(profile.owner, 'coo');
  assert.equal(profile.ownerSubjectHash, ownerHash);
  assert.equal(profile.persistent, true);
  assert.equal(profile.providerProfileId, `cooIntercomAuth_${result.profile_id.slice(-24)}-created123`);
  assert.equal(result.status, 'human_login_required');
  assert.equal(result.login_url.startsWith('https://mcp.otchealth.app/browser/login#token='), true);
  const ticket = state.ticketCreates[0]!;
  assert.equal(ticket.ownerSubjectHash, ownerHash);
  assert.equal(ticket.expectedWorkspaceId, workspace);
  assert.match(String(ticket.tokenHash), /^[a-f0-9]{64}$/);
  const rawToken = result.login_url.split('#token=')[1]!;
  assert.equal(JSON.stringify(ticket).includes(rawToken), false);
  // Verify the capability resolves the stored ticket instead of duplicating the hash formula.
  const exchanged = await service.exchange(rawToken);
  assert.equal(exchanged.status, 'login_required');
  await assert.rejects(service.exchange(rawToken), /invalid|consumed|expired/);
  assert.equal(JSON.stringify(ticket).includes(result.login_url.split('#token=')[1]!), false);
});

test('durable pending profile intent freezes after ambiguous provider creation and cannot create twice', async () => {
  const { service, state, profiles } = fixture({ createProfileError: new Error('provider acknowledgement unknown') });
  await assert.rejects(service.start(subject, workspace), (error: unknown) => error instanceof Error && error.message === 'provider acknowledgement unknown');
  const pending = [...profiles.values()][0]!;
  assert.equal(pending.owner, 'coo');
  assert.equal(pending.providerProfileId, undefined);
  await assert.rejects(service.start(subject, workspace), (error: unknown) => error instanceof CloudBrowserError && error.code === 'profile_preparation_unknown');
  assert.equal(state.intentCalls, 1);
  assert.equal(state.providerCreateCalls, 1);
  assert.equal(state.browserStartCalls, 0);
});

test('existing profile bound to another subject is rejected before provider or browser calls', async () => {
  const otherHash = 'b'.repeat(64);
  const ownerHash = intercomPrincipalHash(subject);
  const profileId = intercomProfileId(ownerHash,workspace);
  const existing: CloudBrowserProfile = {
    profileId, owner: 'coo', ownerSubjectHash: otherHash, providerProfileId: 'provider-profile-owned-by-other',
    allowedHosts: ['app.intercom.com'], persistent: true,
  };
  const { service, state } = fixture({ existingProfile: existing });
  await assert.rejects(service.start(subject, workspace), (error: unknown) => error instanceof CloudBrowserError && error.code === 'owner_forbidden');
  assert.equal(state.providerCreateCalls, 0);
  assert.equal(state.browserStartCalls, 0);
  assert.equal(state.ticketCreates.length, 0);
});

test('post-start preparation failure stops the session and never creates a login ticket', async () => {
  const { service, state, sessions } = fixture({ prepareError: new Error('navigation setup failed') });
  await assert.rejects(service.start(subject, workspace));
  assert.equal(state.browserStartCalls, 1);
  assert.equal(state.prepareCalls, 1);
  assert.equal(state.stopCalls, 1);
  assert.equal(state.ticketCreates.length, 0);
  assert.equal(sessions.has('browser-session-1'), false);
});

test('exchange rejects an expired ticket before loading a session or signing a live-view URL', async () => {
  const { service, state } = fixture({ exchangeBinding: null });
  await assert.rejects(service.exchange(loginToken), (error: unknown) => error instanceof CloudBrowserError && error.code === 'login_expired');
  assert.equal(state.liveViewCalls, 0);
  assert.equal(state.browserStartCalls, 0);
});

test('successful exchange returns a numeric safe-integer expiry accepted by the login page contract', async () => {
  const ownerHash = intercomPrincipalHash(subject);
  const profileId = intercomProfileId(ownerHash,workspace);
  const binding = { ownerSubjectHash: ownerHash, profileId, sessionId: 'browser-session-1', expectedWorkspaceId: workspace, expiresAt: now + 600_000 };
  const { service, state, sessions } = fixture({ exchangeBinding: binding });
  sessions.set(binding.sessionId, {
    sessionId: binding.sessionId, owner: 'coo', ownerSubjectHash: ownerHash, profileId,
    allowedHosts: ['app.intercom.com'], expiresAt: now + 600_000, actionsUsed: 0,
    providerSessionId: 'remote-session-1', providerBrowserId: 'aws.browser.v1',
    automationEndpoint: 'wss://browser.example/endpoint', sensitiveOutputSuppressed: true,
  });

  const result = await service.exchange(loginToken);
  assert.equal(result.status, 'login_required');
  assert.equal(result.workspace_id, workspace);
  assert.equal(Number.isSafeInteger(result.expires_at), true);
  assert.equal(result.expires_at, now + 300_000);
  assert.equal(state.liveViewCalls, 1);
});

test('exchange refuses a ticket whose owner hash does not match its browser session', async () => {
  const ownerHash = intercomPrincipalHash(subject);
  const profileId = intercomProfileId(ownerHash,workspace);
  const foreignHash = 'c'.repeat(64);
  const binding = { ownerSubjectHash: ownerHash, profileId, sessionId: 'browser-session-foreign', expectedWorkspaceId: workspace, expiresAt: now + 600_000 };
  const { service, state, sessions } = fixture({ exchangeBinding: binding, sessionOwnerSubjectHash: foreignHash });
  sessions.set(binding.sessionId, {
    sessionId: binding.sessionId, owner: 'coo', ownerSubjectHash: foreignHash, profileId,
    allowedHosts: ['app.intercom.com'], expiresAt: now + 600_000, actionsUsed: 0,
    providerSessionId: 'foreign-provider-session', providerBrowserId: 'aws.browser.v1',
    automationEndpoint: 'wss://browser.example/endpoint', sensitiveOutputSuppressed: true,
  });
  await assert.rejects(service.exchange(loginToken), (error: unknown) => error instanceof CloudBrowserError && error.code === 'owner_forbidden');
  assert.equal(state.liveViewCalls, 0);
});
