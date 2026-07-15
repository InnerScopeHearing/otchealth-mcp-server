import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// oauth.ts calls loadEnv() at module top level (`const env = loadEnv();`), so it must be imported
// AFTER the required env vars are set -- dynamic import inside each test, run after before() has
// populated process.env. Mirrors catalog-warm.test.ts's / bearer.test.ts's pattern for the same
// underlying reason. loadEnv() caches on first call, and node's test runner isolates each test file
// in its own process, so the env set here is what oauth.ts sees.
//
// Phase 6 (2026-07-15) -- the ACTUAL fix for the DCR self-mint hole. A self-registered PUBLIC (DCR)
// client has NO identity proof (no pre-shared secret; PKCE is self-supplied; the auth code is
// readable off the /authorize 302 redirect), so anyone can complete its flow. Parts 2 + 5 hardened
// the old name->lane inference (fallback off 'clo', word-boundary matching) but could not make it
// safe, because the connector NAME is attacker-controlled by construction: naming a connector
// "Finance Tracker" bound the privileged cfo lane. Part 6 removes the inference entirely -- every
// public DCR client is hard-bound to the non-privileged 'external-read' lane REGARDLESS of name.
// These tests are the regression lock for that.

const SIGNING_SECRET = 'd'.repeat(48);

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
    // Arm OAuth 2.1 so /register is active (oauthConfigured() needs a signing secret + a client id).
    OAUTH_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
    OAUTH_CLIENT_ID: 'confidential-client',
    OAUTH_CLIENT_SECRET: 'e'.repeat(32),
    // OAUTH_DEFAULT_AGENT deliberately left unset (defaults to '' -> not privileged), so the startup
    // guard does not fire during these tests. The guard's own condition is unit-tested via the
    // exported isPrivilegedDefaultAgent() helper below.
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

// The client_name values a real caller might choose -- from plain-English business phrases that used
// to collide into a privileged lane, through explicit lane codes, to the empty name. EVERY one must
// now bind 'external-read'. This is the whole point of Part 6.
const CLIENT_NAMES = [
  'Finance Tracker',         // used to -> cfo (contains "finance")
  'CFO Finance',             // used to -> cfo (explicit code)
  'Technology Solutions',    // used to -> cto (contains "technology")
  'Legal Eagle Docs',        // used to -> clo (contains "legal")
  'clo-personal matter',     // used to -> clo-personal (the most sensitive lane)
  'OTCHealth CTO Connector', // used to -> cto
  'My Custom Connector',     // used to -> cto (substring "cto" inside "connector")
  '',                        // empty name
];

test('SAFETY-CRITICAL Part 6: POST /register binds external-read REGARDLESS of client_name', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes } = await import('./oauth.js');
  const { parseStatelessClient } = await import('../auth/oauth-tokens.js');

  const app = Fastify();
  registerOAuthRoutes(app);

  for (const client_name of CLIENT_NAMES) {
    const res = await app.inject({
      method: 'POST',
      url: '/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name }),
    });
    assert.equal(res.statusCode, 201, `/register should succeed for name ${JSON.stringify(client_name)}`);
    const clientId = res.json().client_id as string;
    assert.ok(clientId.startsWith('dcr_'), 'a public DCR client_id starts with dcr_');
    const decoded = parseStatelessClient(clientId, SIGNING_SECRET);
    assert.ok(decoded, 'the issued client_id must decode + verify against the signing secret');
    assert.equal(
      decoded!.agent,
      'external-read',
      `client_name ${JSON.stringify(client_name)} must bind external-read, never a privileged/ship lane`,
    );
  }

  await app.close();
});

test('Part 6: /register still validates redirect_uris (missing/empty -> 400, unchanged)', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes } = await import('./oauth.js');

  const app = Fastify();
  registerOAuthRoutes(app);

  // Empty redirect_uris is rejected UNCONDITIONALLY (independent of OAUTH_REDIRECT_URIS config),
  // proving the redirect-validation branch above the lane binding is intact after the Part 6 edit.
  // (A non-https / non-allow-listed reject depends on OAUTH_REDIRECT_URIS being set, so it is not a
  // config-independent assertion; the empty-list reject is.)
  const res = await app.inject({
    method: 'POST',
    url: '/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ redirect_uris: [], client_name: 'CFO Finance' }),
  });
  assert.equal(res.statusCode, 400, 'empty redirect_uris must be rejected');
  assert.equal(res.json().error, 'invalid_redirect_uri');

  await app.close();
});

// ── The OAUTH_DEFAULT_AGENT startup guard (reviewer nit) ───────────────────────────────────────
// isPrivilegedDefaultAgent() is the guard's condition, extracted + exported for a hermetic test
// (capturing pino output in-process is fiddly and brittle). It gates a loud logger.warn at startup
// if the static-token lane is ever set to a privileged EXEC_RING lane.
test('Part 6 guard: isPrivilegedDefaultAgent flags EXEC_RING lanes and clears safe ones', async () => {
  const { isPrivilegedDefaultAgent } = await import('./oauth.js');
  const { EXEC_RING } = await import('../tools/kb/search-privileged.js');

  for (const lane of EXEC_RING) {
    assert.equal(isPrivilegedDefaultAgent(lane), true, `${lane} is privileged and must be flagged`);
  }
  // The safe lanes: cto (prod's actual value, NOT in EXEC_RING), the non-privileged floor, developer,
  // and the empty/absent value must all be CLEAR (guard does not fire).
  assert.equal(isPrivilegedDefaultAgent('cto'), false, "prod's 'cto' must not trip the guard");
  assert.equal(isPrivilegedDefaultAgent('external-read'), false);
  assert.equal(isPrivilegedDefaultAgent('developer'), false);
  assert.equal(isPrivilegedDefaultAgent(''), false);
  assert.equal(isPrivilegedDefaultAgent(undefined), false);
  assert.equal(isPrivilegedDefaultAgent(null), false);
  // Case-insensitive (env values may be mixed case).
  assert.equal(isPrivilegedDefaultAgent('CFO'), true);
});
