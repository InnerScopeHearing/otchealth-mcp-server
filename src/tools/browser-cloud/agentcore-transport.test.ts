import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'undici';
import { AgentCoreCloudBrowserTransport } from './agentcore-transport.js';
import type { CloudBrowserSession } from './contract.js';
import type { CloudBrowserProfile, CloudBrowserStore } from './contract.js';
import { CloudBrowserService } from './service.js';

const session = { providerSessionId: 'publicsession123', automationEndpoint: 'wss://bedrock-agentcore.us-east-1.amazonaws.com/test' } as CloudBrowserSession;
test('provider start omits unsupported tags and stop uses signed PUT query', async t => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; }); process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? '', body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ sessionId: 'publicsession123', streams: { automationStream: { streamEndpoint: session.automationEndpoint } } }));
  }) as typeof fetch;
  const transport = new AgentCoreCloudBrowserTransport('us-east-1', fetcher);
  await transport.start({ owner: 'cto', profile: { owner: 'cto', profileId: 'public', allowedHosts: ['example.com'], persistent: false }, maxSeconds: 60 });
  assert.equal('tags' in calls[0].body, false);
  await transport.stop(session);
  assert.equal(calls[1].method, 'PUT');
  assert.equal(new URL(calls[1].url).pathname, '/browsers/aws.browser.v1/sessions/stop');
  assert.equal(new URL(calls[1].url).searchParams.get('sessionId'), 'publicsession123');
  assert.equal(typeof calls[1].body.clientToken, 'string');
});

test('CDP initializes DOM and clicks center through signed injected WebSocket', async t => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; }); process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const commands: { id: number; method: string; params: Record<string, unknown> }[] = [];
  let closed = false;
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as typeof commands[number]; commands.push(cmd);
      const replies: Record<string, unknown> = {
        'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'target' }] },
        'Target.attachToTarget': { sessionId: 'page' },
        'DOM.performSearch': { resultCount: 1, searchId: 'search' },
        'DOM.getSearchResults': { nodeIds: [5] },
        'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 60, 10, 60] } },
      };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: cmd.id, result: replies[cmd.method] ?? {} }) })));
    }
    close() { closed = true; this.dispatchEvent(new Event('close')); }
  }
  const factory = (_url: string, options: { headers: Record<string, string> }) => {
    assert.ok(Object.keys(options.headers).some(k => k.toLowerCase() === 'authorization'));
    const socket = new Socket(); queueMicrotask(() => socket.dispatchEvent(new Event('open')));
    return socket as unknown as WebSocket;
  };
  await new AgentCoreCloudBrowserTransport('us-east-1', fetch, factory).execute(session, { type: 'click', selector: '#button' }, 2);
  assert.ok(commands.findIndex(c => c.method === 'DOM.getDocument') < commands.findIndex(c => c.method === 'DOM.performSearch'));
  const press = commands.find(c => c.method === 'Input.dispatchMouseEvent');
  assert.deepEqual([press?.params.x, press?.params.y], [20, 40]);
  assert.equal(closed, true);
});

test('selected owned tab is reused after a new provider stream connection', async t => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; }); process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }; calls.push(cmd);
      const replies: Record<string, unknown> = {
        'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'first', url: 'https://example.test/one' }, { type: 'page', targetId: 'second', url: 'https://example.test/two' }] },
        'Target.attachToTarget': { sessionId: String(cmd.params.targetId) },
        'Target.activateTarget': {},
        'Page.getNavigationHistory': { currentIndex: 0, entries: [{ url: 'https://example.test/two', title: 'Two' }] },
        'Accessibility.getFullAXTree': { nodes: [] },
      };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: cmd.id, result: replies[cmd.method] ?? {} }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const factory = () => { const socket = new Socket(); queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket as unknown as WebSocket; };
  const ownedSession = { ...session, allowedHosts: ['example.test'], ownedTargetIds: ['first', 'second'], selectedTargetId: 'first' } as CloudBrowserSession;
  const transport = new AgentCoreCloudBrowserTransport('us-east-1', fetch, factory);
  await transport.execute(ownedSession, { type: 'tab_select', targetId: 'second' }, 2);
  const observation = await transport.execute(ownedSession, { type: 'snapshot' }, 2);
  assert.equal(ownedSession.selectedTargetId, 'second');
  assert.equal((observation as { url?: string }).url, 'https://example.test/two');
  assert.equal(calls.filter(call => call.method === 'Target.attachToTarget').at(-1)?.params.targetId, 'second');
});

