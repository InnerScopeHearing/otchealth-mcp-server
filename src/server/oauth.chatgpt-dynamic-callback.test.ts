import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Regression lock for ChatGPT's per-connection dynamic OAuth callback at /register (2026-09-05,
 * FND-20260904-4b1e).
 *
 * WHY: OpenAI's Apps SDK documents two callbacks for a custom MCP app. With issuer identification
 * ChatGPT redirects to the FIXED https://chatgpt.com/connector_platform_oauth_redirect, which the
 * live OAUTH_REDIRECT_URIS allow-list already names. Without it, ChatGPT sends a PER-CONNECTION
 * https://chatgpt.com/connector/oauth/{callback_id}. That id is minted by ChatGPT per connection and
 * can never be enumerated in configuration, exactly like the RFC 8252 ephemeral loopback port, so
 * against an exact-match list the client was refused at /register with 400 invalid_redirect_uri,
 * and until this same change the refusal was not even logged (only the success path logged).
 *
 * Three locks, in order of strength:
 *   1. the predicate itself, imported directly (pure, no env): the exact accept set and every
 *      look-alike that must stay rejected;
 *   2. the route, end to end through Fastify with the LIVE-shaped allow-list (non-empty, naming the
 *      fixed ChatGPT callback), so acceptance of the dynamic callback is provably the new rule and
 *      not the "empty allow-list accepts any https" fallback;
 *   3. the source: ordering inside allowedRedirect and the unchanged external-read hard-binding.
 *
 * oauth.ts calls loadEnv() at import, so the module is imported dynamically after before() has set
 * the required env, mirroring oauth.test.ts.
 */

const SIGNING_SECRET = 'd'.repeat(48);
const FIXED_CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
    OAUTH_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
    OAUTH_CLIENT_ID: 'confidential-client',
    OAUTH_CLIENT_SECRET: 'e'.repeat(32),
    // Live-shaped: a NON-EMPTY exact-match list that names the fixed ChatGPT callback. With this set,
    // the only way the dynamic callback can be accepted is the new predicate, and every rejected
    // look-alike is rejected on its own merits rather than by an empty-list fallback.
    OAUTH_REDIRECT_URIS: FIXED_CHATGPT_CALLBACK,
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

const ACCEPT = [
  'https://chatgpt.com/connector/oauth/abc123',
  'https://chatgpt.com/connector/oauth/conn_01HZY8QK3M5R7T9V',
  'https://chatgpt.com/connector/oauth/a-b_c.d~e',
  `https://chatgpt.com/connector/oauth/${'x'.repeat(128)}`,
];

// Every one of these must stay rejected. Each names the specific widening it guards against.
const REJECT: Array<[string, string]> = [
  ['https://chatgpt.com/connector/oauth/abc123?x=1', 'query string (parameter smuggling)'],
  ['https://chatgpt.com/connector/oauth/abc123#frag', 'fragment'],
  ['https://chatgpt.com/connector/oauth/a/b', 'more than one path segment after the prefix'],
  ['https://chatgpt.com/connector/oauth/', 'empty callback id'],
  ['https://chatgpt.com/connector/oauth', 'prefix without an id'],
  [`https://chatgpt.com/connector/oauth/${'x'.repeat(129)}`, 'callback id over the 128-char bound'],
  ['https://chatgpt.com/connector/oauth/abc%2F123', 'percent-encoded slash (not in the id alphabet)'],
  ['https://chatgpt.com/other/oauth/abc123', 'wrong path prefix'],
  ['https://chatgpt.com/connector_platform_oauth_redirect/abc', 'fixed-callback path with a trailing segment'],
  ['http://chatgpt.com/connector/oauth/abc123', 'plain http'],
  ['https://chatgpt.com:8443/connector/oauth/abc123', 'explicit port'],
  ['https://user@chatgpt.com/connector/oauth/abc123', 'userinfo prefix'],
  ['https://user:pw@chatgpt.com/connector/oauth/abc123', 'userinfo with password'],
  ['https://chatgpt.com.evil.example/connector/oauth/abc123', 'look-alike suffix host'],
  ['https://evil.example/connector/oauth/abc123', 'unrelated host'],
  ['https://www.chatgpt.com/connector/oauth/abc123', 'subdomain (must be exactly chatgpt.com)'],
  ['https://chat.openai.com/connector/oauth/abc123', 'sibling OpenAI host'],
  ['https://chatgpt.com@evil.example/connector/oauth/abc123', 'chatgpt.com as userinfo of an evil host'],
  ['https://evil.example/?u=https://chatgpt.com/connector/oauth/abc123', 'chatgpt URL nested in a query'],
  ['not a url', 'unparseable'],
  ['', 'empty string'],
];

