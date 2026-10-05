import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudBrowserError, type CloudBrowserProfile, type CloudBrowserProviderProfile, type CloudBrowserSession, type CloudBrowserStore, type CloudBrowserTransport } from './contract.js';
import { CloudBrowserService, readExistingCtoBrowserProfileBinding } from './service.js';

class MemoryStore implements CloudBrowserStore {
  readonly profiles = new Map<string, CloudBrowserProfile>(); readonly sessions = new Map<string, CloudBrowserSession>();
  readonly locks = new Map<string, string>(); profileCreates = 0;
  async loadProfile(id: string): Promise<CloudBrowserProfile | null> { return this.profiles.get(id) ?? null; }
  async saveProfile(v: CloudBrowserProfile): Promise<void> { this.profiles.set(v.profileId, v); }
  async saveProfileIfAbsent(v: CloudBrowserProfile): Promise<boolean> { this.profileCreates += 1; if (this.profiles.has(v.profileId)) return false; this.profiles.set(v.profileId, v); return true; }
  async loadSession(id: string): Promise<CloudBrowserSession | null> { return this.sessions.get(id) ?? null; }
  async saveSession(v: CloudBrowserSession): Promise<void> { this.sessions.set(v.sessionId, v); }
  async saveSessionUnderLock(v: CloudBrowserSession, _owner: string): Promise<void> { this.sessions.set(v.sessionId, v); }
  async deleteSession(id: string): Promise<void> { this.sessions.delete(id); }
  async acquireSessionLock(id: string, owner: string, _until: number): Promise<boolean> { if (this.locks.has(`s:${id}`)) return false; this.locks.set(`s:${id}`, owner); return true; }
  async releaseSessionLock(id: string, owner: string): Promise<void> { if (this.locks.get(`s:${id}`) === owner) this.locks.delete(`s:${id}`); }
  async acquireProfileLock(id: string, owner: string, _until: number): Promise<boolean> { if (this.locks.has(`p:${id}`)) return false; this.locks.set(`p:${id}`, owner); return true; }
  async releaseProfileLock(id: string, owner: string): Promise<void> { if (this.locks.get(`p:${id}`) === owner) this.locks.delete(`p:${id}`); }
  async reserveDailySession(_owner: string, _day: string, _limit: number): Promise<boolean> { return true; }
}
class FakeTransport implements CloudBrowserTransport {
  readonly actions: unknown[] = []; stopped = 0; startedProfiles: CloudBrowserProfile[] = []; savedProfiles = 0;
  providerProfile: CloudBrowserProviderProfile = { profileId: 'otchealth_cto_cloud-dVDhGycboH', name: 'otchealth_cto_cloud', status: 'READY', profileArn: 'arn:aws:bedrock-agentcore:us-east-1:900915535335:browser-profile/otchealth_cto_cloud-dVDhGycboH', lastSavedAt: '2026-09-21T02:41:19.395091Z', lastSavedBrowserId: 'aws.browser.v1' };
  profileReads = 0;
  async start(input: { profile: CloudBrowserProfile }): Promise<Pick<CloudBrowserSession, 'providerSessionId' | 'automationEndpoint'>> { this.startedProfiles.push(input.profile); return { providerSessionId: 'remote-session', automationEndpoint: 'wss://example.test/automation' }; }
  async getBrowserProfile(_id: string): Promise<CloudBrowserProviderProfile> { this.profileReads += 1; return this.providerProfile; }
  async execute(_s: CloudBrowserSession, action: unknown): Promise<{ url: string; title: string; visibleText: string } | null> { this.actions.push(action); return typeof action === 'object' && action !== null && (action as { type?: unknown }).type === 'snapshot' ? { url: 'https://example.test/', title: 'Example', visibleText: '' } : null; }
  async stop(): Promise<void> { this.stopped += 1; }
  async saveProfile(): Promise<void> { this.savedProfiles += 1; }
}

