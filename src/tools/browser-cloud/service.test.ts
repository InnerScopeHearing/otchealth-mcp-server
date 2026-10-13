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
  readonly actions: unknown[] = []; stopped = 0; uncertainCreate = false;
  async start(): Promise<Pick<CloudBrowserSession, 'providerSessionId' | 'automationEndpoint'>> { return { providerSessionId: 'remote-session', automationEndpoint: 'wss://example.test/automation' }; }
  async execute(s: CloudBrowserSession, action: unknown): Promise<{ url: string; title: string; visibleText: string } | null | { observation: null; pageReceipt: { selectedTargetId: string | null; createdTargetId?: string; closedTargetId?: string; completed: true } }> {
    this.actions.push(action); const a = action as { type?: string; targetId?: string };
    if (a.type === 'snapshot') { if (!s.ownedTargetIds) { s.ownedTargetIds = ['initial-owned']; s.selectedTargetId = 'initial-owned'; } if (s.selectedTargetId === null) throw new CloudBrowserError('target_not_selected', 'no selected target'); return { url: 'https://example.test/', title: 'Example', visibleText: '' }; }
    if (a.type === 'tab_create') { if (this.uncertainCreate) { s.effectUnknown = true; throw new CloudBrowserError('target_create_uncertain', 'uncertain'); } s.ownedTargetIds ??= ['initial-owned']; if (s.selectedTargetId === null) s.selectedTargetId = 'new-owned'; s.selectedTargetId ??= 'initial-owned'; s.ownedTargetIds.push('new-owned'); return { observation: null, pageReceipt: { selectedTargetId: s.selectedTargetId, createdTargetId: 'new-owned', completed: true } }; }
    if (a.type === 'tab_select') { s.ownedTargetIds ??= ['initial-owned']; s.selectedTargetId = a.targetId!; return { observation: null, pageReceipt: { selectedTargetId: a.targetId!, completed: true } }; }
    if (a.type === 'tab_close') { s.ownedTargetIds ??= ['initial-owned']; s.ownedTargetIds = s.ownedTargetIds.filter(id => id !== a.targetId); if (s.selectedTargetId === a.targetId) s.selectedTargetId = null; return { observation: null, pageReceipt: { selectedTargetId: s.selectedTargetId ?? null, closedTargetId: a.targetId!, completed: true } }; }
    return null;
  }
  async stop(): Promise<void> { this.stopped += 1; }
}

test('typed keys, pointer and scroll controls retain session owner and host guards', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-public', 60);
  await service.execute('cto', sessionId, { type: 'press_key', key: 'Enter' }, 2);
  await service.execute('cto', sessionId, { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 100 }, 2);
  assert.equal(store.sessions.get(sessionId)?.actionsUsed, 2);
  const before = transport.actions.length;
  await assert.rejects(service.execute('cfo', sessionId, { type: 'press_key', key: 'Enter' }, 2), /unavailable/);
  await assert.rejects(service.execute('cto', sessionId, { type: 'mouse_move', x: -1, y: 0 }, 2), (error: unknown) => error instanceof CloudBrowserError && error.code === 'invalid_action');
  assert.equal(transport.actions.length, before);
  transport.execute = async () => ({ url: 'https://offpolicy.test/', title: '', visibleText: '' });
  await assert.rejects(service.execute('cto', sessionId, { type: 'press_key', key: 'Enter' }, 2), (error: unknown) => error instanceof CloudBrowserError && error.code === 'redirect_outside_allowlist');
});

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

test('page actions return owned tab receipts and persist selection under the session lock', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-public', 60);
  const created = await service.execute('cto', sessionId, { type: 'tab_create', url: 'https://example.test/new' } as never, 2) as { createdTargetId?: string };
  assert.equal(created.createdTargetId, 'new-owned');
  const selected = await service.execute('cto', sessionId, { type: 'tab_select', targetId: 'new-owned' } as never, 2) as { selectedTargetId?: string };
  assert.equal(selected.selectedTargetId, 'new-owned');
  assert.deepEqual(store.sessions.get(sessionId)?.ownedTargetIds, ['initial-owned', 'new-owned']);
  assert.equal(store.sessions.get(sessionId)?.selectedTargetId, 'new-owned');
});