test('isChatgptDynamicCallback accepts exactly the documented per-connection callback shape', async () => {
  const { isChatgptDynamicCallback } = await import('./oauth.js');
  for (const uri of ACCEPT) assert.equal(isChatgptDynamicCallback(uri), true, `must accept ${uri}`);
});

test('isChatgptDynamicCallback rejects every look-alike (host, scheme, port, userinfo, path, query, fragment)', async () => {
  const { isChatgptDynamicCallback } = await import('./oauth.js');
  for (const [uri, why] of REJECT) assert.equal(isChatgptDynamicCallback(uri), false, `must reject ${JSON.stringify(uri)} (${why})`);
  // The fixed callback is NOT this predicate's job; it is admitted by the allow-list. Keeping the
  // two paths separate means removing the list entry cannot be silently papered over here.
  assert.equal(isChatgptDynamicCallback(FIXED_CHATGPT_CALLBACK), false, 'the fixed callback is the allow-list\'s responsibility, not the dynamic rule\'s');
});

test('POST /register accepts the dynamic ChatGPT callback and still hard-binds external-read', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes } = await import('./oauth.js');
  const { parseStatelessClient } = await import('../auth/oauth-tokens.js');
  const app = Fastify();
  registerOAuthRoutes(app);

  for (const uri of ACCEPT) {
    const res = await app.inject({
      method: 'POST',
      url: '/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ redirect_uris: [uri], client_name: 'OTCHealth CTO' }),
    });
    assert.equal(res.statusCode, 201, `/register must accept ${uri}: ${res.body}`);
    const clientId = res.json().client_id as string;
    assert.ok(clientId.startsWith('dcr_'), 'a public DCR client_id starts with dcr_');
    const decoded = parseStatelessClient(clientId, SIGNING_SECRET);
    assert.ok(decoded, 'the issued client_id must decode + verify against the signing secret');
    assert.equal(decoded!.agent, 'external-read', 'a dynamic-callback DCR client binds external-read and nothing wider');
    assert.deepEqual(res.json().redirect_uris, [uri], 'the accepted redirect is echoed back verbatim');
  }

  // The fixed callback keeps working through the allow-list, unchanged by this rule.
  const fixed = await app.inject({
    method: 'POST',
    url: '/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ redirect_uris: [FIXED_CHATGPT_CALLBACK] }),
  });
  assert.equal(fixed.statusCode, 201, `the fixed ChatGPT callback must still register: ${fixed.body}`);
});

