import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { registerIntercomLoginPage, registerWebsiteLoginPage } from './intercom-login-page.js';

const TOKEN = 'A'.repeat(43);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function page(path = '/browser/connect') {
  const app = Fastify(); registerIntercomLoginPage(app); registerWebsiteLoginPage(app);
  try { return await app.inject({ method: 'GET', url: path }); } finally { await app.close(); }
}
type Element = { disabled: boolean; textContent: string; dataset: Record<string, string>; style: Record<string, string>; addEventListener: (name: string, callback: () => unknown) => void; focus: () => void };
async function viewer(options: { delayed?: boolean; saved?: boolean } = {}) {
  const response = await page();
  const script = response.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
  const listeners = new Map<string, () => unknown>(); const windowListeners = new Map<string, () => unknown>();
  const state = { captures: [] as boolean[], copies: 0, disconnects: 0, clipboardReads: 0, clipboardWrites: 0, requests: [] as string[], focused: [] as string[] };
  const elements: Record<string, Element> = {};
  for (const id of ['title', 'status', 'stage', 'done', 'clipboard-copy', 'clipboard-paste', 'clipboard-status', 'dcv-display']) elements[id] = {
    disabled: ['done', 'clipboard-copy', 'clipboard-paste'].includes(id), textContent: '', dataset: {}, style: {},
    addEventListener: (name, callback) => { listeners.set(`${id}:${name}`, callback); }, focus: () => { state.focused.push(id); },
  };
  let connectOptions: Record<string, any> | undefined;
  let resolveConnection: ((value: unknown) => void) | undefined;
  const connection = {
    captureClipboardEvents: (enabled: boolean, targetWindow: unknown) => { assert.equal(targetWindow, window); state.captures.push(enabled); },
    syncClipboards: () => { state.copies++; return true; }, disconnect: () => { state.disconnects++; },
  };
  const window = {
    location: { hash: `#token=${TOKEN}`, pathname: '/browser/connect' },
    addEventListener: (name: string, callback: () => unknown) => { windowListeners.set(name, callback); },
    dcv: {
      LogLevel: { SILENT: 'silent' }, setLogLevel: (level: string) => { assert.equal(level, 'silent'); },
      authenticate: (_url: string, callbacks: { success: (auth: unknown, sessions: unknown[]) => void }) => callbacks.success(null, [{ sessionId: 'viewer-session', authToken: 'private' }]),
      connect: async (config: Record<string, any>) => { connectOptions = config; if (options.delayed) return await new Promise(resolve => { resolveConnection = resolve; }); return connection; },
    },
  };
  runInNewContext(script, {
    URL, URLSearchParams, window,
    navigator: { clipboard: { readText: async () => { state.clipboardReads++; throw new Error('ambient read forbidden'); }, writeText: async () => { state.clipboardWrites++; throw new Error('ambient write forbidden'); } } },
    document: { getElementById: (id: string) => elements[id] }, history: { replaceState: () => {} },
    fetch: async (path: string) => {
      state.requests.push(path);
      if (path.endsWith('/exchange')) return { ok: true, json: async () => ({ status: 'login_required', signed_url: 'https://bedrock-agentcore.example/live-view?signature=private', expires_at: 1_900_000_000_000, workspace_id: 'linkedin', site_label: 'LinkedIn', handoff_id: 'a'.repeat(32) }) };
      assert.equal(state.captures.at(-1), false, 'native clipboard capture stops before completing the handoff');
      if (options.saved === false) throw new Error('private failure');
      return { ok: true, json: async () => ({ status: 'saved', workspace_id: 'linkedin' }) };
    },
  });
  await tick();
  const click = async (id: string) => { const callback = listeners.get(`${id}:click`); assert.ok(callback, `${id} click listener`); await callback(); };
  return { response, state, elements, click, connection, windowListeners, config: () => connectOptions, connect: async () => { assert.ok(resolveConnection); resolveConnection(connection); await tick(); } };
}

