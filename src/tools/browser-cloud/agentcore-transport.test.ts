import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'undici';
import { AgentCoreCloudBrowserTransport } from './agentcore-transport.js';
import type { CloudBrowserSession } from './contract.js';

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
