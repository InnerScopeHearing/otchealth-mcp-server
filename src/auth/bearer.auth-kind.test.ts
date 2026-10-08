/**
 * validateBearer records HOW a request authenticated (auth_kind). The AWS MCP bridge uses it to serve
 * OAuth-authenticated CTO sessions only, so each credential type must be classified correctly here:
 * a static token that resolves to the CTO lane must never look like an OAuth session.
 *
 * Every credential below is synthetic (at least 32 characters, the minimum for a static token).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';

const SIGNING_SECRET = 'synthetic-signing-' + 's'.repeat(40);
const pad = (label: string, ch: string): string => `synthetic-${label}-` + ch.repeat(40);
const TOKENS = {
  connector: pad('connector', 'c'),
  copilot: pad('copilot', 'p'),
  eval: pad('eval', 'e'),
  copilotDev: pad('copilot-dev', 'd'),
  m365Cto: pad('m365-cto', 'm'),
  m365Cfo: pad('m365-cfo', 'f'),
  codexCto: pad('codex-cto', 'x'),
  codexCfo: pad('codex-cfo', 'y'),
};
const DESCOPE_PROJECT = 'Psynthetic0project';

Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track-key',
  CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: TOKENS.connector,
  ADMIN_REVOKE_TOKEN: pad('admin', 'a'),
  N8N_WEBHOOK_SECRET: pad('webhook', 'n'),
  COPILOT_AGENT_TOKEN: TOKENS.copilot,
  EVAL_AGENT_TOKEN: TOKENS.eval,
  COPILOT_DEV_AGENT_TOKEN: TOKENS.copilotDev,
  M365_CTO_MCP_TOKEN: TOKENS.m365Cto,
  M365_CFO_MCP_TOKEN: TOKENS.m365Cfo,
  CODEX_CTO_MCP_TOKEN: TOKENS.codexCto,
  CODEX_CFO_MCP_TOKEN: TOKENS.codexCfo,
  OAUTH_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
  // The connector token is bound to this lane, which is exactly the exposure the bridge guards against.
  OAUTH_DEFAULT_AGENT: 'cto',
  DESCOPE_PROJECT_ID: DESCOPE_PROJECT,
  DESCOPE_PILOT_LANES: 'cto',
  REVOCATION_MEMORY_ONLY_MODE: 'development',
  SHIELD_MODE: 'off',
  COLD_START_MODE: 'off',
  TOOL_CATALOG_CURATION_MODE: 'off',
});

const { validateBearer, requireConnectorAuth } = await import('./bearer.js');
const { issueAccessToken, issueRefreshToken } = await import('./oauth-tokens.js');
const { default: Fastify } = await import('fastify');

const ready = (): boolean => true;
const bearer = (token: string): string => `Bearer ${token}`;

test('a gateway-issued OAuth access token is recorded as oauth, whatever its client', async () => {
  for (const [clientId, connectorSurface] of [
    ['dcr_fixture', true], // a Claude Chat connector registered by Dynamic Client Registration
    ['occ_fixture', true], // a manually registered confidential connector client
    ['synthetic-per-agent-client', false], // a client_credentials client: also OAuth, but not the connector surface
  ] as const) {
    const token = issueAccessToken(clientId, 'mcp', SIGNING_SECRET, 'https://fixture.invalid', 'cto');
    const auth = await validateBearer(bearer(token), ready);
    assert.ok(auth, clientId);
    assert.equal(auth.auth_kind, 'oauth', clientId);
    assert.equal(auth.caller_agent, 'cto');
    assert.equal(auth.connector_surface, connectorSurface);
    assert.equal(auth.m365_static_auth, false);
  }
});

test('refresh tokens, tokens signed with another secret and unknown tokens authenticate as nothing', async () => {
  const refresh = issueRefreshToken('dcr_fixture', 'mcp', SIGNING_SECRET, 'https://fixture.invalid', 'cto');
  assert.equal(await validateBearer(bearer(refresh), ready), null);
  const foreign = issueAccessToken('dcr_fixture', 'mcp', 'a-different-' + 's'.repeat(40), 'https://fixture.invalid', 'cto');
  assert.equal(await validateBearer(bearer(foreign), ready), null);
  assert.equal(await validateBearer(bearer(pad('unknown', 'u')), ready), null);
  assert.equal(await validateBearer(undefined, ready), null);
});

test('every static credential is recorded with its own kind and never as oauth', async () => {
  const cases: Array<{ token: string; kind: string; agent: string; m365: boolean; connectorSurface: boolean }> = [
    { token: TOKENS.connector, kind: 'connector', agent: 'cto', m365: false, connectorSurface: false },
    { token: TOKENS.copilot, kind: 'copilot', agent: 'copilot-agent', m365: false, connectorSurface: false },
    { token: TOKENS.eval, kind: 'eval', agent: 'copilot-agent', m365: false, connectorSurface: false },
    { token: TOKENS.copilotDev, kind: 'copilot-dev', agent: 'developer', m365: false, connectorSurface: false },
    { token: TOKENS.m365Cto, kind: 'm365', agent: 'cto', m365: true, connectorSurface: false },
    { token: TOKENS.m365Cfo, kind: 'm365', agent: 'cfo', m365: true, connectorSurface: false },
    { token: TOKENS.codexCto, kind: 'codex', agent: 'cto', m365: false, connectorSurface: true },
    { token: TOKENS.codexCfo, kind: 'codex', agent: 'cfo', m365: false, connectorSurface: true },
  ];
  for (const c of cases) {
    const auth = await validateBearer(bearer(c.token), ready);
    assert.ok(auth, c.kind);
    assert.equal(auth.auth_kind, c.kind, `${c.kind} for ${c.agent}`);
    assert.notEqual(auth.auth_kind, 'oauth');
    assert.equal(auth.caller_agent, c.agent);
    assert.equal(auth.m365_static_auth, c.m365);
    assert.equal(auth.connector_surface, c.connectorSurface);
  }
});

test('the static credentials that reach the CTO lane are exactly the ones the bridge must refuse', async () => {
  const reachingCto: string[] = [];
  for (const [label, token] of Object.entries(TOKENS)) {
    const auth = await validateBearer(bearer(token), ready);
    if (auth?.caller_agent === 'cto') reachingCto.push(`${label}:${auth.auth_kind}`);
  }
  assert.deepEqual(reachingCto.sort(), ['codexCto:codex', 'connector:connector', 'm365Cto:m365']);
});

test('the M365 query-string token is classified m365 through the route, and a header token keeps its own kind', async () => {
  const app = Fastify();
  app.post('/probe', async (request, reply) => {
    const auth = await requireConnectorAuth(request, reply, ready);
    if (!auth) return undefined;
    return reply.send({ auth_kind: auth.auth_kind, caller_agent: auth.caller_agent, m365_static_auth: auth.m365_static_auth });
  });
  try {
    const viaQuery = await app.inject({ method: 'POST', url: `/probe?m365_dev_token=${encodeURIComponent(TOKENS.m365Cto)}` });
    assert.equal(viaQuery.statusCode, 200);
    assert.deepEqual(viaQuery.json(), { auth_kind: 'm365', caller_agent: 'cto', m365_static_auth: true });

    const viaHeader = await app.inject({ method: 'POST', url: '/probe', headers: { authorization: bearer(TOKENS.codexCto) } });
    assert.deepEqual(viaHeader.json(), { auth_kind: 'codex', caller_agent: 'cto', m365_static_auth: false });

    const oauth = issueAccessToken('dcr_fixture', 'mcp', SIGNING_SECRET, 'https://fixture.invalid', 'cto');
    const viaOauth = await app.inject({ method: 'POST', url: '/probe', headers: { authorization: bearer(oauth) } });
    assert.deepEqual(viaOauth.json(), { auth_kind: 'oauth', caller_agent: 'cto', m365_static_auth: false });

    const rejected = await app.inject({ method: 'POST', url: `/probe?m365_dev_token=${encodeURIComponent(pad('unknown', 'u'))}` });
    assert.equal(rejected.statusCode, 401);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Descope: a verified session JWT is its own kind, so it is not mistaken for a gateway OAuth session
// ---------------------------------------------------------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'synthetic-kid-1';

function descopeJwt(claims: Record<string, unknown>): string {
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64(claims)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

test('a verified Descope session JWT is recorded as descope, and a lane outside the pilot is refused outright', async () => {
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.equal(String(url), `https://api.descope.com/${DESCOPE_PROJECT}/.well-known/jwks.json`);
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const claims = { iss: `https://api.descope.com/v1/apps/${DESCOPE_PROJECT}`, sub: 'synthetic-subject', exp };
    const auth = await validateBearer(bearer(descopeJwt({ ...claims, lane: 'cto' })), ready);
    assert.ok(auth);
    assert.equal(auth.auth_kind, 'descope');
    assert.equal(auth.caller_agent, 'cto');
    assert.equal(auth.m365_static_auth, false);

    assert.equal(await validateBearer(bearer(descopeJwt({ ...claims, lane: 'cfo' })), ready), null, 'a lane outside DESCOPE_PILOT_LANES');
    assert.equal(await validateBearer(bearer(descopeJwt({ ...claims, lane: 'cto', exp: exp - 7200 })), ready), null, 'an expired token');
  } finally {
    globalThis.fetch = realFetch;
  }
});