test('unknown tab creation acknowledgement is persisted and blocks later effects', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-public', 60); transport.uncertainCreate = true;
  await assert.rejects(service.execute('cto', sessionId, { type: 'tab_create', url: 'https://example.test/new' } as never, 2), (error: unknown) => error instanceof CloudBrowserError && error.code === 'target_create_uncertain');
  assert.equal(store.sessions.get(sessionId)?.effectUnknown, true);
  transport.uncertainCreate = false; const count = transport.actions.length;
  await assert.rejects(service.execute('cto', sessionId, { type: 'press_key', key: 'Enter' }, 2), (error: unknown) => error instanceof CloudBrowserError && error.code === 'effect_unknown');
  assert.equal(transport.actions.length, count);
});

test('selecting a remaining owned tab works after the selected tab was closed', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-public', 60);
  const session = store.sessions.get(sessionId)!; session.ownedTargetIds = ['remaining-owned']; session.selectedTargetId = null;
  const result = await service.execute('cto', sessionId, { type: 'tab_select', targetId: 'remaining-owned' } as never, 2) as { selectedTargetId?: string };
  assert.equal(result.selectedTargetId, 'remaining-owned');
});

test('closing the last selected tab allows creating and selecting a replacement tab', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-public', 60);
  await service.execute('cto', sessionId, { type: 'snapshot' }, 2);
  const closed = await service.execute('cto', sessionId, { type: 'tab_close', targetId: 'initial-owned' } as never, 2) as { selectedTargetId?: string | null };
  assert.equal(closed.selectedTargetId, null);
  const created = await service.execute('cto', sessionId, { type: 'tab_create', url: 'https://example.test/new' } as never, 2) as { selectedTargetId?: string };
  assert.equal(created.selectedTargetId, 'new-owned');
  const selected = await service.execute('cto', sessionId, { type: 'tab_select', targetId: 'new-owned' } as never, 2) as { selectedTargetId?: string };
  assert.equal(selected.selectedTargetId, 'new-owned');
  assert.equal(store.sessions.get(sessionId)?.effectUnknown, false);
});

test('tab create intent and consumed action are durable before provider invocation', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-public', 60);
  const original = transport.execute.bind(transport); let sawIntent = false;
  transport.execute = async (session, action, timeout) => {
    if ((action as { type?: string }).type === 'tab_create') {
      const durable = store.sessions.get(sessionId)!;
      sawIntent = durable.effectUnknown === true && durable.actionsUsed === 1;
    }
    return original(session, action, timeout);
  };
  await service.execute('cto', sessionId, { type: 'tab_create', url: 'https://example.test/new' } as never, 2);
  assert.equal(sawIntent, true);
  assert.equal(store.sessions.get(sessionId)?.effectUnknown, false);
  assert.equal(store.sessions.get(sessionId)?.actionsUsed, 1);
});

test('failed durable effect intent prevents tab creation from reaching the provider', async () => {
  const store = new MemoryStore(); const transport = new FakeTransport(); const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-public', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-public', 60);
  const save = store.saveSessionUnderLock.bind(store);
  store.saveSessionUnderLock = async (session, owner) => {
    if (session.effectUnknown) throw new Error('durable write failed');
    return save(session, owner);
  };
  const before = transport.actions.length;
  await assert.rejects(service.execute('cto', sessionId, { type: 'tab_create', url: 'https://example.test/new' } as never, 2), /durable write failed/);
  assert.equal(transport.actions.some(action => (action as { type?: string }).type === 'tab_create'), false);
  assert.equal(transport.actions.length, before + 1, 'only the safe preflight snapshot reached the provider');
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
