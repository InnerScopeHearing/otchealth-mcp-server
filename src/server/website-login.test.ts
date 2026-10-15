import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import type { WebsiteLoginService } from '../tools/browser-cloud/website-login-service.js';
import { registerIntercomLoginRoutes } from './intercom-login.js';
import { registerWebsiteLoginRoutes } from './website-login.js';

const ORIGIN = 'https://mcp.otchealth.app';
const COOKIE_PREFIX = '__Host-otc-website-login';
const INTERCOM_COOKIE = '__Host-otc-intercom-login';
const TOKEN = 'A'.repeat(43);
const HANDOFF_ID = createHash('sha256').update(TOKEN).digest('hex').slice(0, 32);
const COOKIE = `${COOKIE_PREFIX}-${HANDOFF_ID}`;
const LIVE_URL = 'https://bedrock-agentcore.example/live-view?signature=private-live-view-value';
const EXCHANGE_RESULT = { signed_url: LIVE_URL, expires_at: 1_900_000_000_000, workspace_id: 'linkedin' as const, site_label: 'LinkedIn', status: 'login_required' as const };

function routes(runtime: Partial<WebsiteLoginService> = {}) {
  const app = Fastify();
  registerWebsiteLoginRoutes(app, () => runtime as WebsiteLoginService);
  return app;
}

function postHeaders(extra: Record<string, string> = {}) {
  return { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...extra };
}

test('website exchange requires exact origin and strict token payload, and sets only its own cookie', async () => {
  const calls: string[] = [];
  const app = routes({ exchange: async token => { calls.push(token); return EXCHANGE_RESULT; } });
  try {
    for (const headers of [{}, { origin: 'https://evil.example' }, postHeaders({ origin: `${ORIGIN}.evil.example` }), postHeaders({ 'sec-fetch-site': 'cross-site' })]) {
      const response = await app.inject({ method: 'POST', url: '/browser/connect/exchange', headers, payload: { token: TOKEN } });
      assert.equal(response.statusCode, 403);
    }
    for (const payload of [{ token: TOKEN, site: 'attacker' }, { token: 'short' }, { token: 43 }, { token: '+'.repeat(43) }, {}, [TOKEN], null]) {
      const response = await app.inject({ method: 'POST', url: '/browser/connect/exchange', headers: postHeaders(), payload });
      assert.equal(response.statusCode, 400);
    }
    assert.deepEqual(calls, []);
    const response = await app.inject({ method: 'POST', url: '/browser/connect/exchange', headers: postHeaders(), payload: { token: TOKEN } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ...EXCHANGE_RESULT, handoff_id: HANDOFF_ID });
    assert.deepEqual(calls, [TOKEN]);
    assert.equal(response.headers['set-cookie'], `${COOKIE}=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`);
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
    assert.match(response.headers['cache-control'] ?? '', /no-store/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.body.includes(TOKEN), false);
    assert.equal(String(response.headers['set-cookie']).includes(INTERCOM_COOKIE), false);
  } finally {
    await app.close();
  }
});