test('POST /register rejects every look-alike with 400 invalid_redirect_uri and LOGS the rejection', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes } = await import('./oauth.js');
  const { logger } = await import('../audit/logger.js');
  const app = Fastify();
  registerOAuthRoutes(app);

  // Capture warn() calls. logger is a shared pino instance; an own-property assignment shadows the
  // prototype method for the duration of this test and is restored in finally.
  const captured: Array<Record<string, unknown>> = [];
  const original = logger.warn;
  (logger as unknown as { warn: unknown }).warn = ((obj: unknown) => {
    if (obj && typeof obj === 'object') captured.push(obj as Record<string, unknown>);
  }) as typeof logger.warn;
  try {
    for (const [uri, why] of REJECT) {
      if (uri === '') continue; // an empty string is filtered out before the check; covered by the no-uris case below
      captured.length = 0;
      const res = await app.inject({
        method: 'POST',
        url: '/register',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ redirect_uris: [uri], client_name: 'x'.repeat(200) }),
      });
      assert.equal(res.statusCode, 400, `/register must reject ${JSON.stringify(uri)} (${why})`);
      assert.equal(res.json().error, 'invalid_redirect_uri');
      const rejections = captured.filter((c) => c.type === 'oauth_register_rejected');
      assert.equal(rejections.length, 1, `exactly one oauth_register_rejected log line for ${JSON.stringify(uri)}`);
      assert.equal(rejections[0].reason, 'invalid_redirect_uri');
      assert.deepEqual(rejections[0].redirect_uris, [uri], 'the offending redirect_uri is the diagnostic and must be in the log');
      assert.equal((rejections[0].client_name as string).length, 80, 'client_name is bounded to 80 chars in the log');
    }

    // A mixed list is rejected as a whole (every URI must pass), and the log shows the first five.
    captured.length = 0;
    const many = [...ACCEPT.slice(0, 2), 'https://evil.example/connector/oauth/abc', ...ACCEPT, ACCEPT[0]];
    const mixed = await app.inject({
      method: 'POST',
      url: '/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ redirect_uris: many }),
    });
    assert.equal(mixed.statusCode, 400, 'one disallowed redirect poisons the whole registration');
    const rej = captured.filter((c) => c.type === 'oauth_register_rejected');
    assert.equal(rej.length, 1);
    assert.equal((rej[0].redirect_uris as string[]).length, 5, 'the logged list is bounded to five');
    assert.equal(rej[0].client_name, null, 'an absent client_name logs as null, not undefined');

    // No redirect_uris at all: same rejection, same log line, an empty list in it.
    captured.length = 0;
    const none = await app.inject({ method: 'POST', url: '/register', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ redirect_uris: [] }) });
    assert.equal(none.statusCode, 400);
    assert.equal(captured.filter((c) => c.type === 'oauth_register_rejected').length, 1, 'the no-redirect case is logged too');

    // The other rejection branch (bad application_type) is logged with its own reason.
    captured.length = 0;
    const badType = await app.inject({
      method: 'POST',
      url: '/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ redirect_uris: [ACCEPT[0]], application_type: 'desktop' }),
    });
    assert.equal(badType.statusCode, 400);
    assert.equal(badType.json().error, 'invalid_client_metadata');
    const meta = captured.filter((c) => c.type === 'oauth_register_rejected');
    assert.equal(meta.length, 1);
    assert.equal(meta[0].reason, 'invalid_client_metadata');
    assert.equal(meta[0].application_type, 'desktop');
  } finally {
    (logger as unknown as { warn: unknown }).warn = original;
  }
});

// ── Source-level locks (mirror oauth.loopback-redirect.test.ts) ─────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'oauth.ts'), 'utf8');

test('allowedRedirect consults the dynamic-callback rule AFTER loopback and BEFORE the exact-match allow-list', () => {
  const fn = SRC.slice(SRC.indexOf('function allowedRedirect'));
  const loopbackAt = fn.indexOf('isLoopbackRedirect(uri)');
  const dynamicAt = fn.indexOf('isChatgptDynamicCallback(uri)');
  const listAt = fn.indexOf('OAUTH_REDIRECT_URIS');
  assert.ok(loopbackAt > 0 && dynamicAt > 0 && listAt > 0, 'allowedRedirect must call all three');
  assert.ok(loopbackAt < dynamicAt && dynamicAt < listAt, 'a per-connection callback can never be enumerated in config, so it is checked before the list');
});

test('the dynamic-callback rule stays narrow by construction', () => {
  const fn = SRC.slice(SRC.indexOf('function isChatgptDynamicCallback'), SRC.indexOf('function allowedRedirect'));
  assert.match(fn, /u\.protocol !== 'https:'/, 'https only');
  assert.match(fn, /u\.hostname !== 'chatgpt\.com'/, 'host must be exactly chatgpt.com');
  assert.match(fn, /u\.username \|\| u\.password \|\| u\.port/, 'no userinfo, no explicit port');
  assert.match(fn, /u\.search \|\| u\.hash/, 'no query or fragment');
  assert.match(fn, /catch\s*{\s*\n?\s*return false/, 'unparseable is rejected');
  assert.match(SRC, /\/\^\\\/connector\\\/oauth\\\/\[A-Za-z0-9_\.~-\]\{1,128\}\$\//, 'the path regex is anchored, single-segment, bounded');
});

test('SECURITY: the DCR external-read hard-binding comment is still present and was not loosened alongside this change', () => {
  assert.match(SRC, /hard-bound to the non-privileged 'external-read' lane/);
});

test('both /register rejection branches log an oauth_register_rejected event', () => {
  const handler = SRC.slice(SRC.indexOf("app.post('/register'"));
  const first = handler.indexOf("reason: 'invalid_redirect_uri'");
  const second = handler.indexOf("reason: 'invalid_client_metadata'");
  assert.ok(first > 0 && second > first, 'a rejected registration is an event an operator must be able to see');
});
