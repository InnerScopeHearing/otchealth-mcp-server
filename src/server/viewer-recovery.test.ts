import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { registerWebsiteLoginPage } from './intercom-login-page.js';

const TOKEN = 'A'.repeat(43);
const HANDOFF_ID = createHash('sha256').update(TOKEN).digest('hex').slice(0, 32);
const STORAGE_KEY = 'otc.website-login.handoff:/browser/connect';
const VIEWER = { status: 'login_required', signed_url: 'https://bedrock-agentcore.example/live-view?signature=private', expires_at: 1_900_000_000_000, workspace_id: 'linkedin', handoff_id: HANDOFF_ID };
type Reply = { ok: boolean; status?: number; json: () => Promise<unknown> };
const response = (body: unknown, status = 200): Reply => ({ ok: status === 200, status, json: async () => body });
const busy = () => response({ error: 'login_operation_busy' }, 409);
const saved = () => response({ status: 'saved', workspace_id: 'linkedin' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function viewer(options: { stored?: Map<string, string>; resume?: () => Promise<Reply>; complete?: () => Promise<Reply> } = {}) {
  const app = Fastify(); registerWebsiteLoginPage(app);
  let script: string;
  try {
    const page = await app.inject({ method: 'GET', url: '/browser/connect' });
    script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1] ?? '';
    assert.ok(script);
  } finally { await app.close(); }
  const stored = options.stored ?? new Map<string, string>();
  const listeners = new Map<string, () => Promise<void>>();
  const state = { requests: [] as string[], disconnects: 0, captures: [] as boolean[] };
  const nodes: Record<string, any> = {};
  for (const id of ['title', 'status', 'stage', 'done', 'clipboard-copy', 'clipboard-paste', 'clipboard-status', 'dcv-display']) nodes[id] = {
    disabled: true, textContent: '', dataset: {}, style: {}, focus: () => {},
    addEventListener: (event: string, callback: () => Promise<void>) => { listeners.set(`${id}:${event}`, callback); },
  };
  const connection = { captureClipboardEvents: (enabled: boolean) => { state.captures.push(enabled); }, syncClipboards: () => true, disconnect: () => { state.disconnects++; } };
  runInNewContext(script, {
    URL, URLSearchParams, history: { replaceState: () => {} }, document: { getElementById: (id: string) => nodes[id] },
    window: {
      location: { hash: options.stored ? '' : `#token=${TOKEN}`, pathname: '/browser/connect', origin: 'https://mcp.otchealth.app' }, addEventListener: () => {},
      sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { assert.match(value, /^[a-f0-9]{32}$/); stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } },
      dcv: { LogLevel: { SILENT: 0 }, setLogLevel: () => {}, authenticate: (_url: string, callbacks: any) => callbacks.success(null, [{ sessionId: 'same-session', authToken: 'private' }]), connect: async () => connection },
    },
    fetch: async (path: string, init: { body: string }) => {
      state.requests.push(path);
      if (path.endsWith('/exchange')) { assert.equal(init.body, JSON.stringify({ token: TOKEN })); return response(VIEWER); }
      assert.equal(init.body, JSON.stringify({ handoff_id: HANDOFF_ID }));
      if (path.endsWith('/resume')) return options.resume ? await options.resume() : response(VIEWER);
      assert.equal(path, '/browser/connect/complete');
      return options.complete ? await options.complete() : saved();
    },
  });
  await tick();
  const clickDone = () => { const handler = listeners.get('done:click'); assert.ok(handler); return handler(); };
  return { stored, state, nodes, clickDone };
}

test('a pre-claim busy resume keeps the same selector for a later explicit reload without automatic retries', async () => {
  const stored = new Map([[STORAGE_KEY, HANDOFF_ID]]);
  const first = await viewer({ stored, resume: async () => busy() });
  assert.equal(stored.get(STORAGE_KEY), HANDOFF_ID);
  assert.deepEqual(first.state.requests, ['/browser/connect/resume']);
  assert.equal(first.nodes.done.disabled, true);
  assert.match(first.nodes.status.textContent, /progress|busy/i);
  const reloaded = await viewer({ stored });
  assert.equal(reloaded.nodes.done.disabled, false);
  assert.deepEqual(reloaded.state.requests, ['/browser/connect/resume']);
});

test('Done keeps the selector while its outcome is pending and never dispatches duplicate saves', async () => {
  let finish!: (reply: Reply) => void;
  const pending = new Promise<Reply>(resolve => { finish = resolve; });
  const v = await viewer({ complete: async () => pending });
  const completing = v.clickDone();
  assert.equal(v.stored.get(STORAGE_KEY), HANDOFF_ID);
  assert.equal(v.nodes.done.disabled, true);
  await v.clickDone();
  assert.equal(v.state.requests.filter(path => path.endsWith('/complete')).length, 1);
  finish(saved()); await completing;
  assert.equal(v.stored.size, 0); assert.equal(v.state.disconnects, 1);
});

test('only a proven pre-claim Done conflict preserves recovery and allows a subsequent manual confirmation', async () => {
  let attempts = 0;
  const v = await viewer({ complete: async () => ++attempts === 1 ? busy() : saved() });
  await v.clickDone();
  assert.equal(v.stored.get(STORAGE_KEY), HANDOFF_ID);
  assert.equal(v.nodes.done.disabled, false);
  assert.equal(v.nodes['clipboard-copy'].disabled, true); assert.equal(v.nodes['clipboard-paste'].disabled, true);
  assert.match(v.nodes.status.textContent, /progress|busy/i);
  assert.equal(attempts, 1, 'no automatic save retry');
  await v.clickDone();
  assert.equal(attempts, 2); assert.equal(v.stored.size, 0); assert.equal(v.nodes.done.disabled, true);
  v.nodes.done.disabled = false; await v.clickDone(); assert.equal(attempts, 2, 'saved remains terminal');
});

test('unknown or terminal Done failures close recovery and cannot replay a potentially claimed save', async () => {
  for (const outcome of ['terminal', 'raw-session-busy', 'network', 'network-busy-string', 'invalid-success']) {
    let attempts = 0;
    const v = await viewer({ complete: async () => {
      attempts++;
      if (outcome === 'network') throw new Error('private network failure');
      if (outcome === 'network-busy-string') throw new Error('login_operation_busy');
      if (outcome === 'invalid-success') return response({ status: 'unexpected' });
      return response({ error: outcome === 'raw-session-busy' ? 'session_busy' : 'website_sign_in_not_confirmed' }, 409);
    } });
    await v.clickDone(); assert.equal(v.stored.size, 0); assert.equal(v.nodes.done.disabled, true);
    assert.equal(v.nodes['clipboard-copy'].disabled, true); assert.equal(v.nodes['clipboard-paste'].disabled, true);
    v.nodes.done.disabled = false; await v.clickDone(); assert.equal(attempts, 1, outcome);
  }
});

test('an unavailable resume network retains only its selector and never enables Done or retries itself', async () => {
  const stored = new Map([[STORAGE_KEY, HANDOFF_ID]]);
  const v = await viewer({ stored, resume: async () => { throw new Error('private network failure'); } });
  assert.equal(stored.get(STORAGE_KEY), HANDOFF_ID); assert.equal(v.nodes.done.disabled, true);
  assert.deepEqual(v.state.requests, ['/browser/connect/resume']);
});