test('website exchange leaves single-use enforcement to the ticket service and sanitizes failures', async () => {
  let calls = 0;
  const app = routes({ exchange: async () => {
    if (calls++ > 0) throw new Error(`consumed ${TOKEN}: ${LIVE_URL}`);
    return EXCHANGE_RESULT;
  } });
  try {
    const first = await app.inject({ method: 'POST', url: '/browser/connect/exchange', headers: postHeaders(), payload: { token: TOKEN } });
    assert.equal(first.statusCode, 200);
    const replay = await app.inject({ method: 'POST', url: '/browser/connect/exchange', headers: postHeaders(), payload: { token: TOKEN } });
    assert.equal(replay.statusCode, 409);
    assert.deepEqual(replay.json(), { error: 'login_link_expired_or_unavailable' });
    assert.equal(replay.body.includes(TOKEN), false);
    assert.equal(replay.body.includes(LIVE_URL), false);
    assert.equal(replay.headers['set-cookie'], undefined);
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});

test('website completion requires a strict handoff selector and its unique cookie, and clears only that cookie', async () => {
  const calls: string[] = [];
  const result = { status: 'saved' as const, site: 'linkedin' as const, workspace_id: 'linkedin' as const, verification: 'owner_confirmation_and_expected_url' as const };
  const app = routes({ complete: async token => { calls.push(token); return result; } });
  try {
    for (const cookie of ['', `${INTERCOM_COOKIE}=${TOKEN}`, `${COOKIE_PREFIX}=${TOKEN}`, `${COOKIE}=bad`, `${COOKIE}=${'B'.repeat(43)}`, `${COOKIE}=${TOKEN}; ${COOKIE}=${TOKEN}`]) {
      const response = await app.inject({ method: 'POST', url: '/browser/connect/complete', headers: postHeaders({ cookie }), payload: { handoff_id: HANDOFF_ID } });
      assert.equal(response.statusCode, 400);
    }
    const wrongOrigin = await app.inject({ method: 'POST', url: '/browser/connect/complete', headers: postHeaders({ origin: 'https://evil.example', cookie: `${COOKIE}=${TOKEN}` }) });
    assert.equal(wrongOrigin.statusCode, 403);
    const crossSite = await app.inject({ method: 'POST', url: '/browser/connect/complete', headers: postHeaders({ 'sec-fetch-site': 'cross-site', cookie: `${COOKIE}=${TOKEN}` }) });
    assert.equal(crossSite.statusCode, 403);
    for (const payload of [undefined, {}, [], { handoff_id: HANDOFF_ID, token: TOKEN }, { handoff_id: 'bad' }, { handoff_id: 'A'.repeat(32) }, { handoff_id: 'a'.repeat(33) }, { handoff_id: 123 }]) {
      const response = await app.inject({ method: 'POST', url: '/browser/connect/complete', headers: postHeaders({ cookie: `${COOKIE}=${TOKEN}` }), payload });
      assert.equal(response.statusCode, 400);
    }
    assert.deepEqual(calls, []);
    const success = await app.inject({ method: 'POST', url: '/browser/connect/complete', headers: postHeaders({ cookie: `${INTERCOM_COOKIE}=unrelated; ${COOKIE}=${TOKEN}` }), payload: { handoff_id: HANDOFF_ID } });
    assert.equal(success.statusCode, 200);
    assert.deepEqual(success.json(), result);
    assert.deepEqual(calls, [TOKEN]);
    assert.equal(success.headers['set-cookie'], `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    assert.equal(success.body.includes(TOKEN), false);
  } finally {
    await app.close();
  }
});

test('concurrent website login tabs keep independent cookies and completing one never selects or clears the other ticket', async () => {
  const secondToken = 'B'.repeat(43);
  const completed: string[] = [];
  const resumed: string[] = [];
  const app = routes({
    exchange: async token => ({ ...EXCHANGE_RESULT, workspace_id: token === TOKEN ? 'linkedin' : 'wefunder', site_label: token === TOKEN ? 'LinkedIn' : 'WeFunder' }),
    resume: async token => { resumed.push(token); return EXCHANGE_RESULT; },
    complete: async token => {
      assert.equal(completed.includes(token), false);
      completed.push(token);
      const site = token === TOKEN ? 'linkedin' : 'wefunder';
      return { status: 'saved', site, workspace_id: site, verification: 'owner_confirmation_and_expected_url' };
    },
  });
  try {
    const [first, second] = await Promise.all([TOKEN, secondToken].map(token => app.inject({ method: 'POST', url: '/browser/connect/exchange', headers: postHeaders(), payload: { token } })));
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const firstId = first.json().handoff_id as string;
    const secondId = second.json().handoff_id as string;
    assert.match(firstId, /^[a-f0-9]{32}$/);
    assert.match(secondId, /^[a-f0-9]{32}$/);
    assert.notEqual(firstId, secondId);
    const firstCookie = String(first.headers['set-cookie']).split(';')[0]!;
    const secondCookie = String(second.headers['set-cookie']).split(';')[0]!;
    assert.notEqual(firstCookie.split('=')[0], secondCookie.split('=')[0]);
    for (const handoffId of [firstId, secondId]) {
      const resumedViewer = await app.inject({ method: 'POST', url: '/browser/connect/resume', headers: postHeaders({ cookie: `${secondCookie}; ${firstCookie}` }), payload: { handoff_id: handoffId } });
      assert.equal(resumedViewer.statusCode, 200);
      assert.equal(resumedViewer.json().handoff_id, handoffId);
      assert.equal(resumedViewer.headers['set-cookie'], undefined);
    }
    assert.deepEqual(resumed, [TOKEN, secondToken]);
    const firstDone = await app.inject({ method: 'POST', url: '/browser/connect/complete', headers: postHeaders({ cookie: `${secondCookie}; ${firstCookie}` }), payload: { handoff_id: firstId } });
    assert.equal(firstDone.statusCode, 200);
    assert.deepEqual(completed, [TOKEN]);
    assert.equal(firstDone.json().workspace_id, 'linkedin');
    assert.equal(firstDone.headers['set-cookie'], `${COOKIE_PREFIX}-${firstId}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    assert.equal(String(firstDone.headers['set-cookie']).includes(secondId), false);
    const secondDone = await app.inject({ method: 'POST', url: '/browser/connect/complete', headers: postHeaders({ cookie: secondCookie }), payload: { handoff_id: secondId } });
    assert.equal(secondDone.statusCode, 200);
    assert.equal(secondDone.json().workspace_id, 'wefunder');
    assert.deepEqual(completed, [TOKEN, secondToken]);
  } finally {
    await app.close();
  }
});

test('website completion returns no private error details', async () => {
  const app = routes({ complete: async () => { throw new Error(`private ${TOKEN} ${LIVE_URL}`); } });
  try {
    const failure = await app.inject({ method: 'POST', url: '/browser/connect/complete', headers: postHeaders({ cookie: `${COOKIE}=${TOKEN}` }), payload: { handoff_id: HANDOFF_ID } });
    assert.equal(failure.statusCode, 409);
    assert.deepEqual(failure.json(), { error: 'website_sign_in_not_confirmed' });
    assert.equal(failure.body.includes(TOKEN), false);
    assert.equal(failure.body.includes(LIVE_URL), false);
  } finally {
    await app.close();
  }
});

test('website viewer resume requires exact origin, strict selector and its unique matching cookie without renewing it', async () => {
  const resumed: string[] = [];
  const app = routes({ resume: async token => { resumed.push(token); return EXCHANGE_RESULT; } });
  try {
    for (const headers of [{}, postHeaders({ origin: 'https://evil.example' }), postHeaders({ 'sec-fetch-site': 'cross-site' })]) {
      const response = await app.inject({ method: 'POST', url: '/browser/connect/resume', headers, payload: { handoff_id: HANDOFF_ID } });
      assert.equal(response.statusCode, 403);
    }
    for (const cookie of ['', `${INTERCOM_COOKIE}=${TOKEN}`, `${COOKIE}=${'B'.repeat(43)}`, `${COOKIE}=${TOKEN}; ${COOKIE}=${TOKEN}`]) {
      const response = await app.inject({ method: 'POST', url: '/browser/connect/resume', headers: postHeaders({ cookie }), payload: { handoff_id: HANDOFF_ID } });
      assert.equal(response.statusCode, 400);
    }
    for (const payload of [{}, [], { handoff_id: 'bad' }, { handoff_id: HANDOFF_ID, token: TOKEN }]) {
      const response = await app.inject({ method: 'POST', url: '/browser/connect/resume', headers: postHeaders({ cookie: `${COOKIE}=${TOKEN}` }), payload });
      assert.equal(response.statusCode, 400);
    }
    assert.deepEqual(resumed, []);
    const success = await app.inject({ method: 'POST', url: '/browser/connect/resume', headers: postHeaders({ cookie: `${COOKIE}=${TOKEN}` }), payload: { handoff_id: HANDOFF_ID } });
    assert.equal(success.statusCode, 200);
    assert.deepEqual(success.json(), { ...EXCHANGE_RESULT, handoff_id: HANDOFF_ID });
    assert.deepEqual(resumed, [TOKEN]);
    assert.equal(success.headers['set-cookie'], undefined, 'resume must not extend the HttpOnly cookie lifetime');
    assert.equal(success.body.includes(TOKEN), false);
    assert.match(success.headers['cache-control'] ?? '', /no-store/);
  } finally { await app.close(); }
});

test('website resume failures are sanitized and cannot recreate or exchange a login ticket', async () => {
  let exchanges = 0;
  const app = routes({ exchange: async () => { exchanges++; return EXCHANGE_RESULT; }, resume: async () => { throw new Error(`private ${TOKEN} ${LIVE_URL}`); } });
  try {
    const failed = await app.inject({ method: 'POST', url: '/browser/connect/resume', headers: postHeaders({ cookie: `${COOKIE}=${TOKEN}` }), payload: { handoff_id: HANDOFF_ID } });
    assert.equal(failed.statusCode, 409);
    assert.deepEqual(failed.json(), { error: 'login_link_expired_or_unavailable' });
    assert.equal(failed.body.includes(TOKEN), false); assert.equal(failed.body.includes(LIVE_URL), false);
    assert.equal(failed.headers['set-cookie'], undefined); assert.equal(exchanges, 0);
  } finally { await app.close(); }
});

test('website reload stores only its tab-local nonsecret selector, resumes without a bearer fragment, and clears terminal selectors', async () => {
  const app = routes();
  try {
    const page = await app.inject({ method: 'GET', url: '/browser/connect' });
    const script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
    const stored = new Map<string, string>(); const calls: string[] = [];
    let doneClick: (() => Promise<void>) | undefined;
    async function load(hash: string, options: { storageDenied?: boolean; resumeRejected?: boolean } = {}) {
      const node = () => ({ disabled: true, textContent: '', dataset: {}, style: {}, addEventListener: () => {} });
      const nodes: Record<string, any> = Object.fromEntries(['title', 'status', 'stage', 'done', 'clipboard-copy', 'clipboard-paste', 'clipboard-status'].map(id => [id, node()]));
      nodes.done.addEventListener = (_event: string, handler: () => Promise<void>) => { doneClick = handler; };
      const storage = {
        getItem: (key: string) => { if (options.storageDenied) throw new Error('SecurityError'); return stored.get(key) ?? null; },
        setItem: (key: string, value: string) => { if (options.storageDenied) throw new Error('SecurityError'); assert.match(value, /^[a-f0-9]{32}$/); assert.equal(value.includes(TOKEN), false); stored.set(key, value); },
        removeItem: (key: string) => { if (options.storageDenied) throw new Error('SecurityError'); stored.delete(key); },
      };
      runInNewContext(script, {
        URL, URLSearchParams, history: { replaceState: () => {} }, document: { getElementById: (id: string) => nodes[id] },
        window: { location: { hash, pathname: '/browser/connect', origin: ORIGIN }, sessionStorage: storage, addEventListener: () => {}, dcv: { LogLevel: { SILENT: 0 }, setLogLevel: () => {}, authenticate: (_url: string, callbacks: any) => callbacks.success(null, [{ sessionId: 'same-session', authToken: 'private-viewer-auth' }]), connect: async () => ({ disconnect: () => {} }) } },
        fetch: async (path: string, init: { body?: string }) => {
          calls.push(path);
          if (path.endsWith('/exchange')) { assert.equal(init.body, JSON.stringify({ token: TOKEN })); return { ok: true, json: async () => ({ ...EXCHANGE_RESULT, handoff_id: HANDOFF_ID }) }; }
          assert.equal(init.body, JSON.stringify({ handoff_id: HANDOFF_ID }));
          assert.equal(init.body.includes(TOKEN), false);
          if (path.endsWith('/resume') && options.resumeRejected) return { ok: false, status: 409 };
          if (path.endsWith('/complete')) { assert.equal(stored.size, 0); return { ok: true, json: async () => ({ status: 'saved', workspace_id: 'linkedin' }) }; }
          assert.equal(path, '/browser/connect/resume');
          return { ok: true, json: async () => ({ ...EXCHANGE_RESULT, handoff_id: HANDOFF_ID }) };
        },
      });
      await new Promise(resolve => setImmediate(resolve)); return nodes;
    }
    await load(`#token=${TOKEN}`);
    assert.deepEqual([...stored.values()], [HANDOFF_ID]);
    const reloaded = await load(''); assert.equal(reloaded.done.disabled, false);
    assert.deepEqual(calls, ['/browser/connect/exchange', '/browser/connect/resume']);
    assert.ok(doneClick); await doneClick(); assert.equal(stored.size, 0);
    await load(`#token=${TOKEN}`); await load('', { resumeRejected: true }); assert.equal(stored.size, 0);
    const denied = await load(`#token=${TOKEN}`, { storageDenied: true }); assert.equal(denied.done.disabled, false);
  } finally { await app.close(); }
});

test('website viewer reuses the original SDK asset route and headers without changing Intercom copy or endpoints', async () => {
  const app = Fastify();
  const registered: Array<{ url: string; bodyLimit?: number; config?: unknown }> = [];
  app.addHook('onRoute', options => { registered.push({ url: options.url, bodyLimit: options.bodyLimit, config: options.config }); });
  registerIntercomLoginRoutes(app, () => { throw new Error('not used'); });
  registerWebsiteLoginRoutes(app, () => { throw new Error('not used'); });
  try {
    const website = await app.inject({ method: 'GET', url: '/browser/connect' });
    const intercom = await app.inject({ method: 'GET', url: '/browser/login' });
    assert.equal(website.statusCode, 200);
    assert.equal(intercom.statusCode, 200);
    assert.match(website.headers['cache-control'] ?? '', /no-store/);
    assert.equal(website.headers['referrer-policy'], 'no-referrer');
    const csp = website.headers['content-security-policy'] ?? '';
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.match(website.body, /<title>Connect your browser<\/title>/);
    assert.match(website.body, /signed-in workspace, feed, or editor/);
    assert.match(website.body, /Never paste credentials into chat or this page/);
    assert.match(website.body, /history\.replaceState\(null, '', window\.location\.pathname\)/);
    assert.match(website.body, /\/browser\/connect\/exchange/);
    assert.match(website.body, /\/browser\/connect\/complete/);
    assert.match(website.body, /src="\/browser\/login\/assets\/dcvjs-umd\/dcv.js"/);
    assert.match(website.body, /Number\.isSafeInteger\(result\.expires_at\)/);
    assert.doesNotMatch(website.body, /console\.(?:log|error|warn)|innerHTML|\/browser\/connect\/assets/);
    assert.match(intercom.body, /Connect to your Intercom workspace/);
    assert.match(intercom.body, /then open its Settings page/);
    assert.match(intercom.body, /\/browser\/login\/exchange/);
    assert.match(intercom.body, /\/browser\/login\/complete/);
    assert.doesNotMatch(intercom.body, /\/browser\/connect|let terminal/);
    for (const page of [website, intercom]) {
      const script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
      assert.ok(script);
      assert.doesNotThrow(() => new Function(script));
    }
    assert.equal(registered.filter(route => route.url.includes('/assets/') && route.url !== '/browser/login/assets/*').length, 0);
    // Fastify also creates a HEAD route for this one GET registration.
    assert.equal(registered.filter(route => route.url === '/browser/login/assets/*').length, 2);
    for (const url of ['/browser/connect/exchange', '/browser/connect/complete', '/browser/connect/resume']) {
      const route = registered.find(route => route.url === url);
      assert.equal(route?.bodyLimit, 256);
      assert.deepEqual(route?.config, { rateLimit: { max: 10, timeWindow: '1 minute' } });
    }
    const sdk = await app.inject({ method: 'GET', url: '/browser/login/assets/dcvjs-umd/dcv.js' });
    assert.equal(sdk.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('website viewer clears the fragment before exchange, uses textContent for site labels, and never retries a terminal Done attempt', async () => {
  const app = routes();
  try {
    const page = await app.inject({ method: 'GET', url: '/browser/connect' });
    const script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    for (const saved of [false, true]) {
      const label = '<img src=x onerror=alert(1)>';
      let click: (() => Promise<void>) | undefined;
      let cleared = false;
      let disconnects = 0;
      let completionCalls = 0;
      const title = { textContent: '' };
      const status = { textContent: '', dataset: { error: '' } };
      const stage = { style: { display: '' } };
      const done = { disabled: true, addEventListener: (_event: string, callback: () => Promise<void>) => { click = callback; } };
      const clipboardButton = { disabled: true, addEventListener: () => {} };
      const clipboardStatus = { textContent: '', dataset: {} };
      const connection = { disconnect: () => { disconnects += 1; } };
      runInNewContext(script, {
        URL, URLSearchParams,
        history: { replaceState: (_state: unknown, _title: string, url: string) => { assert.equal(url, '/browser/connect'); cleared = true; } },
        document: { getElementById: (id: string) => ({ title, status, stage, done, 'clipboard-copy': clipboardButton, 'clipboard-paste': clipboardButton, 'clipboard-status': clipboardStatus } as Record<string, unknown>)[id] },
        window: {
          location: { hash: `#token=${TOKEN}`, pathname: '/browser/connect', origin: ORIGIN },
          addEventListener: () => {},
          dcv: {
            LogLevel: { SILENT: 'silent' },
            setLogLevel: () => {},
            authenticate: (_url: string, options: { success: (auth: unknown, sessions: unknown[]) => void }) => options.success(null, [{ sessionId: 'session', authToken: 'private-viewer-auth' }]),
            connect: async () => connection,
          },
        },
        fetch: async (path: string, options: { body?: string }) => {
          assert.equal(cleared, true, 'link token is removed before any network request');
          if (path === '/browser/connect/exchange') {
            assert.equal(options.body, JSON.stringify({ token: TOKEN }));
            return { ok: true, json: async () => ({ ...EXCHANGE_RESULT, site_label: label, handoff_id: HANDOFF_ID }) };
          }
          assert.equal(path, '/browser/connect/complete');
          assert.equal(options.body, JSON.stringify({ handoff_id: HANDOFF_ID }));
          assert.equal(options.body.includes(TOKEN), false);
          completionCalls += 1;
          if (!saved) throw new Error(`private ${TOKEN} ${LIVE_URL}`);
          return { ok: true, json: async () => ({ status: 'saved', workspace_id: 'linkedin', verification: 'owner_confirmation_and_authenticated_url' }) };
        },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(title.textContent, `Connect your browser: ${label}`);
      assert.equal(done.disabled, false);
      assert.ok(click);
      await click();
      assert.equal(done.disabled, true);
      assert.equal(completionCalls, 1);
      assert.equal(disconnects, saved ? 1 : 0);
      assert.equal(status.textContent.includes(TOKEN), false);
      assert.equal(status.textContent.includes(LIVE_URL), false);
      assert.match(status.textContent, saved ? /agent will reopen it to verify access/ : /Request a fresh sign-in link/);
      done.disabled = false; // Even an external re-enable must not restart the completed ticket.
      await click();
      assert.equal(completionCalls, 1);
    }
  } finally {
    await app.close();
  }
});
