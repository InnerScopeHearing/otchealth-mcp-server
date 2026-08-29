import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// URL-only connect + owner-code role elevation at consent (server/oauth-consent.ts,
// auth/setup-codes.ts). Full end-to-end coverage of registerOAuthRoutes's ACTUAL Fastify wiring
// via app.inject(), not just the extracted core functions (already covered directly and
// exhaustively in oauth-consent.test.ts / setup-codes.test.ts) -- this is the layer that decides
// WHICH clients ever see the interstitial at all, so it gets its own end-to-end proof.
//
// registerOAuthRoutes(app, { consent, setupCode }) takes an injectable deps override (mirroring
// server/heygen-pairing.ts's registerHeyGenPairingRoute(app, deps) convention) so these tests run
// against the REAL routes with a fake in-memory `cache` store instead of a live Postgres/Cosmos
// instance -- this repo's established pattern for testing storage-backed HTTP routes hermetically
// (see semantic-cache.test.ts's header: "this repo's ESM build does not allow node:test's
// mock.method() to override another module's live named export" -- dependency injection, not
// module mocking, is how every other file in this repo solves this).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

interface FakeCacheRow {
  doc: Record<string, unknown>;
  etag: string;
}

/** A fake shared `cache` store with REAL ETag CAS semantics, wired to BOTH an OAuthConsentDeps and
 *  a SetupCodeDeps pointing at the SAME backing Map -- so a code minted via one and redeemed via
 *  the other behaves exactly as it would against one real shared Postgres table. */
function fakeConsentStack(): {
  consent: import('./oauth-consent.js').OAuthConsentDeps;
  setupCode: import('../auth/setup-codes.js').SetupCodeDeps;
  store: Map<string, FakeCacheRow>;
} {
  const store = new Map<string, FakeCacheRow>();
  let etagSeq = 0;
  let randSeq = 0;
  const randomBytesImpl = (n: number): Buffer => {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) buf[i] = (i * 41 + randSeq * 13) & 0xff;
    randSeq += 1;
    return buf;
  };
  const create = (async (_coll: string, pk: string, doc: Record<string, unknown>) => {
    const id = String(doc.id);
    if (pk !== id) throw new Error('pk must equal doc id');
    if (store.has(id)) throw new Error('duplicate id');
    const etag = `E${++etagSeq}`;
    store.set(id, { doc, etag });
    return { status: 201, ok: true, body: doc, etag };
  }) as import('../auth/setup-codes.js').SetupCodeDeps['create'];
  const read = (async (_coll: string, pk: string, id: string) => {
    if (pk !== id) throw new Error('pk must equal id');
    const row = store.get(id);
    return row ? { doc: row.doc, etag: row.etag } : null;
  }) as import('../auth/setup-codes.js').SetupCodeDeps['read'];
  const replace = (async (_coll: string, pk: string, id: string, doc: Record<string, unknown>, ifMatch?: string) => {
    if (pk !== id) throw new Error('pk must equal id');
    const current = store.get(id);
    if (!current) return { status: 404, ok: false, body: null, etag: null };
    if (ifMatch !== undefined && current.etag !== ifMatch) return { status: 412, ok: false, body: null, etag: null };
    const etag = `E${++etagSeq}`;
    store.set(id, { doc, etag });
    return { status: 200, ok: true, body: doc, etag };
  }) as import('../auth/setup-codes.js').SetupCodeDeps['replace'];
  const del = (async (_coll: string, pk: string, id: string) => {
    if (pk !== id) throw new Error('pk must equal id');
    const existed = store.delete(id);
    return { status: existed ? 204 : 404, ok: existed, body: null, etag: null };
  }) as import('./oauth-consent.js').OAuthConsentDeps['delete'];
  const consent: import('./oauth-consent.js').OAuthConsentDeps = {
    now: () => Date.now(),
    randomBytesImpl,
    create,
    read,
    replace,
    delete: del,
    configured: () => true,
  };
  const setupCode: import('../auth/setup-codes.js').SetupCodeDeps = {
    now: () => Date.now(),
    randomBytesImpl,
    create,
    read,
    replace,
    configured: () => true,
  };
  return { consent, setupCode, store };
}