test('both viewers deny ambient asynchronous clipboard access and expose explicit disabled text controls', async () => {
  for (const path of ['/browser/login', '/browser/connect']) {
    const response = await page(path);
    assert.equal(response.headers['permissions-policy'], 'clipboard-read=(), clipboard-write=()');
    assert.match(response.body, /id="clipboard-paste"[^>]*disabled/); assert.match(response.body, /id="clipboard-copy"[^>]*disabled/);
    assert.match(response.body, /clipboardAutoSync: false/);
    assert.doesNotMatch(response.body, /navigator\.clipboard\.(?:read|readText|write|writeText)|console\.(?:log|warn|error)/);
  }
});

test('clipboard controls do nothing before connection and use only the established viewer after connection', async () => {
  const v = await viewer({ delayed: true });
  await v.click('clipboard-copy'); await v.click('clipboard-paste');
  assert.equal(v.state.copies, 0); assert.deepEqual(v.state.captures, []);
  await v.connect();
  assert.equal(v.elements['clipboard-copy']!.disabled, false); assert.equal(v.elements['clipboard-paste']!.disabled, false);
  assert.equal(v.config()?.clipboardAutoSync, false); assert.deepEqual(v.state.captures, [false]);
});

test('paste is explicitly armed then disarmed on the native paste event; copy uses supported native DCV sync only on click', async () => {
  const v = await viewer(); const event = v.config()?.observers?.clipboardEvent; assert.equal(typeof event, 'function');
  const privateEvent = { name: 'newDataAvailable', get clipboardData(): never { throw new Error('clipboard values must not be read or cached by the page'); } };
  event(privateEvent);
  assert.equal(v.state.copies, 0); assert.deepEqual(v.state.captures, [false]);
  await v.click('clipboard-paste'); assert.deepEqual(v.state.captures, [false, true]);
  assert.ok(v.state.focused.includes('dcv-display'));
  event({ name: 'paste' }); assert.deepEqual(v.state.captures, [false, true, false]);
  await v.click('clipboard-copy'); assert.equal(v.state.copies, 1); assert.deepEqual(v.state.captures, [false, true, false, true, false]);
  assert.equal(v.state.clipboardReads, 0); assert.equal(v.state.clipboardWrites, 0);
  assert.deepEqual(v.state.requests, ['/browser/connect/exchange']);
});

test('Done closes clipboard sharing before the completion request and keeps controls closed on success or failure', async () => {
  for (const saved of [true, false]) {
    const v = await viewer({ saved }); await v.click('clipboard-paste'); await v.click('done');
    assert.equal(v.elements['clipboard-copy']!.disabled, true); assert.equal(v.elements['clipboard-paste']!.disabled, true);
    const before = [v.state.copies, v.state.captures.length];
    v.elements['clipboard-copy']!.disabled = false; v.elements['clipboard-paste']!.disabled = false;
    await v.click('clipboard-copy'); await v.click('clipboard-paste');
    assert.deepEqual([v.state.copies, v.state.captures.length], before);
    assert.equal(v.state.disconnects, saved ? 1 : 0); assert.equal(v.state.clipboardReads, 0); assert.equal(v.state.clipboardWrites, 0);
  }
});

test('disconnect and pagehide remove native clipboard capture and prevent later observer events from reopening it', async () => {
  for (const method of ['disconnect', 'pagehide']) {
    const v = await viewer(); await v.click('clipboard-paste');
    if (method === 'disconnect') { const closed = v.config()?.observers?.disconnect; assert.equal(typeof closed, 'function'); closed({ message: 'private error' }); }
    else { const pagehide = v.windowListeners.get('pagehide'); assert.ok(pagehide); await pagehide(); }
    assert.equal(v.state.captures.at(-1), false); assert.equal(v.elements['clipboard-copy']!.disabled, true); assert.equal(v.elements['clipboard-paste']!.disabled, true);
    const previous = v.state.captures.length; v.config()?.observers?.clipboardEvent({ name: 'newDataAvailable' });
    assert.equal(v.state.captures.length, previous);
  }
});