const binding = { profileId: 'otchealth_cto_cloud-dVDhGycboH', name: 'otchealth_cto_cloud', accountId: '900915535335', region: 'us-east-1', browserIdentifier: 'aws.browser.v1' as const, allowedHosts: ['example.test'] };

test('cloud browser persists an opaque session and binds every operation to its caller', async () => {
  let now = 1_000_000; const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport, () => now);
  await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: true });
  const started = await service.start('cto', 'cto-public', 60);
  assert.deepEqual(Object.keys(started).sort(), ['expiresAt', 'sessionId']);
  assert.equal(store.sessions.get(started.sessionId)?.providerSessionId, 'remote-session');
  await assert.rejects(() => service.execute('other', started.sessionId, { type: 'navigate', url: 'https://example.test/' }, 2), (e: unknown) => e instanceof CloudBrowserError && e.code === 'owner_forbidden');
  await service.execute('cto', started.sessionId, { type: 'navigate', url: 'https://example.test/' }, 2);
  assert.equal(transport.actions.length, 2, 'navigation is prevalidated by URL and followed by a guarded current-page observation');
  now += 61_000;
  await assert.rejects(() => service.execute('cto', started.sessionId, { type: 'navigate', url: 'https://example.test/' }, 2), /expired/);
  await service.stop('cto', started.sessionId);
  assert.equal(transport.stopped, 1); assert.equal(store.sessions.has(started.sessionId), false);
});

test('cloud browser rejects hosts, uncontrolled selectors and over-budget action calls before transport', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-public', 60);
  await assert.rejects(() => service.execute('cto', sessionId, { type: 'navigate', url: 'https://evil.test/' }, 1), (e: unknown) => e instanceof CloudBrowserError && e.code === 'host_forbidden');
  await assert.rejects(() => service.execute('cto', sessionId, { type: 'click', selector: 'a\n#bad' }, 1), (e: unknown) => e instanceof CloudBrowserError && e.code === 'invalid_action');
  await assert.rejects(() => service.execute('cto', sessionId, { type: 'wait_for', selector: '#ok' }, 21), (e: unknown) => e instanceof CloudBrowserError && e.code === 'invalid_duration');
  assert.equal(transport.actions.length, 0);
});

test('CTO can provision one deterministic public profile per ordinary Chat lane, while callers discover only their own', async () => {
  const store = new MemoryStore(); const service = new CloudBrowserService(store, new FakeTransport());
  const profile = await service.provisionPublicTrialProfile('cto', 'cfo', ['Example.TEST']);
  assert.deepEqual(profile, { profileId: 'cfo-public-trial', owner: 'cfo', allowedHosts: ['example.test'], persistent: false });
  assert.deepEqual(await service.publicTrialProfile('cfo'), { profileId: 'cfo-public-trial', allowedHosts: ['example.test'], persistent: false });
  await assert.rejects(() => service.publicTrialProfile('cto'), (e: unknown) => e instanceof CloudBrowserError && e.code === 'owner_forbidden');
  await assert.rejects(() => service.provisionPublicTrialProfile('cfo', 'coo', ['example.test']), (e: unknown) => e instanceof CloudBrowserError && e.code === 'provisioner_forbidden');
  await assert.rejects(() => service.provisionPublicTrialProfile('cto', 'clo-personal', ['example.test']), (e: unknown) => e instanceof CloudBrowserError && e.code === 'profile_owner_not_allowed');
});

