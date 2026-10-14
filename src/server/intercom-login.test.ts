import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerIntercomLoginRoutes } from './intercom-login.js';
import type { IntercomLoginService } from '../tools/browser-cloud/intercom-login-service.js';

const ORIGIN = 'https://mcp.otchealth.app';
const COOKIE = '__Host-otc-intercom-login';
const TOKEN = 'A'.repeat(43);
const LIVE_URL = 'https://bedrock-agentcore.example/live-view?signature=private-live-view-value';

function routes(runtime: Partial<IntercomLoginService>) {
  const app = Fastify();
  registerIntercomLoginRoutes(app, () => runtime as IntercomLoginService);
  return app;
}

function postHeaders(extra: Record<string, string> = {}) {
  return { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...extra };
}

test('login route enforces exact origin and a one-field 43-character exchange body', async () => {
  let exchangeCalls = 0;
  const app = routes({ exchange: async (token: string) => {
    exchangeCalls += 1;
    assert.equal(token, TOKEN);
    return { signed_url: LIVE_URL, expires_at: 1_900_000_000_000, workspace_id: 'abc123', status: 'login_required' };
  } });
  try {
    const wrongOrigin = await app.inject({ method: 'POST', url: '/browser/login/exchange', headers: { ...postHeaders(), origin: 'https://evil.example' }, payload: { token: TOKEN } });
    assert.equal(wrongOrigin.statusCode, 403);
    const crossSite = await app.inject({ method: 'POST', url: '/browser/login/exchange', headers: postHeaders({ 'sec-fetch-site': 'cross-site' }), payload: { token: TOKEN } });
    assert.equal(crossSite.statusCode, 403);
    const extraField = await app.inject({ method: 'POST', url: '/browser/login/exchange', headers: postHeaders(), payload: { token: TOKEN, workspace_id: 'attacker' } });
    assert.equal(extraField.statusCode, 400);
    const malformed = await app.inject({ method: 'POST', url: '/browser/login/exchange', headers: postHeaders(), payload: { token: 'short' } });
    assert.equal(malformed.statusCode, 400);
    assert.equal(exchangeCalls, 0);

    const success = await app.inject({ method: 'POST', url: '/browser/login/exchange', headers: postHeaders(), payload: { token: TOKEN } });
    assert.equal(success.statusCode, 200);
    assert.equal(exchangeCalls, 1);
    assert.deepEqual(success.json(), { signed_url: LIVE_URL, expires_at: 1_900_000_000_000, workspace_id: 'abc123', status: 'login_required' });
    assert.equal(success.headers['access-control-allow-origin'], ORIGIN);
    assert.match(success.headers['cache-control'] ?? '', /no-store/);
    assert.equal(success.headers['referrer-policy'], 'no-referrer');
    assert.match(success.headers['set-cookie'] ?? '', new RegExp(`^${COOKIE}=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600$`));
    assert.equal(success.body.includes(TOKEN), false, 'the raw one-time token is returned only in the HttpOnly cookie');
  } finally {
    await app.close();
  }
});

test('replayed exchange is single-use and returns only a sanitized error', async () => {
  let exchangeCalls = 0;
  const app = routes({ exchange: async () => {
    exchangeCalls += 1;
    if (exchangeCalls > 1) throw new Error(`ticket ${TOKEN} already consumed; ${LIVE_URL}`);
    return { signed_url: LIVE_URL, expires_at: 1_900_000_000_000, workspace_id: 'abc123', status: 'login_required' };
  } });
  try {
    const first = await app.inject({ method: 'POST', url: '/browser/login/exchange', headers: postHeaders(), payload: { token: TOKEN } });
    assert.equal(first.statusCode, 200);
    const replay = await app.inject({ method: 'POST', url: '/browser/login/exchange', headers: postHeaders(), payload: { token: TOKEN } });
    assert.equal(replay.statusCode, 409);
    assert.deepEqual(replay.json(), { error: 'login_link_expired_or_unavailable' });
    assert.equal(replay.body.includes(TOKEN), false);
    assert.equal(replay.body.includes(LIVE_URL), false);
    assert.equal(replay.headers['set-cookie'], undefined);
    assert.equal(exchangeCalls, 2);
  } finally {
    await app.close();
  }
});

test('completion accepts only the unique host cookie with no body and clears it on success', async () => {
  const completed: string[] = [];
  const app = routes({ complete: async (token: string) => {
    completed.push(token);
    return { status: 'saved', workspace_id: 'abc123', verification: 'owner_confirmation_and_exact_settings_url' };
  } });
  try {
    const duplicateCookie = await app.inject({ method: 'POST', url: '/browser/login/complete', headers: postHeaders({ cookie: `${COOKIE}=${TOKEN}; ${COOKIE}=${TOKEN}` }) });
    assert.equal(duplicateCookie.statusCode, 400);
    const badCookie = await app.inject({ method: 'POST', url: '/browser/login/complete', headers: postHeaders({ cookie: `${COOKIE}=bad` }) });
    assert.equal(badCookie.statusCode, 400);
    const bodyRejected = await app.inject({ method: 'POST', url: '/browser/login/complete', headers: postHeaders({ cookie: `${COOKIE}=${TOKEN}` }), payload: { extra: true } });
    assert.equal(bodyRejected.statusCode, 400);
    assert.equal(completed.length, 0);

    const success = await app.inject({ method: 'POST', url: '/browser/login/complete', headers: postHeaders({ cookie: `${COOKIE}=${TOKEN}` }) });
    assert.equal(success.statusCode, 200);
    assert.deepEqual(completed, [TOKEN]);
    assert.deepEqual(success.json(), { status: 'saved', workspace_id: 'abc123', verification: 'owner_confirmation_and_exact_settings_url' });
    assert.match(success.headers['set-cookie'] ?? '', new RegExp(`^${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0$`));
    assert.equal(success.body.includes(TOKEN), false);
  } finally {
    await app.close();
  }
});

test('completion failures are redacted and the browser page consumes numeric expiry fields', async () => {
  const app = routes({ complete: async () => { throw new Error(`private cookie ${TOKEN} ${LIVE_URL}`); } });
  try {
    const page = await app.inject({ method: 'GET', url: '/browser/login' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Number\.isSafeInteger\(result\.expires_at\)/, 'the login page requires numeric safe-integer expiry');
    assert.equal(page.body.includes("typeof result.workspace_id !== 'string'"), true);

    const failure = await app.inject({ method: 'POST', url: '/browser/login/complete', headers: postHeaders({ cookie: `${COOKIE}=${TOKEN}` }) });
    assert.equal(failure.statusCode, 409);
    assert.deepEqual(failure.json(), { error: 'company_settings_sign_in_not_confirmed' });
    assert.equal(failure.body.includes(TOKEN), false);
    assert.equal(failure.body.includes(LIVE_URL), false);
  } finally {
    await app.close();
  }
});
