import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { registerDaytonaViewerRoutes, type DaytonaViewerService } from './daytona-viewer.js';

const ORIGIN = 'https://mcp.otchealth.app';
const TOKEN = 'A'.repeat(43);
const ID = createHash('sha256').update(TOKEN).digest('hex').slice(0, 32);
const COOKIE = `__Host-otc-daytona-login-${ID}=${TOKEN}`;
const URL = 'https://6080-signed-port-capability.proxy.daytona.works/vnc.html?autoconnect=true&resize=scale';
const NOW = 1_900_000_000_000;
const VIEW = { signed_url: URL, expires_at: NOW + 90_000 };
const HEADERS = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

function appWith(service: Partial<DaytonaViewerService> = {}) {
  const app = Fastify();
  registerDaytonaViewerRoutes(app, () => service as DaytonaViewerService, {
    previewDomain: 'proxy.daytona.works', previewPort: 6080, viewerPath: '/vnc.html', now: () => NOW,
  });
  return app;
}

test('Daytona exchange enforces strict same-origin token input and original-expiry unique HttpOnly cookie', async () => {
  let calls = 0;
  const app = appWith({ exchange: async () => { calls++; return VIEW; } });
  try {
    for (const headers of [{}, { origin: `${ORIGIN}.evil.example` }, { ...HEADERS, 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers, payload: { token: TOKEN } })).statusCode, 403);
    }
    for (const payload of [{}, [], { token: TOKEN, profile: 'foreign' }, { token: 'bad' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers: HEADERS, payload })).statusCode, 400);
    }
    assert.equal(calls, 0);
    const response = await app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers: HEADERS, payload: { token: TOKEN } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ...VIEW, handoff_id: ID });
    assert.equal(response.headers['set-cookie'], `${COOKIE}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=90`);
    assert.match(response.headers['cache-control']!, /no-store/);
    assert.equal(response.body.includes(TOKEN), false);
  } finally { await app.close(); }
});

test('Daytona viewer rejects non-private origins, extra credential queries, foreign ports, paths and expired links without leakage', async () => {
  for (const signed_url of ['https://6080-token.evil.example/vnc.html', 'https://6080-token.proxy.daytona.works.evil.example/vnc.html', 'http://6080-token.proxy.daytona.works/vnc.html', 'https://6080-token.proxy.daytona.works:444/vnc.html', 'https://2280-token.proxy.daytona.works/vnc.html', 'https://6080-token.proxy.daytona.works/toolbox', `${URL}&token=MASTER_SECRET`, 'https://user:MASTER_SECRET@6080-token.proxy.daytona.works/vnc.html', `${URL}#MASTER_SECRET`]) {
    const app = appWith({ exchange: async () => ({ ...VIEW, signed_url }) });
    try {
      const response = await app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers: HEADERS, payload: { token: TOKEN } });
      assert.equal(response.statusCode, 409, signed_url);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.body.includes('MASTER_SECRET'), false);
      assert.equal(response.body.includes(signed_url), false);
    } finally { await app.close(); }
  }
  const app = appWith({ exchange: async () => ({ ...VIEW, expires_at: NOW }) });
  try { assert.equal((await app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers: HEADERS, payload: { token: TOKEN } })).statusCode, 409); }
  finally { await app.close(); }
});