/** A real PKCE S256 pair (verifier + its derived challenge), so the full /oauth/authorize ->
 *  /oauth/authorize/consent -> /oauth/token chain exercises REAL PKCE verification, not a stub. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** server/index.ts registers this content-type parser globally so /oauth/token and the new
 *  /oauth/authorize/consent form POST can be read as urlencoded bodies; a bare Fastify() instance
 *  (as every test in this file builds) does not have it by default and 415s without it. Mirrors
 *  index.ts's registration verbatim. */
function addFormUrlEncodedParser(app: import('fastify').FastifyInstance): void {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
}

async function registerDcrClient(app: import('fastify').FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: 'Test URL-Only Connector' }),
  });
  assert.equal(res.statusCode, 201);
  return res.json().client_id as string;
}

test('CONFIDENTIAL CLIENTS ARE BYTE-FOR-BYTE UNCHANGED: GET /oauth/authorize auto-issues + 302s, no interstitial', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes } = await import('./oauth.js');

  const app = Fastify();
  registerOAuthRoutes(app); // NO deps override -- this path must never even reach the new storage.
  const { challenge } = pkcePair();

  const res = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?client_id=confidential-client&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}` +
      `&response_type=code&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`,
  });
  assert.equal(res.statusCode, 302, 'a confidential client must be auto-issued a code, never shown the interstitial');
  assert.ok(res.headers.location, 'a redirect must carry a Location header');
  const loc = new URL(String(res.headers.location));
  assert.ok(loc.searchParams.get('code'), 'the redirect must carry an issued code');
  assert.equal(loc.searchParams.get('state'), 'xyz');
  // The interstitial's own headers/body must be entirely absent from this response.
  assert.equal(res.headers['content-security-policy'], undefined);
  assert.equal(res.payload.includes('Connect to the OTCHealth gateway'), false);

  await app.close();
});

test('DCR (PUBLIC) client is shown the consent interstitial instead of an auto-issued code', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes } = await import('./oauth.js');

  const app = Fastify();
  addFormUrlEncodedParser(app);
  const { consent, setupCode } = fakeConsentStack();
  registerOAuthRoutes(app, { consent, setupCode });

  const clientId = await registerDcrClient(app);
  const { challenge } = pkcePair();

  const res = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}` +
      `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
  });
  assert.equal(res.statusCode, 200, 'a public DCR client must see the interstitial, not a redirect');
  assert.equal(res.statusCode === 302, false);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.payload, /A connector is requesting access to the OTCHealth gateway/);
  assert.match(res.payload, /name="action" value="readonly"/);
  assert.match(res.payload, /name="action" value="elevate"/);
  const pendingMatch = res.payload.match(/name="pending_id" value="([a-f0-9]{32})"/);
  assert.ok(pendingMatch, 'the page must carry a valid-looking pending_id');

  await app.close();
});

test('E2E: a DCR client choosing "connect read-only" reaches the token endpoint as external-read, and STAYS external-read on refresh', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes, issuedAgent, isValidIssuedAccessToken } = await import('./oauth.js');

  const app = Fastify();
  addFormUrlEncodedParser(app);
  const { consent, setupCode } = fakeConsentStack();
  registerOAuthRoutes(app, { consent, setupCode });

  const clientId = await registerDcrClient(app);
  const { verifier, challenge } = pkcePair();

  const authRes = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}` +
      `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
  });
  const pendingId = authRes.payload.match(/name="pending_id" value="([a-f0-9]{32})"/)![1];

  const consentRes = await app.inject({
    method: 'POST',
    url: '/oauth/authorize/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pending_id=${pendingId}&action=readonly`,
  });
  assert.equal(consentRes.statusCode, 302);
  const code = new URL(String(consentRes.headers.location)).searchParams.get('code');
  assert.ok(code);

  const tokenRes = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `grant_type=authorization_code&code=${code}&client_id=${encodeURIComponent(clientId)}&code_verifier=${verifier}`,
  });
  assert.equal(tokenRes.statusCode, 200, JSON.stringify(tokenRes.json()));
  const body = tokenRes.json();
  assert.equal(isValidIssuedAccessToken(body.access_token), true);
  assert.equal(issuedAgent(body.access_token), 'external-read');

  // Refresh must ALSO stay external-read (this is the "no code, no elevation, ever" baseline the
  // elevated-path test below is contrasted against).
  const refreshRes = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `grant_type=refresh_token&refresh_token=${body.refresh_token}`,
  });
  assert.equal(refreshRes.statusCode, 200);
  assert.equal(issuedAgent(refreshRes.json().access_token), 'external-read');

  await app.close();
});