test('existing CTO profile config is disabled by default and fails closed on incomplete or mismatched account/region', () => {
  assert.equal(readExistingCtoBrowserProfileBinding({} as NodeJS.ProcessEnv), null);
  const full = { CLOUD_BROWSER_CTO_PROFILE_ENABLED: 'true', CLOUD_BROWSER_CTO_PROFILE_ID: binding.profileId, CLOUD_BROWSER_CTO_PROFILE_NAME: binding.name,
    CLOUD_BROWSER_CTO_PROFILE_ACCOUNT_ID: binding.accountId, CLOUD_BROWSER_CTO_PROFILE_REGION: binding.region, CLOUD_BROWSER_CTO_PROFILE_BROWSER_ID: binding.browserIdentifier,
    CLOUD_BROWSER_CTO_PROFILE_ALLOWED_HOSTS: 'example.test', AWS_ACCOUNT_ID: binding.accountId, AWS_REGION: binding.region } as NodeJS.ProcessEnv;
  assert.deepEqual(readExistingCtoBrowserProfileBinding(full), binding);
  assert.throws(() => readExistingCtoBrowserProfileBinding({ ...full, AWS_ACCOUNT_ID: '111111111111' }), /incomplete or invalid/);
  assert.throws(() => readExistingCtoBrowserProfileBinding({ ...full, AWS_REGION: 'us-west-2' }), /incomplete or invalid/);
  assert.throws(() => readExistingCtoBrowserProfileBinding({ ...full, CLOUD_BROWSER_CTO_PROFILE_BROWSER_ID: 'wrong.browser' }), /incomplete or invalid/);
});

test('existing profile rejects other callers before provider reads and fails closed without verifier/config', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport, Date.now, binding);
  await assert.rejects(() => service.discoverExistingCtoProfile('cfo'), (e: unknown) => e instanceof CloudBrowserError && e.code === 'owner_forbidden');
  assert.equal(transport.profileReads, 0);
  transport.providerProfile = { ...transport.providerProfile, status: 'SAVING' };
  await assert.rejects(() => service.discoverExistingCtoProfile('cto'), (e: unknown) => e instanceof CloudBrowserError && e.code === 'profile_binding_verification_failed');
  assert.equal(transport.profileReads, 1);
  transport.providerProfile = { ...transport.providerProfile, status: 'READY' };
  const noVerifier: CloudBrowserTransport = { start: transport.start.bind(transport), execute: transport.execute.bind(transport), stop: transport.stop.bind(transport) };
  await assert.rejects(() => new CloudBrowserService(store, noVerifier, Date.now, binding).discoverExistingCtoProfile('cto'), (e: unknown) => e instanceof CloudBrowserError && e.code === 'profile_verification_unavailable');
  await assert.rejects(() => new CloudBrowserService(store, transport).discoverExistingCtoProfile('cto'), (e: unknown) => e instanceof CloudBrowserError && e.code === 'profile_binding_not_configured');
});

test('existing profile metadata must match configured id, owner account, region, browser identity and READY state', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport, Date.now, binding);
  const good = { ...transport.providerProfile };
  for (const change of [
    { profileId: 'other-1234567890' },
    { profileArn: 'arn:aws:bedrock-agentcore:us-west-2:900915535335:browser-profile/otchealth_cto_cloud-dVDhGycboH' },
    { profileArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:browser-profile/otchealth_cto_cloud-dVDhGycboH' },
    { lastSavedBrowserId: 'other.browser.v1' },
    { status: 'SAVING' },
    { lastSavedAt: undefined },
  ]) {
    transport.providerProfile = { ...good, ...change };
    await assert.rejects(() => service.discoverExistingCtoProfile('cto'), (e: unknown) => e instanceof CloudBrowserError && e.code === 'profile_binding_verification_failed');
  }
  transport.providerProfile = { ...good, status: 'SAVING' };
  await assert.rejects(() => service.bindExistingCtoProfile('cto'), (e: unknown) => e instanceof CloudBrowserError && e.code === 'profile_binding_verification_failed');
});