test('Daytona resume/complete/expire require exact selected cookie and resume never renews expiry', async () => {
  const seen: string[] = [];
  const app = appWith({
    resume: async token => { seen.push(`resume:${token}`); return VIEW; },
    complete: async token => { seen.push(`complete:${token}`); return { status: 'saved', human_input_revoked: true }; },
    expire: async token => { seen.push(`expire:${token}`); return { status: 'expired', human_input_revoked: true }; },
  });
  try {
    for (const action of ['resume', 'complete', 'expire']) {
      for (const cookie of ['', '__Host-otc-website-login=' + TOKEN, COOKIE.replace(TOKEN, 'B'.repeat(43)), `${COOKIE}; ${COOKIE}`]) {
        assert.equal((await app.inject({ method: 'POST', url: `/browser/daytona/${action}`, headers: { ...HEADERS, cookie }, payload: { handoff_id: ID } })).statusCode, 400);
      }
      assert.equal((await app.inject({ method: 'POST', url: `/browser/daytona/${action}`, headers: { ...HEADERS, cookie: COOKIE }, payload: { handoff_id: ID, token: TOKEN } })).statusCode, 400);
      assert.equal((await app.inject({ method: 'POST', url: `/browser/daytona/${action}`, headers: { origin: 'https://evil.example', cookie: COOKIE }, payload: { handoff_id: ID } })).statusCode, 403);
    }
    assert.deepEqual(seen, []);
    const resumed = await app.inject({ method: 'POST', url: '/browser/daytona/resume', headers: { ...HEADERS, cookie: COOKIE }, payload: { handoff_id: ID } });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.headers['set-cookie'], undefined);
    assert.deepEqual(resumed.json(), { ...VIEW, handoff_id: ID });
    for (const action of ['complete', 'expire']) {
      const response = await app.inject({ method: 'POST', url: `/browser/daytona/${action}`, headers: { ...HEADERS, cookie: `unrelated=keep; ${COOKIE}` }, payload: { handoff_id: ID } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['set-cookie'], `__Host-otc-daytona-login-${ID}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    }
    assert.deepEqual(seen, [`resume:${TOKEN}`, `complete:${TOKEN}`, `expire:${TOKEN}`]);
  } finally { await app.close(); }
});

test('Daytona terminal actions fail closed without confirmed human-input revocation and never leak errors', async () => {
  const app = appWith({
    complete: async () => ({ status: 'saved', human_input_revoked: false }) as never,
    expire: async () => { throw new Error(`unknown effect ${TOKEN} ${URL}`); },
  });
  try {
    for (const action of ['complete', 'expire']) {
      const response = await app.inject({ method: 'POST', url: `/browser/daytona/${action}`, headers: { ...HEADERS, cookie: COOKIE }, payload: { handoff_id: ID } });
      assert.equal(response.statusCode, 409);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.body.includes(TOKEN), false);
      assert.equal(response.body.includes(URL), false);
    }
  } finally { await app.close(); }
});

test('Daytona concurrent tab selectors never choose or clear the other owner-bound handoff', async () => {
  const secondToken = 'B'.repeat(43);
  const completed: string[] = [];
  const app = appWith({ exchange: async () => VIEW, complete: async token => { completed.push(token); return { status: 'saved', human_input_revoked: true }; } });
  try {
    const exchanges = await Promise.all([TOKEN, secondToken].map(token => app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers: HEADERS, payload: { token } })));
    const [first, second] = exchanges;
    const both = exchanges.map(response => String(response.headers['set-cookie']).split(';')[0]).join('; ');
    assert.notEqual(first!.json().handoff_id, second!.json().handoff_id);
    const response = await app.inject({ method: 'POST', url: '/browser/daytona/complete', headers: { ...HEADERS, cookie: both }, payload: { handoff_id: ID } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(completed, [TOKEN]);
    assert.equal(String(response.headers['set-cookie']).includes(second!.json().handoff_id), false);
  } finally { await app.close(); }
});

test('Daytona page is nonce-protected private iframe UI, clears fragment and stores only nonsecret selector', async () => {
  const app = appWith();
  try {
    const response = await app.inject('/browser/daytona');
    assert.equal(response.statusCode, 200);
    const csp = String(response.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-src https:\/\/\*\.proxy\.daytona\.works/);
    assert.equal(csp.includes('unsafe-eval'), false);
    assert.equal(response.body.includes('dcv.js'), false);
    assert.match(response.body, /referrerpolicy="no-referrer"/);
    const script = response.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const requests: { url: string; body: unknown }[] = [];
    const scheduled: number[] = [];
    const stored = new Map<string, string>();
    const handlers = new Map<string, () => Promise<void>>();
    const nodes = new Map<string, Record<string, unknown>>();
    for (const id of ['status', 'viewer', 'done', 'cancel']) nodes.set(id, { textContent: '', src: '', hidden: true, disabled: true, addEventListener: (_: string, fn: () => Promise<void>) => handlers.set(id, fn), removeAttribute: () => {} });
    let fragmentCleared = false;
    const context = {
      window: { location: { hash: `#token=${TOKEN}`, origin: ORIGIN, pathname: '/browser/daytona' } },
      history: { replaceState: () => { fragmentCleared = true; } },
      URLSearchParams, URL, Date: { now: () => NOW }, setTimeout: (_: unknown, delay: number) => { scheduled.push(delay); return 0; }, clearTimeout: () => {},
      document: { getElementById: (id: string) => nodes.get(id) },
      sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
      fetch: async (url: string, init: { body: string }) => { assert.equal(fragmentCleared, true); requests.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => url.endsWith('exchange') ? { ...VIEW, handoff_id: ID } : { status: 'saved', human_input_revoked: true } }; },
    };
    runInNewContext(script, context);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(requests[0]?.url, '/browser/daytona/exchange');
    assert.equal(nodes.get('viewer')!.src, URL);
    assert.deepEqual([...stored.values()], [ID]);
    assert.deepEqual(scheduled, [89_000], 'best-effort release starts before original HttpOnly cookie expires');
    assert.equal(JSON.stringify([...stored]).includes(TOKEN), false);
    assert.equal(JSON.stringify([...stored]).includes(URL), false);
    await handlers.get('done')!();
    await handlers.get('done')!();
    assert.equal(requests.filter(value => value.url.endsWith('/complete')).length, 1);
    assert.equal(nodes.get('viewer')!.src, 'about:blank');
    assert.deepEqual([...stored.values()], []);
  } finally { await app.close(); }
});