test('E2E: a DCR client redeeming a genuine cfo setup code reaches the token endpoint AS cfo, and STAYS cfo across refresh', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes, issuedAgent } = await import('./oauth.js');
  const { mintSetupCode } = await import('../auth/setup-codes.js');

  const app = Fastify();
  addFormUrlEncodedParser(app);
  const { consent, setupCode } = fakeConsentStack();
  registerOAuthRoutes(app, { consent, setupCode });

  const minted = await mintSetupCode({ role: 'cfo', createdBy: 'cto' }, setupCode);

  const clientId = await registerDcrClient(app);
  const { verifier, challenge } = pkcePair();

  const authRes = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}` +
      `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
  });
  const pendingId = authRes.payload.match(/name="pending_id" value="([a-f0-9]{32})"/)![1];

  const consentRes = await app.inject({
    method: 'POST',
    url: '/oauth/authorize/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pending_id=${pendingId}&action=elevate&code=${encodeURIComponent(minted.code)}`,
  });
  assert.equal(consentRes.statusCode, 302, JSON.stringify(consentRes.payload));
  const code = new URL(String(consentRes.headers.location)).searchParams.get('code');
  assert.ok(code);

  const tokenRes = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `grant_type=authorization_code&code=${code}&client_id=${encodeURIComponent(clientId)}&code_verifier=${verifier}`,
  });
  assert.equal(tokenRes.statusCode, 200, JSON.stringify(tokenRes.json()));
  const body = tokenRes.json();
  assert.equal(issuedAgent(body.access_token), 'cfo', 'the access token must carry the elevated role');

  // THE key regression this feature exists to fix: a refresh must NOT silently re-derive the
  // client's baked-in external-read lane and drop the elevation.
  const refreshRes = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `grant_type=refresh_token&refresh_token=${body.refresh_token}`,
  });
  assert.equal(refreshRes.statusCode, 200);
  assert.equal(issuedAgent(refreshRes.json().access_token), 'cfo', 'refresh must PRESERVE the elevated role, never revert to external-read');

  // And a SECOND refresh (refreshing a refresh) must still preserve it -- not a one-hop fluke.
  const refresh2 = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `grant_type=refresh_token&refresh_token=${refreshRes.json().refresh_token}`,
  });
  assert.equal(refresh2.statusCode, 200);
  assert.equal(issuedAgent(refresh2.json().access_token), 'cfo');

  await app.close();
});

test('A wrong code never elevates: the connector still ends up external-read after choosing "connect read-only" instead', async () => {
  // Defends against a specific confused-outcome bug: a caller who fails a code guess must be able
  // to fall back to the EXPLICIT read-only button and still succeed as external-read, not be
  // permanently stuck by the earlier failed guess.
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes, issuedAgent } = await import('./oauth.js');

  const app = Fastify();
  addFormUrlEncodedParser(app);
  const { consent, setupCode } = fakeConsentStack();
  registerOAuthRoutes(app, { consent, setupCode });

  const clientId = await registerDcrClient(app);
  const { verifier, challenge } = pkcePair();

  const authRes = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}` +
      `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
  });
  const pendingId = authRes.payload.match(/name="pending_id" value="([a-f0-9]{32})"/)![1];

  const wrongRes = await app.inject({
    method: 'POST',
    url: '/oauth/authorize/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pending_id=${pendingId}&action=elevate&code=TOTALLY-WRONG-0000`,
  });
  assert.equal(wrongRes.statusCode, 200, 'a wrong guess re-renders the form, it does not redirect');
  assert.match(wrongRes.payload, /invalid or has expired/);

  const readOnlyRes = await app.inject({
    method: 'POST',
    url: '/oauth/authorize/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pending_id=${pendingId}&action=readonly`,
  });
  assert.equal(readOnlyRes.statusCode, 302);
  const code = new URL(String(readOnlyRes.headers.location)).searchParams.get('code');

  const tokenRes = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `grant_type=authorization_code&code=${code}&client_id=${encodeURIComponent(clientId)}&code_verifier=${verifier}`,
  });
  assert.equal(issuedAgent(tokenRes.json().access_token), 'external-read');

  await app.close();
});

