import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'undici';
import { AgentCoreCloudBrowserTransport } from './agentcore-transport.js';
import type { CloudBrowserSession } from './contract.js';
import type { AwsCredentials } from '../../search/sigv4.js';

const session = { providerSessionId: 'publicsession123', automationEndpoint: 'wss://bedrock-agentcore.us-east-1.amazonaws.com/test' } as CloudBrowserSession;
test('existing profile metadata uses one configured GET and the AgentCore control signing name', async () => {
  const calls: { url: string; method: string; body?: string; authorization?: string }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? '', body: init?.body ? String(init.body) : undefined,
      authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    return new Response(JSON.stringify({ profileId: 'otchealth_cto_cloud-dVDhGycboH', name: 'otchealth_cto_cloud', status: 'READY',
      profileArn: 'arn:aws:bedrock-agentcore:us-east-1:900915535335:browser-profile/otchealth_cto_cloud-dVDhGycboH',
      lastSavedAt: '2026-09-21T02:41:19.395091Z', lastSavedBrowserId: 'aws.browser.v1' }), { status: 200 });
  }) as typeof fetch;
  const credentials: AwsCredentials = { accessKeyId: 'test-access', secretAccessKey: 'test-secret', sessionToken: 'test-token' };
  const transport = new AgentCoreCloudBrowserTransport('us-east-1', fetcher, undefined, async () => credentials);
  const result = await transport.getBrowserProfile('otchealth_cto_cloud-dVDhGycboH');
  assert.equal(result.status, 'READY');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(new URL(calls[0]!.url).hostname, 'bedrock-agentcore-control.us-east-1.amazonaws.com');
  assert.equal(new URL(calls[0]!.url).pathname, '/browser-profiles/otchealth_cto_cloud-dVDhGycboH');
  assert.equal(calls[0]?.body, undefined);
  assert.match(calls[0]?.authorization ?? '', /Credential=test-access\/\d{8}\/us-east-1\/bedrock-agentcore\/aws4_request/);
});
test('persistent session restore and save use only the bound profile/session identifiers', async () => {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? '', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
    return new Response(JSON.stringify({ sessionId: 'bound-session', streams: { automationStream: { streamEndpoint: session.automationEndpoint } } }), { status: 200 });
  }) as typeof fetch;
  const credentials: AwsCredentials = { accessKeyId: 'test-access', secretAccessKey: 'test-secret', sessionToken: 'test-token' };
  const transport = new AgentCoreCloudBrowserTransport('us-east-1', fetcher, undefined, async () => credentials);
  const profile: import('./contract.js').CloudBrowserProfile = { profileId: 'otchealth_cto_cloud-dVDhGycboH', providerProfileId: 'otchealth_cto_cloud-dVDhGycboH',
    owner: 'cto', allowedHosts: ['example.test'], persistent: true };
  const started = await transport.start({ owner: 'cto', profile, maxSeconds: 90 });
  assert.equal(started.providerSessionId, 'bound-session');
  assert.equal(new URL(calls[0]!.url).hostname, 'bedrock-agentcore.us-east-1.amazonaws.com');
  assert.deepEqual(calls[0]?.body.profileConfiguration, { profileIdentifier: profile.providerProfileId });
  const active = { ...session, providerSessionId: 'bound-session' };
  await transport.saveProfile(active, profile);
  assert.equal(calls[1]?.method, 'PUT');
  assert.equal(new URL(calls[1]!.url).hostname, 'bedrock-agentcore.us-east-1.amazonaws.com');
  assert.equal(new URL(calls[1]!.url).pathname, `/browser-profiles/${profile.providerProfileId}/save`);
  assert.deepEqual({ browserIdentifier: calls[1]?.body.browserIdentifier, sessionId: calls[1]?.body.sessionId }, { browserIdentifier: 'aws.browser.v1', sessionId: 'bound-session' });
  assert.equal('cookies' in calls[1]!.body, false);
});
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