test('Daytona page resumes only selector and blocks duplicate Done after an ambiguous failure', async () => {
  const app = appWith();
  try {
    const response = await app.inject('/browser/daytona');
    const script = response.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const requests: { url: string; body: unknown }[] = [];
    const stored = new Map([['otc-daytona-handoff', ID]]);
    const handlers = new Map<string, () => Promise<void>>();
    const nodes = new Map<string, Record<string, unknown>>();
    for (const id of ['status', 'viewer', 'done', 'cancel']) nodes.set(id, { textContent: '', src: '', hidden: true, disabled: true, addEventListener: (_: string, fn: () => Promise<void>) => handlers.set(id, fn) });
    let cleared = false;
    runInNewContext(script, {
      window: { location: { hash: '', origin: ORIGIN, pathname: '/browser/daytona' } },
      history: { replaceState: () => { cleared = true; } }, URLSearchParams, Date, setTimeout: () => 0, clearTimeout: () => {},
      document: { getElementById: (id: string) => nodes.get(id) },
      sessionStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
      fetch: async (url: string, init: { body: string }) => {
        assert.equal(cleared, true);
        requests.push({ url, body: JSON.parse(init.body) });
        if (url.endsWith('/complete')) throw new Error(`uncertain ${TOKEN}`);
        return { ok: true, json: async () => ({ ...VIEW, handoff_id: ID }) };
      },
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.deepEqual(requests[0], { url: '/browser/daytona/resume', body: { handoff_id: ID } });
    assert.equal(stored.get('otc-daytona-handoff'), ID);
    await handlers.get('done')!();
    await handlers.get('done')!();
    await handlers.get('cancel')!();
    assert.equal(requests.length, 2);
    assert.equal(nodes.get('done')!.disabled, true);
    assert.equal(nodes.get('cancel')!.disabled, true);
    assert.equal(nodes.get('viewer')!.src, 'about:blank');
    assert.match(String(nodes.get('status')!.textContent), /could not be confirmed/);
    assert.equal(String(nodes.get('status')!.textContent).includes(TOKEN), false);
    assert.equal(stored.size, 0);
  } finally { await app.close(); }
});

test('Daytona page still opens initial handoff if browser storage is blocked', async () => {
  const app = appWith();
  try {
    const response = await app.inject('/browser/daytona');
    const script = response.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const nodes = new Map<string, Record<string, unknown>>();
    for (const id of ['status', 'viewer', 'done', 'cancel']) nodes.set(id, { textContent: '', src: '', hidden: true, disabled: true, addEventListener: () => {} });
    runInNewContext(script, {
      window: { location: { hash: `#token=${TOKEN}`, pathname: '/browser/daytona' } }, history: { replaceState: () => {} }, URLSearchParams, Date,
      setTimeout: () => 0, clearTimeout: () => {}, document: { getElementById: (id: string) => nodes.get(id) },
      sessionStorage: { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => { throw new Error('SecurityError'); } },
      fetch: async () => ({ ok: true, json: async () => ({ ...VIEW, handoff_id: ID }) }),
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(nodes.get('viewer')!.src, URL);
    assert.equal(nodes.get('done')!.disabled, false);
  } finally { await app.close(); }
});

test('Daytona offline or transient resume retains only selector and a later manual reload resumes the same cookie-bound grant', async () => {
  let resumes = 0;
  const app = appWith({ resume: async token => { assert.equal(token, TOKEN); resumes++; return VIEW; } });
  try {
    const html = await app.inject('/browser/daytona');
    const script = html.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    for (const failure of ['offline', 408, 429, 500, 502, 503, 504] as const) {
      const stored = new Map([['otc-daytona-handoff', ID]]);
      const requests: string[] = [];
      const scheduled: number[] = [];
      let online = false;
      const reload = async () => {
        const nodes = new Map<string, Record<string, unknown>>();
        const handlers = new Map<string, () => Promise<void>>();
        for (const id of ['status', 'viewer', 'done', 'cancel']) nodes.set(id, { textContent: '', src: '', hidden: true, disabled: true, addEventListener: (_: string, fn: () => Promise<void>) => handlers.set(id, fn) });
        runInNewContext(script, {
          window: { location: { hash: '', pathname: '/browser/daytona' } }, history: { replaceState: () => {} }, URLSearchParams, Date: { now: () => NOW },
          setTimeout: (_: unknown, delay: number) => { scheduled.push(delay); return 0; }, clearTimeout: () => {},
          document: { getElementById: (id: string) => nodes.get(id) },
          sessionStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
          fetch: async (url: string, init: { body: string; credentials: string }) => {
            requests.push(url);
            assert.equal(init.credentials, 'same-origin');
            assert.deepEqual(JSON.parse(init.body), { handoff_id: ID });
            if (!online) {
              if (failure === 'offline') throw new TypeError('Failed to fetch');
              return { ok: false, status: failure };
            }
            const response = await app.inject({ method: 'POST', url, headers: { ...HEADERS, cookie: COOKIE }, payload: JSON.parse(init.body) });
            assert.equal(response.headers['set-cookie'], undefined, 'reload must not extend the original cookie');
            return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.json() };
          },
        });
        for (let i = 0; i < 30 && !nodes.get('status')!.textContent; i++) await new Promise<void>(resolve => setImmediate(resolve));
        return { nodes, handlers };
      };
      const failed = await reload();
      assert.equal(stored.get('otc-daytona-handoff'), ID, String(failure));
      assert.deepEqual(requests, ['/browser/daytona/resume'], 'no automatic retry');
      assert.deepEqual(scheduled, [], 'no expiry or other effect scheduled on failure');
      assert.equal(failed.nodes.get('viewer')!.src, 'about:blank');
      assert.equal(failed.nodes.get('done')!.disabled, true);
      assert.equal(failed.nodes.get('cancel')!.disabled, true);
      assert.match(String(failed.nodes.get('status')!.textContent), /reload/i);
      await failed.handlers.get('done')!(); await failed.handlers.get('cancel')!();
      assert.equal(requests.length, 1, 'failed bootstrap cannot invoke terminal effects');
      online = true;
      const recovered = await reload();
      assert.equal(recovered.nodes.get('viewer')!.src, URL);
      assert.equal(recovered.nodes.get('done')!.disabled, false);
      assert.deepEqual(requests, ['/browser/daytona/resume', '/browser/daytona/resume']);
      assert.deepEqual(scheduled, [89_000], 'only the original expiry is scheduled after recovery');
      assert.deepEqual([...stored.values()], [ID]);
      assert.equal(JSON.stringify([...stored]).includes(TOKEN), false);
      assert.equal(JSON.stringify([...stored]).includes(URL), false);
    }
    assert.equal(resumes, 7);
  } finally { await app.close(); }
});

test('Daytona explicit denied or terminal resume response clears selector and cannot invoke Done or expiry', async () => {
  const app = appWith();
  try {
    const html = await app.inject('/browser/daytona');
    const script = html.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    for (const status of [400, 401, 403, 404, 409, 410, 422]) {
      const stored = new Map([['otc-daytona-handoff', ID]]);
      const requests: string[] = [];
      const handlers = new Map<string, () => Promise<void>>();
      const nodes = new Map<string, Record<string, unknown>>();
      for (const id of ['status', 'viewer', 'done', 'cancel']) nodes.set(id, { textContent: '', src: '', hidden: true, disabled: true, addEventListener: (_: string, fn: () => Promise<void>) => handlers.set(id, fn) });
      runInNewContext(script, {
        window: { location: { hash: '', pathname: '/browser/daytona' } }, history: { replaceState: () => {} }, URLSearchParams, Date: { now: () => NOW },
        setTimeout: () => { assert.fail('terminal resume must not schedule effects'); }, clearTimeout: () => {}, document: { getElementById: (id: string) => nodes.get(id) },
        sessionStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
        fetch: async (url: string) => { requests.push(url); return { ok: false, status }; },
      });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      assert.equal(stored.size, 0, String(status));
      assert.equal(nodes.get('viewer')!.src, 'about:blank');
      await handlers.get('done')!(); await handlers.get('cancel')!();
      assert.deepEqual(requests, ['/browser/daytona/resume']);
      assert.match(String(nodes.get('status')!.textContent), /expired or unavailable/);
    }
  } finally { await app.close(); }
});