test('TAMPERED/UNKNOWN/EXPIRED pending_id -> clean 400, no redirect, for both a malformed id and a well-formed but unknown one', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes } = await import('./oauth.js');

  const app = Fastify();
  addFormUrlEncodedParser(app);
  const { consent, setupCode } = fakeConsentStack();
  registerOAuthRoutes(app, { consent, setupCode });

  // Malformed shape -- rejected before storage is even consulted.
  const malformed = await app.inject({
    method: 'POST',
    url: '/oauth/authorize/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'pending_id=not-a-valid-id&action=readonly',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.headers.location, undefined, 'a 400 must never carry a redirect Location');

  // Well-formed but never created.
  const neverExisted = await app.inject({
    method: 'POST',
    url: '/oauth/authorize/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pending_id=${'a'.repeat(32)}&action=elevate&code=WHATEVER-0000-0000`,
  });
  assert.equal(neverExisted.statusCode, 400);
  assert.equal(neverExisted.headers.location, undefined);

  // Missing action entirely.
  const noAction = await app.inject({
    method: 'POST',
    url: '/oauth/authorize/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `pending_id=${'b'.repeat(32)}`,
  });
  assert.equal(noAction.statusCode, 400);
  assert.equal(noAction.headers.location, undefined);

  await app.close();
});

test('clo-personal can never be redeemed via the consent flow, even if somehow minted (defense in depth at the token-issue seam)', async () => {
  // A code cannot actually be MINTED for clo-personal (auth/setup-codes.ts's assertMintableRole
  // refuses it outright -- see setup-codes.test.ts). This test proves the SECOND, independent
  // backstop: even if an AuthCodeRecord somehow carried elevatedAgent:'clo-personal' (a
  // hand-crafted doc, a future bug elsewhere), oauth.ts's own isElevationRole() re-check at the
  // token endpoint refuses to honor it and falls back to the client's real lane (external-read)
  // rather than minting a token for an unvalidated privileged identity.
  const { default: Fastify } = await import('fastify');
  const { registerOAuthRoutes, issuedAgent } = await import('./oauth.js');
  const { createAuthCode } = await import('../auth/oauth-tokens.js');

  const app = Fastify();
  addFormUrlEncodedParser(app);
  const { consent, setupCode } = fakeConsentStack();
  registerOAuthRoutes(app, { consent, setupCode });

  const clientId = await registerDcrClient(app);
  const { verifier, challenge } = pkcePair();

  // Hand-craft the auth code the way ONLY resolveElevateChoice's success path is supposed to be
  // able to (bypassing the interstitial entirely, simulating "something upstream is broken").
  const code = await createAuthCode({
    clientId,
    redirectUri: CLAUDE_CALLBACK,
    scope: 'mcp',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    elevatedAgent: 'clo-personal',
  });

  const tokenRes = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `grant_type=authorization_code&code=${code}&client_id=${encodeURIComponent(clientId)}&code_verifier=${verifier}`,
  });
  assert.equal(tokenRes.statusCode, 200);
  assert.equal(
    issuedAgent(tokenRes.json().access_token),
    'external-read',
    'an out-of-allowlist elevatedAgent must fall back to the client\'s real (external-read) lane, never be honored',
  );

  await app.close();
});