test('creating a tab with no selection activates it for the required post-action observation', async t => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; }); process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []; let created = false;
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }; calls.push(cmd);
      let result: Record<string, unknown> = {};
      if (cmd.method === 'Target.getTargets') result = { targetInfos: [...(created ? [{ type: 'page', targetId: 'created-tab', url: 'https://example.test/new' }] : [{ type: 'page', targetId: 'unowned-popup', url: 'https://example.test/popup' }])] };
      if (cmd.method === 'Target.createTarget') { created = true; result = { targetId: 'created-tab' }; }
      if (cmd.method === 'Target.activateTarget') result = {};
      if (cmd.method === 'Target.attachToTarget') result = { sessionId: 'created-page' };
      if (cmd.method === 'Page.getNavigationHistory') result = { currentIndex: 0, entries: [{ url: 'https://example.test/new', title: 'New' }] };
      if (cmd.method === 'Accessibility.getFullAXTree') result = { nodes: [] };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: cmd.id, result }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const factory = () => { const socket = new Socket(); queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket as unknown as WebSocket; };
  const noSelection = { ...session, allowedHosts: ['example.test'], ownedTargetIds: [], selectedTargetId: null } as CloudBrowserSession;
  const transport = new AgentCoreCloudBrowserTransport('us-east-1', fetch, factory);
  const createdResult = await transport.execute(noSelection, { type: 'tab_create', url: 'https://example.test/new' }, 2) as { pageReceipt?: { selectedTargetId?: string | null } };
  assert.equal(createdResult.pageReceipt?.selectedTargetId, 'created-tab');
  const observation = await transport.execute(noSelection, { type: 'snapshot' }, 2) as { url?: string };
  assert.equal(observation.url, 'https://example.test/new');
  assert.equal(noSelection.selectedTargetId, 'created-tab');
  assert.equal(calls.some(call => call.method === 'Target.activateTarget' && call.params.targetId === 'created-tab'), true);
  assert.equal(calls.some(call => call.method === 'Target.attachToTarget' && call.params.targetId === 'unowned-popup'), false);
});

test('service and AgentCore transport recover through close-last, create, then select', async t => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; }); process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const targets = new Map([['first-tab', 'https://example.test/first']]); let serial = 0;
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }; let result: Record<string, unknown> = {};
      if (cmd.method === 'Target.getTargets') result = { targetInfos: [...targets].map(([targetId, url]) => ({ type: 'page', targetId, url })) };
      if (cmd.method === 'Target.attachToTarget') result = { sessionId: String(cmd.params.targetId) };
      if (cmd.method === 'Target.closeTarget') { targets.delete(String(cmd.params.targetId)); result = { success: true }; }
      if (cmd.method === 'Target.createTarget') { const targetId = `created-${++serial}`; targets.set(targetId, String(cmd.params.url)); result = { targetId }; }
      if (cmd.method === 'Page.getNavigationHistory') { const url = targets.get('created-1') ?? targets.get('first-tab') ?? 'https://example.test/first'; result = { currentIndex: 0, entries: [{ url, title: 'Page' }] }; }
      if (cmd.method === 'Accessibility.getFullAXTree') result = { nodes: [] };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: cmd.id, result }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const factory = () => { const socket = new Socket(); queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket as unknown as WebSocket; };
  class Store implements CloudBrowserStore {
    profiles = new Map<string, CloudBrowserProfile>(); sessions = new Map<string, CloudBrowserSession>(); locks = new Set<string>();
    async loadProfile(id: string) { return this.profiles.get(id) ?? null; } async saveProfile(p: CloudBrowserProfile) { this.profiles.set(p.profileId, p); }
    async loadSession(id: string) { return this.sessions.get(id) ?? null; } async saveSession(s: CloudBrowserSession) { this.sessions.set(s.sessionId, s); }
    async saveSessionUnderLock(s: CloudBrowserSession) { this.sessions.set(s.sessionId, s); } async deleteSession(id: string) { this.sessions.delete(id); }
    async acquireSessionLock(id: string) { if (this.locks.has(id)) return false; this.locks.add(id); return true; } async releaseSessionLock(id: string) { this.locks.delete(id); }
    async acquireProfileLock(id: string) { if (this.locks.has(id)) return false; this.locks.add(id); return true; } async releaseProfileLock(id: string) { this.locks.delete(id); }
    async reserveDailySession() { return true; }
  }
  const fetcher = (async () => new Response(JSON.stringify({ sessionId: 'remote-session', streams: { automationStream: { streamEndpoint: session.automationEndpoint } } }))) as typeof fetch;
  const store = new Store(); const service = new CloudBrowserService(store, new AgentCoreCloudBrowserTransport('us-east-1', fetcher, factory));
  await service.saveProfile('cto', { profileId: 'cto-owned-tabs', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-owned-tabs', 60);
  await service.snapshot('cto', sessionId);
  const close = await service.execute('cto', sessionId, { type: 'tab_close', targetId: 'first-tab' }, 2) as { selectedTargetId?: string | null };
  assert.equal(close.selectedTargetId, null);
  const create = await service.execute('cto', sessionId, { type: 'tab_create', url: 'https://example.test/new' }, 2) as { createdTargetId?: string; selectedTargetId?: string | null };
  assert.equal(create.createdTargetId, 'created-1'); assert.equal(create.selectedTargetId, 'created-1');
  const select = await service.execute('cto', sessionId, { type: 'tab_select', targetId: 'created-1' }, 2) as { selectedTargetId?: string };
  assert.equal(select.selectedTargetId, 'created-1'); assert.equal(store.sessions.get(sessionId)?.effectUnknown, false);
});
