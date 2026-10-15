import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import type { WebSocket } from 'undici';
import { AgentCoreCloudBrowserTransport } from './agentcore-transport.js';
import type { CloudBrowserSession } from './contract.js';
import { CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS } from './service.js';
import { websiteLoginPolicy, type WebsiteLoginSite } from './website-login-service.js';

let previousEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  previousEnv = { ...process.env };
  process.env.AWS_ACCESS_KEY_ID = 'synthetic-human-control-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'synthetic-human-control-secret';
  process.env.AWS_SESSION_TOKEN = 'synthetic-human-control-session';
});
afterEach(() => { process.env = previousEnv; });

const SITE = 'linkedin' as WebsiteLoginSite;
const POLICY = websiteLoginPolicy(SITE);
const SESSION_ID = 'syntheticSession123';
const BROWSER_ID = 'aws.browser.v1';
const TARGET_ID = 'owned-login-tab';

type Event = { kind: 'cdp'; method: string; params?: Record<string, unknown> } | { kind: 'cdp-close' } | { kind: 'http'; url: string; init: RequestInit };

class FakeSocket {
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  readonly sent: Array<Record<string, unknown>> = [];
  constructor(private readonly events: Event[]) {
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
    if (type === 'open') listener({});
  }
  send(raw: string): void {
    const message = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
    this.sent.push(message);
    this.events.push({ kind: 'cdp', method: message.method, params: message.params });
    const result = message.method === 'Target.getTargets'
      ? { targetInfos: [{ type: 'page', targetId: TARGET_ID, url: 'https://www.linkedin.com/feed/' }] }
      : message.method === 'Target.attachToTarget'
        ? { sessionId: 'synthetic-cdp-session' }
        : message.method === 'DOM.getDocument'
          ? { root: { nodeId: 7 } }
          : message.method === 'DOM.querySelector'
            ? { nodeId: 0 }
            : {};
    this.emit('message', { data: JSON.stringify({ id: message.id, result }) });
  }
  close(): void {
    this.events.push({ kind: 'cdp-close' });
    this.emit('close', {});
  }
  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function makeSession(overrides: Partial<CloudBrowserSession> = {}): CloudBrowserSession {
  assert.ok(CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS.length, 'the test needs an existing allowlisted owner');
  return {
    owner: CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS[0],
    ownerSubjectHash: 'a'.repeat(64),
    sensitiveOutputSuppressed: true,
    providerBrowserId: BROWSER_ID,
    providerSessionId: SESSION_ID,
    automationEndpoint: 'wss://browser.example.invalid/automation',
    allowedHosts: [...POLICY.allowedHosts],
    selectedTargetId: TARGET_ID,
    ownedTargetIds: [TARGET_ID],
    ...overrides,
  } as CloudBrowserSession;
}

function createHarness() {
  const events: Event[] = [];
  const socket = new FakeSocket(events);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    events.push({ kind: 'http', url, init });
    throw new Error('Transport must not duplicate the service-owned automation transfer');
  };
  const transport = new AgentCoreCloudBrowserTransport(
    'us-east-1',
    fetchImpl as typeof fetch,
    (() => socket as unknown as WebSocket) as (url: string, options: { headers: Record<string, string> }) => WebSocket,
  );
  return { transport, events, socket, calls };
}

function assertNoSensitiveInspection(socket: FakeSocket): void {
  const forbidden = /Runtime\.|DOM\.(getOuterHTML|getAttributes|getBoxModel|querySelectorAll)|Network\.|Storage\.|Cookie|Accessibility|AX\./i;
  assert.deepEqual(socket.sent.map(({ method }) => method).filter(method => forbidden.test(String(method))), []);
  for (const { method, params } of socket.sent) {
    if (method === 'Page.navigate') assert.deepEqual(Object.keys(params ?? {}).sort(), ['url']);
    if (method === 'DOM.querySelector') assert.deepEqual(params, { nodeId: 7, selector: 'input[type="password"]' });
  }
}

test('prepare navigates and closes bounded CDP without duplicating service-owned control transfer', async () => {
  const h = createHarness();
  await h.transport.prepareWebsiteLogin(makeSession(), SITE);
  assert.equal(h.calls.length, 0, 'the service/provider is the single stream controller');
  const navigation = h.events.findIndex(e => e.kind === 'cdp' && e.method === 'Page.navigate');
  assert.ok(navigation >= 0);
  assert.ok(h.events.findIndex(e => e.kind === 'cdp-close') > navigation);
  assertNoSensitiveInspection(h.socket);
});

test('verify uses the service-confirmed endpoint without a second automation transfer', async () => {
  const h = createHarness();
  await h.transport.verifyWebsiteLogin(makeSession(), SITE);
  assert.equal(h.calls.length, 0, 'a second transfer must not invalidate the persisted endpoint');
  assert.ok(h.socket.sent.some(({ method }) => method === 'DOM.querySelector'));
  assertNoSensitiveInspection(h.socket);
});

for (const [label, overrides] of [
  ['owner outside the allowlist', { owner: 'not-allowlisted' }],
  ['sensitive output suppression disabled', { sensitiveOutputSuppressed: false }],
] as const) {
  test(`prepare rejects ${label} before any provider or stream update`, async () => {
    const h = createHarness();
    await assert.rejects(h.transport.prepareWebsiteLogin(makeSession(overrides), SITE));
    assert.equal(h.calls.length, 0);
    assert.equal(h.socket.sent.length, 0);
  });
  test(`verify rejects ${label} before any provider or stream update`, async () => {
    const h = createHarness();
    await assert.rejects(h.transport.verifyWebsiteLogin(makeSession(overrides), SITE));
    assert.equal(h.calls.length, 0);
    assert.equal(h.socket.sent.length, 0);
  });
}