test('existing same-key records with a foreign owner, provider identity or host policy are never overwritten', async () => {
  const conflicting: CloudBrowserProfile[] = [
    { profileId: binding.profileId, providerProfileId: binding.profileId, owner: 'cfo', allowedHosts: [...binding.allowedHosts], persistent: true },
    { profileId: binding.profileId, providerProfileId: 'other-profile-1234567890', owner: 'cto', allowedHosts: [...binding.allowedHosts], persistent: true },
    { profileId: binding.profileId, providerProfileId: binding.profileId, owner: 'cto', allowedHosts: ['different.test'], persistent: true },
    { profileId: binding.profileId, owner: 'cto', allowedHosts: [...binding.allowedHosts], persistent: false },
  ];
  for (const prior of conflicting) {
    const store = new MemoryStore(); const transport = new FakeTransport(); store.profiles.set(binding.profileId, prior);
    const service = new CloudBrowserService(store, transport, Date.now, binding);
    await assert.rejects(() => service.bindExistingCtoProfile('cto'), (e: unknown) => e instanceof CloudBrowserError && e.code === 'profile_binding_conflict');
    assert.equal(transport.profileReads, 0, 'conflicting local ownership/policy is rejected before provider access');
    assert.equal(store.profileCreates, 0, 'no generic same-owner save can overwrite the conflict');
    assert.deepEqual(store.profiles.get(binding.profileId), prior);
  }
});

test('binding rejects a conflicting local profile that appears during provider verification', async () => {
  for (const prior of [
    { profileId: binding.profileId, providerProfileId: binding.profileId, owner: 'cfo', allowedHosts: [...binding.allowedHosts], persistent: true },
    { profileId: binding.profileId, providerProfileId: 'other-profile-1234567890', owner: 'cto', allowedHosts: [...binding.allowedHosts], persistent: true },
    { profileId: binding.profileId, providerProfileId: binding.profileId, owner: 'cto', allowedHosts: ['different.test'], persistent: true },
  ]) {
    const store = new MemoryStore(); const transport = new FakeTransport();
    transport.getBrowserProfile = async () => { transport.profileReads += 1; await store.saveProfile(prior); return transport.providerProfile; };
    const service = new CloudBrowserService(store, transport, Date.now, binding);
    await assert.rejects(() => service.bindExistingCtoProfile('cto'), (error: unknown) => error instanceof CloudBrowserError && error.code === 'profile_binding_conflict');
    assert.equal(transport.profileReads, 1);
    assert.equal(store.profileCreates, 0);
    assert.deepEqual(store.profiles.get(binding.profileId), prior);
  }
});

test('explicit binding persists only the verified own profile and keeps restore/save provider wiring', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport, () => 1_000_000, binding);
  const discovered = await service.discoverExistingCtoProfile('cto');
  assert.deepEqual(discovered, { profileId: binding.profileId, name: binding.name, accountId: binding.accountId, region: binding.region,
    browserIdentifier: 'aws.browser.v1', status: 'READY', lastSavedAt: transport.providerProfile.lastSavedAt, persistent: true });
  assert.equal(store.profiles.has(binding.profileId), false, 'discovery does not persist a binding');
  await service.bindExistingCtoProfile('cto');
  assert.deepEqual(store.profiles.get(binding.profileId), { profileId: binding.profileId, providerProfileId: binding.profileId, owner: 'cto', allowedHosts: binding.allowedHosts, persistent: true });
  const started = await service.start('cto', binding.profileId, 60);
  assert.equal(transport.startedProfiles[0]?.providerProfileId, binding.profileId);
  await service.savePersistentProfile('cto', started.sessionId);
  assert.equal(transport.savedProfiles, 1);
  assert.equal(transport.profileReads, 2, 'only the two explicit metadata operations read provider state');
});

test('session action lease fences concurrent gateway copies and preserves action increments', async () => {
  const store = new MemoryStore(); let release!: () => void; const entered = new Promise<void>((resolve) => { release = resolve; });
  const transport = new FakeTransport(); transport.execute = async (_s, action) => { transport.actions.push(action); await entered; return typeof action === 'object' && action !== null && (action as { type?: unknown }).type === 'snapshot' ? { url: 'https://example.test/', title: 'Example', visibleText: '' } : null; };
  const service = new CloudBrowserService(store, transport); await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-public', 60);
  const first = service.execute('cto', sessionId, { type: 'wait_for', selector: '#ok' }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => service.execute('cto', sessionId, { type: 'wait_for', selector: '#ok' }, 1), (e: unknown) => e instanceof CloudBrowserError && e.code === 'session_busy');
  release(); await first;
  assert.equal(store.sessions.get(sessionId)?.actionsUsed, 1);
});
