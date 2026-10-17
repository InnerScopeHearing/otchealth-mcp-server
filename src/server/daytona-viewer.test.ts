import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { registerDaytonaViewerRoutes, type DaytonaViewerService } from './daytona-viewer.js';

const ORIGIN = 'https://mcp.otchealth.app';
const TOKEN = 'A'.repeat(43);
const ID = createHash('sha256').update(TOKEN).digest('hex').slice(0, 32);
const URL = 'https://6080-signed-port-capability.proxy.daytona.works/vnc.html';
const NOW = 1_900_000_000_000;
const VIEW = { signed_url: URL, expires_at: NOW + 90_000 };
const OPENING = NOW + 300_000;
const MISSION = NOW + 3_600_000;
const HEADERS = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

function appWith(service: Partial<DaytonaViewerService> = {}) {
  const app = Fastify();
  registerDaytonaViewerRoutes(app, () => service as DaytonaViewerService, {
    previewDomain: 'proxy.daytona.works', previewPort: 6080, viewerPath: '/vnc.html', now: () => NOW,
  });
  return app;
}

async function recoveryCookie(app: ReturnType<typeof appWith>): Promise<string> {
  const response = await app.inject('/browser/daytona');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['set-cookie'], undefined, 'cross-site page GET must not rotate a Strict proof');
  const first = await app.inject({ method: 'POST', url: '/browser/daytona/bootstrap', headers: HEADERS, payload: {} });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { ready: false });
  const value = String(first.headers['set-cookie']).match(/(__Host-otc-daytona-recovery=[A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(value, 'same-origin bootstrap provisions an HttpOnly proof before ticket effects');
  assert.match(String(first.headers['set-cookie']), /Path=\/; HttpOnly; Secure; SameSite=Strict/);
  const confirmed = await app.inject({ method: 'POST', url: '/browser/daytona/bootstrap', headers: { ...HEADERS, cookie: value }, payload: {} });
  assert.deepEqual(confirmed.json(), { ready: true });
  return value;
}

test('Daytona cross-site document GET never rotates the strict browser proof; same-origin bootstrap confirms it', async () => {
  const app = appWith();
  try {
    const first = await app.inject('/browser/daytona');
    assert.equal(first.headers['set-cookie'], undefined);
    const crossSite = await app.inject({ method: 'GET', url: '/browser/daytona?handoff=' + ID, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.headers['set-cookie'], undefined, 'cross-site navigation must not overwrite a prior handoff proof');
    const created = await app.inject({ method: 'POST', url: '/browser/daytona/bootstrap', headers: HEADERS, payload: {} });
    const proof = String(created.headers['set-cookie']).split(';')[0];
    const reload = await app.inject({ method: 'GET', url: '/browser/daytona?handoff=' + ID, headers: { cookie: proof } });
    assert.equal(reload.headers['set-cookie'], undefined, 'GET never replaces proof on reload');
    const check = await app.inject({ method: 'POST', url: '/browser/daytona/bootstrap', headers: { ...HEADERS, cookie: proof }, payload: {} });
    assert.deepEqual(check.json(), { ready: true });
  } finally { await app.close(); }
});

test('Daytona prepare binds a one-time token to the pre-provisioned browser proof before exchange', async () => {
  const seen: string[] = [];
  const app = appWith({
    prepare: async (token, proof) => { seen.push(`prepare:${token}:${proof}`); return { handoff_id: ID, opening_expires_at: OPENING, mission_expires_at: MISSION }; },
    exchange: async (token, proof) => { seen.push(`exchange:${token}:${proof}`); return VIEW; },
  });
  try {
    const proof = await recoveryCookie(app);
    const cookie = `${proof}; unrelated=keep`;
    for (const headers of [{}, { origin: `${ORIGIN}.evil.example` }, { ...HEADERS, 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/browser/daytona/prepare', headers, payload: { token: TOKEN } })).statusCode, 403);
    }
    for (const payload of [{}, [], { token: TOKEN, profile: 'foreign' }, { token: 'bad' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/browser/daytona/prepare', headers: { ...HEADERS, cookie }, payload })).statusCode, 400);
    }
    assert.deepEqual(seen, []);
    const prepared = await app.inject({ method: 'POST', url: '/browser/daytona/prepare', headers: { ...HEADERS, cookie }, payload: { token: TOKEN } });
    assert.equal(prepared.statusCode, 200);
    assert.deepEqual(prepared.json(), { handoff_id: ID, opening_expires_at: OPENING, mission_expires_at: MISSION });
    assert.equal(prepared.body.includes(TOKEN), false);
    const exchanged = await app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers: { ...HEADERS, cookie }, payload: { token: TOKEN } });
    assert.equal(exchanged.statusCode, 200);
    assert.deepEqual(exchanged.json(), { ...VIEW, signed_url: `${URL}?resize=scale`, handoff_id: ID });
    assert.equal(exchanged.headers['set-cookie'], undefined, 'recovery authority was installed by GET, before exchange');
    assert.deepEqual(seen, [`prepare:${TOKEN}:${proof.split('=')[1]}`, `exchange:${TOKEN}:${proof.split('=')[1]}`]);
  } finally { await app.close(); }
});

test('Daytona viewer presentation forces local scaling for bare and non-scale signed URLs', async () => {
  const proof = 'B'.repeat(43);
  for (const resize of [undefined, 'off', 'remote']) {
    const signed_url = resize ? `${URL}?resize=${resize}` : URL;
    const app = appWith({ exchange: async () => ({ ...VIEW, signed_url }) });
    try {
      const response = await app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers: { ...HEADERS, cookie: `__Host-otc-daytona-recovery=${proof}` }, payload: { token: TOKEN } });
      assert.equal(response.statusCode, 200);
      const result = response.json();
      const presented = new globalThis.URL(result.signed_url);
      assert.deepEqual(presented.searchParams.getAll('resize'), ['scale']);
      assert.equal(result.handoff_id, ID);
    } finally { await app.close(); }
  }
});

test('Daytona selector routes require the exact HttpOnly proof and expose status without viewer data', async () => {
  const seen: string[] = [];
  const app = appWith({
    recover: async (selector, proof) => { seen.push(`recover:${selector}:${proof}`); return VIEW; },
    status: async (selector, proof) => { seen.push(`status:${selector}:${proof}`); return { status: 'active', opening_expires_at: OPENING, mission_expires_at: MISSION }; },
    renew: async (selector, proof) => { seen.push(`renew:${selector}:${proof}`); return VIEW; },
    reconcile: async (selector, proof) => { seen.push(`reconcile:${selector}:${proof}`); return { status: 'saved', human_input_revoked: true, checkpoint_saved: true, mission_released: true }; },
    complete: async (_token, proof) => { seen.push(`complete:${proof}`); return { status: 'saved', human_input_revoked: true, checkpoint_saved: true, mission_released: true }; },
    expire: async (_token, proof) => { seen.push(`expire:${proof}`); return { status: 'expired', human_input_revoked: true, mission_released: true }; },
  });
  try {
    const proofCookie = await recoveryCookie(app);
    const proof = proofCookie.split('=')[1]!;
    for (const action of ['open', 'recover', 'status', 'reconcile', 'renew', 'complete', 'expire']) {
      for (const cookie of ['', '__Host-otc-website-login=' + proof, `${proofCookie}; ${proofCookie}`]) {
        assert.equal((await app.inject({ method: 'POST', url: `/browser/daytona/${action}`, headers: { ...HEADERS, cookie }, payload: { handoff_id: ID } })).statusCode, 400);
      }
      assert.equal((await app.inject({ method: 'POST', url: `/browser/daytona/${action}`, headers: { ...HEADERS, cookie: proofCookie }, payload: { handoff_id: ID, token: TOKEN } })).statusCode, 400);
      assert.equal((await app.inject({ method: 'POST', url: `/browser/daytona/${action}`, headers: { origin: 'https://evil.example', cookie: proofCookie }, payload: { handoff_id: ID } })).statusCode, 403);
    }
    const status = await app.inject({ method: 'POST', url: '/browser/daytona/status', headers: { ...HEADERS, cookie: proofCookie }, payload: { handoff_id: ID } });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), { status: 'active', opening_expires_at: OPENING, mission_expires_at: MISSION });
    assert.equal(status.body.includes(URL), false);
    assert.equal(status.body.includes(TOKEN), false);
    for (const action of ['recover', 'renew']) {
      const response = await app.inject({ method: 'POST', url: `/browser/daytona/${action}`, headers: { ...HEADERS, cookie: proofCookie }, payload: { handoff_id: ID } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { ...VIEW, signed_url: `${URL}?resize=scale`, handoff_id: ID });
    }
    const reconciled = await app.inject({ method: 'POST', url: '/browser/daytona/reconcile', headers: { ...HEADERS, cookie: proofCookie }, payload: { handoff_id: ID } });
    assert.equal(reconciled.statusCode, 200);
    assert.deepEqual(reconciled.json(), { status: 'saved', human_input_revoked: true, checkpoint_saved: true, mission_released: true });
    const completed = await app.inject({ method: 'POST', url: '/browser/daytona/complete', headers: { ...HEADERS, cookie: proofCookie }, payload: { handoff_id: ID } });
    assert.equal(completed.statusCode, 200);
    assert.deepEqual(completed.json(), { status: 'saved', human_input_revoked: true, checkpoint_saved: true, mission_released: true });
    const expired = await app.inject({ method: 'POST', url: '/browser/daytona/expire', headers: { ...HEADERS, cookie: proofCookie }, payload: { handoff_id: ID } });
    assert.equal(expired.statusCode, 200);
    assert.deepEqual(expired.json(), { status: 'expired', human_input_revoked: true, mission_released: true });
    assert.deepEqual(seen, [
      `status:${ID}:${proof}`, `recover:${ID}:${proof}`, `renew:${ID}:${proof}`, `reconcile:${ID}:${proof}`, `complete:${proof}`, `expire:${proof}`,
    ]);
  } finally { await app.close(); }
});

test('Daytona page commits only the selector before network work and never stores the bearer or signed URL', async () => {
  const app = appWith();
  try {
    const response = await app.inject('/browser/daytona');
    const script = response.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const stored = new Map<string, string>();
    const scheduled: number[] = [];
    const handlers = new Map<string, () => Promise<void>>();
    const nodes = new Map<string, Record<string, unknown>>();
    for (const id of ['status', 'deadlines', 'targetHeading', 'targetInstructions', 'viewer', 'done', 'cancel', 'recover', 'renew', 'open', 'bootstrap', 'reconcile']) nodes.set(id, { textContent: '', src: '', hidden: true, disabled: true, focus: () => {}, addEventListener: (event: string, fn: () => Promise<void>) => handlers.set(`${id}:${event}`, fn) });
    let location = '/browser/daytona';
    const context = {
      window: { location: { hash: `#token=${TOKEN}`, search: '', pathname: '/browser/daytona' } },
      history: { replaceState: (_: unknown, _title: string, value: string) => { location = value; } },
      URLSearchParams, URL, Date: Object.assign(Date, { now: () => NOW }), TextEncoder, AbortSignal: { timeout: () => ({}) }, setTimeout: (_: unknown, delay: number) => { scheduled.push(delay); return scheduled.length; }, clearTimeout: () => {},
      crypto: { subtle: { digest: async (_: string, data: Uint8Array) => Uint8Array.from(createHash('sha256').update(data).digest()) } },
      document: { getElementById: (id: string) => nodes.get(id) },
      sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
      fetch: async (url: string, init: { body: string }) => {
        assert.equal(location, `/browser/daytona?handoff=${ID}`, 'selector is placed in history before network I/O');
        requests.push({ url, body: JSON.parse(init.body) });
        const body = url.endsWith('/bootstrap')
          ? { ready: requests.filter(value => value.url.endsWith('/bootstrap')).length > 1 }
          : url.endsWith('/prepare')
          ? { handoff_id: ID, opening_expires_at: OPENING, mission_expires_at: MISSION, target_label: 'WeFunder' }
          : { ...VIEW, handoff_id: ID };
        return { ok: true, status: 200, json: async () => body };
      },
    };
    runInNewContext(script, context);
    for (let i = 0; i < 30 && requests.length < 2; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [
      { url: '/browser/daytona/bootstrap', body: {} },
      { url: '/browser/daytona/bootstrap', body: {} },
      { url: '/browser/daytona/prepare', body: { token: TOKEN } },
      { url: '/browser/daytona/exchange', body: { token: TOKEN } },
    ]);
    assert.equal(stored.get('otc-daytona-handoff'), ID);
    assert.equal(JSON.stringify([...stored]).includes(TOKEN), false);
    assert.equal(JSON.stringify([...stored]).includes(URL), false);
    assert.equal(nodes.get('viewer')!.src, URL);
    assert.equal(nodes.get('targetHeading')!.textContent, 'Connect to WeFunder');
    assert.match(String(nodes.get('targetInstructions')!.textContent), /WeFunder workspace/);
    assert.match(String(nodes.get('deadlines')!.textContent), /05:00 remaining.*60:00 remaining/);
    await handlers.get('viewer:load')!();
    assert.equal(nodes.get('done')!.disabled, false);
    assert.deepEqual(scheduled, [1_000, 15_000, 90_000]);
  } finally { await app.close(); }
});

test('Daytona viewer URLs still reject untrusted authorities and signed query credentials', async () => {
  const proof = 'B'.repeat(43);
  for (const signed_url of ['https://6080-token.evil.example/vnc.html', 'https://6080-token.proxy.daytona.works.evil.example/vnc.html', 'http://6080-token.proxy.daytona.works/vnc.html', 'https://6080-token.proxy.daytona.works:444/vnc.html', 'https://2280-token.proxy.daytona.works/vnc.html', 'https://6080-token.proxy.daytona.works/toolbox', `${URL}?resize=scale&resize=off`, `${URL}?unknown=value`, `${URL}?token=MASTER_SECRET`, 'https://user:MASTER_SECRET@6080-token.proxy.daytona.works/vnc.html', `${URL}#MASTER_SECRET`]) {
    const app = appWith({ exchange: async () => ({ ...VIEW, signed_url }) });
    try {
      const response = await app.inject({ method: 'POST', url: '/browser/daytona/exchange', headers: { ...HEADERS, cookie: `__Host-otc-daytona-recovery=${proof}` }, payload: { token: TOKEN } });
      assert.equal(response.statusCode, 409, signed_url);
      assert.equal(response.body.includes('MASTER_SECRET'), false);
      assert.equal(response.body.includes(signed_url), false);
    } finally { await app.close(); }
  }
});

test('Daytona blocked cookies prevent prepare and exchange while keeping an accessible setup retry', async () => {
  const app = appWith();
  try {
    const html = await app.inject('/browser/daytona'), script = html.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const requests: string[] = [], nodes = new Map<string, Record<string, unknown>>();
    for (const id of ['status', 'deadlines', 'viewer', 'done', 'cancel', 'recover', 'renew', 'open', 'bootstrap', 'reconcile']) nodes.set(id, { textContent: '', src: '', hidden: true, disabled: true, focus: () => {}, addEventListener: () => {} });
    runInNewContext(script, {
      window: { location: { hash: `#token=${TOKEN}`, search: '', pathname: '/browser/daytona' } }, history: { replaceState: () => {} },
      URLSearchParams, Date: Object.assign(Date, { now: () => NOW }), TextEncoder, AbortSignal: { timeout: () => ({}) },
      crypto: { subtle: { digest: async (_: string, data: Uint8Array) => Uint8Array.from(createHash('sha256').update(data).digest()) } },
      setTimeout: () => 0, clearTimeout: () => {}, document: { getElementById: (id: string) => nodes.get(id) },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      fetch: async (url: string) => { requests.push(url); return { ok: true, json: async () => ({ ready: false }) }; },
    });
    for (let i = 0; i < 24; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(requests, ['/browser/daytona/bootstrap', '/browser/daytona/bootstrap']);
    assert.equal(nodes.get('bootstrap')!.hidden, false);
    assert.match(String(nodes.get('status')!.textContent), /not accepting the required cookie/i);
  } finally { await app.close(); }
});

test('Daytona reload of a prepared selector offers an explicit open action and never mints from status', async () => {
  const app = appWith({
    status: async () => ({ status: 'ready_for_open', opening_expires_at: OPENING, mission_expires_at: MISSION }),
    openPrepared: async () => VIEW,
  });
  try {
    const proofCookie = await recoveryCookie(app), html = await app.inject('/browser/daytona');
    const script = html.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
    const requests: string[] = [], handlers = new Map<string, () => Promise<void>>(), stored = new Map<string, string>();
    const nodes = new Map<string, Record<string, unknown>>();
    for (const id of ['status', 'deadlines', 'viewer', 'done', 'cancel', 'recover', 'renew', 'open', 'bootstrap', 'reconcile']) nodes.set(id, { textContent: '', src: '', hidden: true, disabled: true, focus: () => {}, addEventListener: (event: string, fn: () => Promise<void>) => handlers.set(`${id}:${event}`, fn) });
    runInNewContext(script, {
      window: { location: { hash: '', search: `?handoff=${ID}`, pathname: '/browser/daytona' } }, history: { replaceState: () => {} },
      URLSearchParams, Date: Object.assign(Date, { now: () => NOW }), TextEncoder, AbortSignal: { timeout: () => ({}) }, crypto: {}, setTimeout: () => 0, clearTimeout: () => {},
      document: { getElementById: (id: string) => nodes.get(id) }, sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
      fetch: async (url: string, init: { body: string }) => { requests.push(url); const response = await app.inject({ method: 'POST', url, headers: { ...HEADERS, cookie: proofCookie }, payload: JSON.parse(init.body) }); return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.json() }; },
    });
    for (let i = 0; i < 24 && nodes.get('open')!.hidden; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(requests, ['/browser/daytona/status']);
    assert.equal(nodes.get('open')!.hidden, false);
    await handlers.get('open:click')!();
    assert.deepEqual(requests, ['/browser/daytona/status', '/browser/daytona/open']);
  } finally { await app.close(); }
});

test('Daytona ambiguous Done stays one-shot and recovery checks receipt status without reopening', async () => {
  const app = appWith();
  try {
    const html = await app.inject('/browser/daytona');
    assert.match(String(html.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(html.headers['content-security-policy']), /frame-src https:\/\/\*\.proxy\.daytona\.works/);
    assert.equal(String(html.headers['content-security-policy']).includes('unsafe-eval'), false);
    const script = html.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
    const requests: string[] = [], handlers = new Map<string, () => Promise<void>>(), stored = new Map<string, string>();
    const nodes = new Map<string, Record<string, unknown>>();
    for (const id of ['status', 'deadlines', 'viewer', 'done', 'cancel', 'recover', 'renew', 'open', 'bootstrap', 'reconcile']) nodes.set(id, { textContent: '', src: '', hidden: true, disabled: true, focus: () => {}, addEventListener: (event: string, fn: () => Promise<void>) => handlers.set(`${id}:${event}`, fn) });
    runInNewContext(script, {
      window: { location: { hash: `#token=${TOKEN}`, search: '', pathname: '/browser/daytona' } }, history: { replaceState: () => {} },
      URLSearchParams, Date: Object.assign(Date, { now: () => NOW }), TextEncoder, AbortSignal: { timeout: () => ({}) },
      crypto: { subtle: { digest: async (_: string, data: Uint8Array) => Uint8Array.from(createHash('sha256').update(data).digest()) } },
      setTimeout: () => 0, clearTimeout: () => {}, document: { getElementById: (id: string) => nodes.get(id) },
      sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
      fetch: async (url: string) => {
        requests.push(url);
        if (url.endsWith('/bootstrap')) return { ok: true, status: 200, json: async () => ({ ready: true }) };
        if (url.endsWith('/prepare')) return { ok: true, status: 200, json: async () => ({ handoff_id: ID, opening_expires_at: OPENING, mission_expires_at: MISSION }) };
        if (url.endsWith('/exchange')) return { ok: true, status: 200, json: async () => ({ ...VIEW, handoff_id: ID }) };
        if (url.endsWith('/complete')) throw new TypeError('connection lost after submit');
        if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ status: 'pending', cleanup_required: true, opening_expires_at: OPENING, mission_expires_at: MISSION }) };
        if (url.endsWith('/reconcile')) return { ok: true, status: 200, json: async () => ({ status: 'saved', human_input_revoked: true, checkpoint_saved: true, mission_released: true }) };
        assert.fail('ambiguous completion must not open or recover a viewer');
      },
    });
    for (let i = 0; i < 30 && !requests.some(value => value.endsWith('/exchange')); i++) await new Promise<void>(resolve => setImmediate(resolve));
    await handlers.get('viewer:load')!();
    await handlers.get('done:click')!(); await handlers.get('done:click')!();
    assert.equal(requests.filter(value => value.endsWith('/complete')).length, 1);
    await handlers.get('recover:click')!();
    assert.equal(requests.filter(value => value.endsWith('/status')).length, 1);
    assert.equal(requests.filter(value => value.endsWith('/recover')).length, 0);
    assert.equal(requests.filter(value => value.endsWith('/renew')).length, 0);
    assert.equal(nodes.get('reconcile')!.hidden, false, 'durable saved receipt exposes only the explicit release reconciliation action');
    await handlers.get('reconcile:click')!();
    assert.equal(requests.filter(value => value.endsWith('/reconcile')).length, 1);
    assert.equal(nodes.get('viewer')!.src, 'about:blank');
    assert.equal(stored.has('otc-daytona-handoff'), false, 'selector clears only after explicit reconciliation confirms release');
    assert.match(String(nodes.get('status')!.textContent), /control released/i);
  } finally { await app.close(); }
});
