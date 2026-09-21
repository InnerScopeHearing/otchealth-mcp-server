import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudBrowserError, type CloudBrowserProfile, type CloudBrowserSession, type CloudBrowserStore, type CloudBrowserTransport } from './contract.js';
import { CloudBrowserService } from './service.js';

class MemoryStore implements CloudBrowserStore {
  readonly profiles = new Map<string, CloudBrowserProfile>(); readonly sessions = new Map<string, CloudBrowserSession>();
  readonly locks = new Map<string, string>();
  async loadProfile(id: string): Promise<CloudBrowserProfile | null> { return this.profiles.get(id) ?? null; }
  async saveProfile(v: CloudBrowserProfile): Promise<void> { this.profiles.set(v.profileId, v); }
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
  readonly actions: unknown[] = []; stopped = 0;
  async start(): Promise<Pick<CloudBrowserSession, 'providerSessionId' | 'automationEndpoint'>> { return { providerSessionId: 'remote-session', automationEndpoint: 'wss://example.test/automation' }; }
  async execute(_s: CloudBrowserSession, action: unknown): Promise<{ url: string; title: string; visibleText: string } | null> { this.actions.push(action); return typeof action === 'object' && action !== null && (action as { type?: unknown }).type === 'snapshot' ? { url: 'https://example.test/', title: 'Example', visibleText: '' } : null; }
  async stop(): Promise<void> { this.stopped += 1; }
}

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
