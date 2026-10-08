/**
 * An accepted claude.ai connector session, END TO END: the real OAuth endpoints (server/oauth.ts) mint the
 * tokens, the real MCP route (server/mcp.ts) authenticates them, and the real bridge handlers (tools.ts)
 * serve or refuse the call. Only the network is faked: a fake STS and a fake AWS MCP Server answer in place
 * of AWS, and any other outbound request is recorded and refused. The kill switch is OFF in this file.
 * bridge.route.test.ts runs the same route with the switch ON and tokens minted by hand.
 *
 * What this file proves:
 *  - A claude.ai DCR session elevated to the CTO lane through the consent screen (authorization_code
 *    grant) is served by both bridge tools, and so is its refresh_token successor.
 *  - A confidential connector client that signs in through authorization_code is served the same way.
 *  - A client_credentials token for the same CTO lane (the machine credential) is refused with
 *    aws_mcp_grant_refused, causes no STS or AWS request, and cannot be upgraded by editing its claims.
 *  - A token that records no grant (minted before grant tracking) is refused, with advice to reconnect.
 *
 * LIMIT, stated plainly: GET /oauth/authorize issues a confidential client's code with no consent screen,
 * so the holder of such a client's secret can also run the authorization_code grant without a browser.
 * The grant check closes the direct machine path (client_credentials) and untracked tokens. It is a
 * statement about how a token was issued, not proof that a person was at a keyboard.
 *
 * The server listens on 127.0.0.1 only. Every credential is synthetic.
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const SIGNING_SECRET = 'synthetic-signing-' + 's'.repeat(40);
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const ACCOUNT = '111122223333';
const READER_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/otchealth-ai-reader-role`;
// Key-shaped literals are assembled so no source line looks like a credential.
const BASE_CREDS = {
  accessKeyId: 'ASIA' + 'SYNTHETICBASE002',
  secretAccessKey: 'synthetic-base-secret-not-real',
  sessionToken: 'synthetic-base-session-token',
};
const READER_CREDS = {
  accessKeyId: 'ASIA' + 'SYNTHETICRD' + '00001',
  secretAccessKey: 'synthetic-reader-secret-1',
  sessionToken: 'synthetic-reader-session-token-1',
};
/** A confidential connector client (the occ_ kind a claude.ai connector can be given in its advanced settings). */
const CONNECTOR_CLIENT = { client_id: 'occ_fixture', secret: 'synthetic-occ-secret-' + 'o'.repeat(32), agent: 'cto' };
/** A confidential per-agent client used by a machine (the Hyperagent kind) on the CTO lane. */
const MACHINE_CLIENT = { client_id: 'machine-fixture', secret: 'synthetic-machine-secret-' + 'm'.repeat(32), agent: 'cto' };

Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track-key',
  CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-connector-' + 'c'.repeat(40),
  ADMIN_REVOKE_TOKEN: 'synthetic-admin-' + 'a'.repeat(40),
  N8N_WEBHOOK_SECRET: 'synthetic-webhook-' + 'n'.repeat(40),
  OAUTH_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
  OAUTH_CLIENTS: JSON.stringify([CONNECTOR_CLIENT, MACHINE_CLIENT]),
  REVOCATION_MEMORY_ONLY_MODE: 'development',
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  READ_ONLY_MODE: 'true',
  ENABLE_WRITE_TOOLS: 'false',
  ENABLE_HIGH_RISK_TOOLS: 'false',
  DRY_RUN_DEFAULT: 'true',
  COLD_START_MODE: 'off',
  SHIELD_MODE: 'off',
  GROUNDEDNESS_MODE: 'off',
  AUTO_JOURNAL_MODE: 'off',
  TOOL_CATALOG_CURATION_MODE: 'off',
  // The base (task role) credentials the gateway signs its STS calls with.
  AWS_ACCESS_KEY_ID: BASE_CREDS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: BASE_CREDS.secretAccessKey,
  AWS_SESSION_TOKEN: BASE_CREDS.sessionToken,
});
// The kill switch is off for this whole file: an accepted session must actually be served.
delete process.env.AWS_MCP_BRIDGE_DISABLED;
delete process.env.AWS_AI_READER_ROLE_ARN;
delete process.env.AWS_MCP_SIGNING_SERVICE;

const { default: Fastify } = await import('fastify');
const { registerMcpRoutes } = await import('../../server/mcp.js');
const { registerOAuthRoutes, issuedAgent, issuedGrantType } = await import('../../server/oauth.js');
const { issueAccessToken } = await import('../../auth/oauth-tokens.js');
const { mintSetupCode } = await import('../../auth/setup-codes.js');
const { logger } = await import('../../audit/logger.js');
const { AWS_MCP_ENDPOINT } = await import('./signed-fetch.js');

// ---------------------------------------------------------------------------------------------
// The fake network. Loopback goes to the real server; STS and the AWS MCP Server are answered here;
// anything else is recorded and refused.
// ---------------------------------------------------------------------------------------------
interface StsRequest {
  action: string;
  roleArn: string | undefined;
  authorization: string;
}
interface McpRequest {
  method: string;
  rpcMethod: string | undefined;
  toolName: string | undefined;
  authorization: string;
  securityToken: string;
}
const stsRequests: StsRequest[] = [];
const mcpRequests: McpRequest[] = [];
const outbound: string[] = [];

const FAKE_TOOLS = [
  { name: 'aws___list_regions', description: 'Lists AWS regions.', inputSchema: { type: 'object', properties: {} } },
  { name: 'aws___search_documentation', description: 'Searches AWS documentation.', inputSchema: { type: 'object', properties: { search_phrase: { type: 'string' } } } },
  { name: 'aws___get_presigned_url', description: 'Creates a presigned URL.', inputSchema: { type: 'object', properties: {} } },
];
const FAKE_REGIONS_TEXT = 'fake regions: us-east-1, us-east-2';

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } });
}

function fakeSts(init: RequestInit | undefined): Response {
  const params = new URLSearchParams(String(init?.body ?? ''));
  const action = params.get('Action') ?? '';
  const headers = (init?.headers ?? {}) as Record<string, string>;
  stsRequests.push({ action, roleArn: params.get('RoleArn') ?? undefined, authorization: headers.Authorization ?? '' });
  if (action === 'GetCallerIdentity') {
    return xml(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`);
  }
  if (action === 'AssumeRole') {
    return xml(
      `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${READER_CREDS.accessKeyId}</AccessKeyId>` +
        `<SecretAccessKey>${READER_CREDS.secretAccessKey}</SecretAccessKey><SessionToken>${READER_CREDS.sessionToken}</SessionToken>` +
        `<Expiration>${new Date(Date.now() + 3_600_000).toISOString()}</Expiration></Credentials><AssumedRoleUser>` +
        `<Arn>arn:aws:sts::${ACCOUNT}:assumed-role/otchealth-ai-reader-role/gw-cto-fixture</Arn></AssumedRoleUser></AssumeRoleResult></AssumeRoleResponse>`,
    );
  }
  return new Response('unexpected STS action', { status: 400 });
}

function fakeAwsMcp(init: RequestInit | undefined): Response {
  const method = String(init?.method ?? 'GET');
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const rpc =
    typeof init?.body === 'string'
      ? (JSON.parse(init.body) as { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown> })
      : undefined;
  mcpRequests.push({
    method,
    rpcMethod: rpc?.method,
    toolName: typeof rpc?.params?.name === 'string' ? rpc.params.name : undefined,
    authorization: headers.Authorization ?? '',
    securityToken: headers['x-amz-security-token'] ?? '',
  });
  if (method === 'DELETE') return new Response(null, { status: 200 });
  if (method !== 'POST' || !rpc) return new Response(null, { status: 405 });
  const reply = (result: unknown, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json', ...extra },
    });
  switch (rpc.method) {
    case 'initialize':
      return reply(
        { protocolVersion: (rpc.params as { protocolVersion: string }).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-aws-mcp', version: '0.0.0' } },
        { 'mcp-session-id': 'sess-oauth-e2e' },
      );
    case 'notifications/initialized':
      return new Response(null, { status: 202 });
    case 'tools/list':
      return reply({ tools: FAKE_TOOLS });
    case 'tools/call':
      return reply({ content: [{ type: 'text', text: FAKE_REGIONS_TEXT }] });
    default:
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
  if (url.startsWith('https://sts.us-east-1.amazonaws.com/')) return fakeSts(init);
  if (url === AWS_MCP_ENDPOINT) return fakeAwsMcp(init);
  outbound.push(url);
  throw new Error('unexpected outbound request in a hermetic test');
}) as typeof fetch;

// The audit line of every bridge call, captured from the gateway logger.
const auditLines: Array<Record<string, unknown>> = [];
for (const level of ['info', 'warn'] as const) {
  mock.method(logger, level, (...args: unknown[]) => {
    const [first] = args;
    if (typeof first === 'object' && first !== null && (first as { type?: unknown }).type === 'aws_mcp_bridge_call') {
      auditLines.push(first as Record<string, unknown>);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The gateway under test: real OAuth routes and the real MCP route on one server.
// ---------------------------------------------------------------------------------------------
interface FakeCacheRow {
  doc: Record<string, unknown>;
  etag: string;
}

/** A shared fake `cache` store with real ETag compare-and-set semantics, for the consent screen and the setup codes. */
function fakeConsentStack(): {
  consent: import('../../server/oauth-consent.js').OAuthConsentDeps;
  setupCode: import('../../auth/setup-codes.js').SetupCodeDeps;
} {
  const store = new Map<string, FakeCacheRow>();
  let etagSeq = 0;
  const create = (async (_coll: string, pk: string, doc: Record<string, unknown>) => {
    const id = String(doc.id);
    if (pk !== id) throw new Error('pk must equal doc id');
    if (store.has(id)) throw new Error('duplicate id');
    const etag = `E${++etagSeq}`;
    store.set(id, { doc, etag });
    return { status: 201, ok: true, body: doc, etag };
  }) as import('../../auth/setup-codes.js').SetupCodeDeps['create'];
  const read = (async (_coll: string, pk: string, id: string) => {
    if (pk !== id) throw new Error('pk must equal id');
    const row = store.get(id);
    return row ? { doc: row.doc, etag: row.etag } : null;
  }) as import('../../auth/setup-codes.js').SetupCodeDeps['read'];
  const replace = (async (_coll: string, pk: string, id: string, doc: Record<string, unknown>, ifMatch?: string) => {
    if (pk !== id) throw new Error('pk must equal id');
    const current = store.get(id);
    if (!current) return { status: 404, ok: false, body: null, etag: null };
    if (ifMatch !== undefined && current.etag !== ifMatch) return { status: 412, ok: false, body: null, etag: null };
    const etag = `E${++etagSeq}`;
    store.set(id, { doc, etag });
    return { status: 200, ok: true, body: doc, etag };
  }) as import('../../auth/setup-codes.js').SetupCodeDeps['replace'];
  const del = (async (_coll: string, pk: string, id: string) => {
    if (pk !== id) throw new Error('pk must equal id');
    const existed = store.delete(id);
    return { status: existed ? 204 : 404, ok: existed, body: null, etag: null };
  }) as import('../../server/oauth-consent.js').OAuthConsentDeps['delete'];
  return {
    consent: { now: () => Date.now(), randomBytesImpl: randomBytes, create, read, replace, delete: del, configured: () => true },
    setupCode: { now: () => Date.now(), randomBytesImpl: randomBytes, create, read, replace, configured: () => true },
  };
}

const stack = fakeConsentStack();
const app = Fastify();
// server/index.ts registers this parser globally so the token and consent endpoints can read form bodies.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
  done(null, body);
});
registerOAuthRoutes(app, { consent: stack.consent, setupCode: stack.setupCode });
registerMcpRoutes(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

after(async () => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
  await app.close();
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const enc = encodeURIComponent;

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const tokenRequest = (fields: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/oauth/token', headers: FORM, payload: new URLSearchParams(fields).toString() });

interface Session {
  clientId: string;
  access: string;
  refresh: string;
}

function sessionFrom(clientId: string, response: { statusCode: number; payload: string; json: () => unknown }): Session {
  assert.equal(response.statusCode, 200, response.payload.slice(0, 200));
  const body = response.json() as { access_token: string; refresh_token: string };
  assert.ok(body.access_token && body.refresh_token, 'an interactive sign-in returns an access token and a refresh token');
  return { clientId, access: body.access_token, refresh: body.refresh_token };
}

/** What claude.ai does with a URL-only connector: register, sign in on the consent screen with the owner's setup code, exchange the code. */
async function signInThroughConsentScreen(): Promise<Session> {
  const registered = await app.inject({
    method: 'POST',
    url: '/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: 'Claude' }),
  });
  assert.equal(registered.statusCode, 201);
  const clientId = (registered.json() as { client_id: string }).client_id;
  assert.ok(clientId.startsWith('dcr_'), 'a self-registered public client');

  const minted = await mintSetupCode({ role: 'cto', createdBy: 'cto' }, stack.setupCode);
  const { verifier, challenge } = pkcePair();
  const authorize = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?client_id=${enc(clientId)}&redirect_uri=${enc(CLAUDE_CALLBACK)}&response_type=code` +
      `&state=fixture-state&code_challenge=${challenge}&code_challenge_method=S256`,
  });
  assert.equal(authorize.statusCode, 200, 'a public client is shown the consent screen, not issued a code');
  const pendingId = /name="pending_id" value="([a-f0-9]{32})"/.exec(authorize.payload)?.[1];
  assert.ok(pendingId, 'the consent screen carries a pending id');

  const consent = await app.inject({
    method: 'POST',
    url: '/oauth/authorize/consent',
    headers: FORM,
    payload: new URLSearchParams({ pending_id: pendingId, action: 'elevate', code: minted.code }).toString(),
  });
  assert.equal(consent.statusCode, 302, consent.payload.slice(0, 200));
  const code = new URL(String(consent.headers.location)).searchParams.get('code');
  assert.ok(code, 'the redirect to claude.ai carries an authorization code');

  return sessionFrom(clientId, await tokenRequest({ grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier }));
}

/** A confidential client signing in with authorization_code: its code is issued with no consent screen. */
async function signInConfidential(client: { client_id: string; secret: string }): Promise<Session> {
  const { verifier, challenge } = pkcePair();
  const authorize = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?client_id=${enc(client.client_id)}&redirect_uri=${enc(CLAUDE_CALLBACK)}&response_type=code` +
      `&state=fixture-state&code_challenge=${challenge}&code_challenge_method=S256`,
  });
  assert.equal(authorize.statusCode, 302);
  const code = new URL(String(authorize.headers.location)).searchParams.get('code');
  assert.ok(code);
  return sessionFrom(
    client.client_id,
    await tokenRequest({ grant_type: 'authorization_code', code, client_id: client.client_id, client_secret: client.secret, code_verifier: verifier }),
  );
}

/** The machine path: client id plus secret, no sign-in. Returns the raw token response. */
const clientCredentials = (client: { client_id: string; secret: string }) =>
  tokenRequest({ grant_type: 'client_credentials', client_id: client.client_id, client_secret: client.secret });

// Sessions are created once and shared, in test order.
let dcrSession: Promise<Session> | undefined;
const getDcrSession = (): Promise<Session> => (dcrSession ??= signInThroughConsentScreen());

interface Outcome {
  status: number;
  isError: boolean;
  text: string;
  /** structuredContent.result of a successful or failed tool call. */
  structured: Record<string, unknown> | undefined;
}

async function mcpCall(bearer: string, name: string, args: Record<string, unknown>): Promise<Outcome> {
  const response = await realFetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.text();
  if (response.status !== 200) return { status: response.status, isError: true, text: raw, structured: undefined };
  const jsonText = raw.startsWith('event:') ? (/^data: (.*)$/m.exec(raw)?.[1] ?? '') : raw;
  const message = JSON.parse(jsonText) as {
    result?: { isError?: boolean; content?: Array<{ type: string; text: string }>; structuredContent?: { result?: Record<string, unknown> } };
    error?: { code: number; message: string };
  };
  const text = message.result?.content?.map((c) => c.text).join('\n') ?? message.error?.message ?? '';
  return { status: 200, isError: message.result?.isError === true || message.error !== undefined, text, structured: message.result?.structuredContent?.result };
}

const callList = (bearer: string): Promise<Outcome> => mcpCall(bearer, 'aws_mcp_tool_list', {});
const callRegions = (bearer: string): Promise<Outcome> => mcpCall(bearer, 'aws_mcp_tool_call', { tool_name: 'aws___list_regions' });

const counts = (): { sts: number; mcp: number } => ({ sts: stsRequests.length, mcp: mcpRequests.length });

function assertServed(outcome: Outcome, label: string): void {
  assert.equal(outcome.status, 200, label);
  assert.equal(outcome.isError, false, `${label}: ${outcome.text.slice(0, 300)}`);
}

function assertListed(outcome: Outcome): void {
  const listed = outcome.structured as { tool_count: number; tools: Array<{ name: string; bridge_status: string }>; bridge: { reader_role_arn: string } };
  assert.equal(listed.tool_count, FAKE_TOOLS.length);
  const status = (name: string): string | undefined => listed.tools.find((t) => t.name === name)?.bridge_status;
  assert.equal(status('aws___list_regions'), 'allowed');
  assert.equal(status('aws___get_presigned_url'), 'blocked');
  assert.equal(listed.bridge.reader_role_arn, READER_ROLE_ARN);
}

function assertCalled(outcome: Outcome): void {
  const called = outcome.structured as { upstream_tool: string; is_error: boolean; content_text: string; reader_role_arn: string };
  assert.equal(called.upstream_tool, 'aws___list_regions');
  assert.equal(called.is_error, false);
  assert.equal(called.content_text, FAKE_REGIONS_TEXT);
  assert.equal(called.reader_role_arn, READER_ROLE_ARN);
}

/** The audit lines written since `from`, for one bridge tool. */
const auditSince = (from: number, tool: string): Array<Record<string, unknown>> =>
  auditLines.slice(from).filter((line) => line.bridge_tool === tool);

/** An accepted call writes one audit line recording OAuth and the grant it came from. */
function assertAudited(from: number, tool: string, grant: string): void {
  const lines = auditSince(from, tool);
  assert.equal(lines.length, 1, `one audit line for ${tool}`);
  assert.equal(lines[0].outcome, 'ok');
  assert.equal(lines[0].auth_kind, 'oauth');
  assert.equal(lines[0].auth_grant, grant);
}

/** A refused call is stopped before any AWS request: the counters do not move, and the audit line records the refusal. */
async function assertRefusedBeforeAws(bearer: string, label: string, pattern: RegExp, grant: string): Promise<void> {
  for (const [tool, call] of [
    ['aws_mcp_tool_list', callList],
    ['aws_mcp_tool_call', callRegions],
  ] as const) {
    const before = counts();
    const auditFrom = auditLines.length;
    const outcome = await call(bearer);
    assert.equal(outcome.status, 200, `${label} ${tool}`);
    assert.equal(outcome.isError, true, `${label} ${tool}`);
    assert.match(outcome.text, pattern, `${label} ${tool}: ${outcome.text.slice(0, 300)}`);
    assert.doesNotMatch(outcome.text, /aws_mcp_disabled|aws_mcp_forbidden/, `${label} ${tool}: refused by the grant check`);
    assert.deepEqual(counts(), before, `${label} ${tool}: no STS or AWS request was made`);
    const lines = auditSince(auditFrom, tool);
    assert.equal(lines.length, 1, `${label} ${tool}: one audit line`);
    assert.equal(lines[0].outcome, 'refused');
    assert.equal(lines[0].error_code, 'aws_mcp_grant_refused');
    assert.equal(lines[0].auth_kind, 'oauth');
    assert.equal(lines[0].auth_grant, grant);
  }
}

const MACHINE_REFUSAL = /aws_mcp_grant_refused: the AWS bridge serves interactive OAuth sessions only .* issued by the client_credentials grant, which is a machine credential/;

// ---------------------------------------------------------------------------------------------
// Tests, in order: the accepted sessions first (they also warm the credential cache, so a wrongly
// accepted token could not hide behind a cold cache), then the refused ones.
// ---------------------------------------------------------------------------------------------
test('a claude.ai session signed in on the consent screen (authorization_code, elevated to the CTO lane) is served by both bridge tools', async () => {
  const session = await getDcrSession();
  assert.equal(issuedGrantType(session.access), 'authorization_code', 'the token endpoint stamped the grant');
  assert.equal(issuedAgent(session.access), 'cto');

  const listFrom = auditLines.length;
  const list = await callList(session.access);
  assertServed(list, 'aws_mcp_tool_list');
  assertListed(list);
  assertAudited(listFrom, 'aws_mcp_tool_list', 'authorization_code');

  const callFrom = auditLines.length;
  const call = await callRegions(session.access);
  assertServed(call, 'aws_mcp_tool_call');
  assertCalled(call);
  assertAudited(callFrom, 'aws_mcp_tool_call', 'authorization_code');
});

test('the gateway reached AWS as the pinned reader role, signed with the reader credentials and never the task role credentials', () => {
  assert.deepEqual(
    stsRequests.map((r) => r.action),
    ['GetCallerIdentity', 'AssumeRole'],
    'one identity lookup and one role assumption, then the credentials were cached',
  );
  const assume = stsRequests.find((r) => r.action === 'AssumeRole');
  assert.equal(assume?.roleArn, READER_ROLE_ARN);
  for (const sts of stsRequests) assert.ok(sts.authorization.includes(`Credential=${BASE_CREDS.accessKeyId}/`), 'STS is signed with the base credentials');

  assert.ok(mcpRequests.some((r) => r.rpcMethod === 'tools/list'));
  assert.ok(mcpRequests.some((r) => r.rpcMethod === 'tools/call' && r.toolName === 'aws___list_regions'));
  for (const request of mcpRequests) {
    assert.ok(request.authorization.includes(`Credential=${READER_CREDS.accessKeyId}/`), 'the AWS MCP Server is called with the reader credentials');
    assert.equal(request.securityToken, READER_CREDS.sessionToken);
    assert.notEqual(request.securityToken, BASE_CREDS.sessionToken);
  }
});

test('the refresh_token successor of that session is served too, and stays on the CTO lane', async () => {
  const session = await getDcrSession();
  const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refresh });
  assert.equal(refreshed.statusCode, 200, refreshed.payload.slice(0, 200));
  const access = (refreshed.json() as { access_token: string }).access_token;
  assert.equal(issuedGrantType(access), 'refresh_token', 'the token endpoint stamped the refresh grant');
  assert.equal(issuedAgent(access), 'cto', 'a refresh keeps the elevated lane');

  const listFrom = auditLines.length;
  const list = await callList(access);
  assertServed(list, 'aws_mcp_tool_list');
  assertListed(list);
  assertAudited(listFrom, 'aws_mcp_tool_list', 'refresh_token');

  const callFrom = auditLines.length;
  const call = await callRegions(access);
  assertServed(call, 'aws_mcp_tool_call');
  assertCalled(call);
  assertAudited(callFrom, 'aws_mcp_tool_call', 'refresh_token');
});

test('a confidential connector client that signs in with authorization_code is served, and so is its refresh', async () => {
  const session = await signInConfidential(CONNECTOR_CLIENT);
  assert.equal(issuedGrantType(session.access), 'authorization_code');
  assert.equal(issuedAgent(session.access), 'cto');
  assertServed(await callList(session.access), 'aws_mcp_tool_list');
  assertServed(await callRegions(session.access), 'aws_mcp_tool_call');

  const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refresh, client_id: session.clientId, client_secret: CONNECTOR_CLIENT.secret });
  assert.equal(refreshed.statusCode, 200, refreshed.payload.slice(0, 200));
  const access = (refreshed.json() as { access_token: string }).access_token;
  assert.equal(issuedGrantType(access), 'refresh_token');
  assertServed(await callList(access), 'aws_mcp_tool_list');
});

test('a client_credentials token for the CTO lane is refused as a machine credential, with no STS or AWS request', async () => {
  for (const client of [MACHINE_CLIENT, CONNECTOR_CLIENT]) {
    const response = await clientCredentials(client);
    assert.equal(response.statusCode, 200, response.payload.slice(0, 200));
    const body = response.json() as { access_token: string; refresh_token?: string };
    assert.equal(body.refresh_token, undefined, 'a machine credential is never given a refresh token, so no refresh_token grant can descend from it');
    assert.equal(issuedGrantType(body.access_token), 'client_credentials', 'the token endpoint stamped the grant');
    assert.equal(issuedAgent(body.access_token), 'cto', 'it is a CTO-lane token, which is exactly what the grant check exists to stop');
    await assertRefusedBeforeAws(body.access_token, client.client_id, MACHINE_REFUSAL, 'client_credentials');
  }
});

test('a claude.ai DCR client cannot obtain a client_credentials token at all', async () => {
  const session = await getDcrSession();
  const response = await clientCredentials({ client_id: session.clientId, secret: '' });
  assert.equal(response.statusCode, 401);
  assert.equal((response.json() as { error: string }).error, 'invalid_client');
});

test('editing the grant claim of a client_credentials token does not upgrade it: the signature no longer matches', async () => {
  const response = await clientCredentials(MACHINE_CLIENT);
  const machine = (response.json() as { access_token: string }).access_token;
  const [header, payload, signature] = machine.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.equal(claims.gty, 'client_credentials');
  const forged = [header, Buffer.from(JSON.stringify({ ...claims, gty: 'authorization_code' })).toString('base64url'), signature].join('.');

  const before = counts();
  const outcome = await callList(forged);
  assert.equal(outcome.status, 401, 'the forged token is not authenticated at all');
  assert.deepEqual(counts(), before);
});

test('a token that records no grant (minted before grant tracking) is refused, with advice to reconnect', async () => {
  const session = await getDcrSession();
  const legacy = issueAccessToken(session.clientId, 'mcp', SIGNING_SECRET, 'https://fixture.invalid', 'cto', 3600);
  assert.equal(issuedGrantType(legacy), null, 'no grant is recorded');
  await assertRefusedBeforeAws(legacy, 'legacy', /aws_mcp_grant_refused: .* does not record how it was issued.*reconnect the connector to get a fresh one/, 'none');
});

test('nothing in this file reached the network beyond the loopback server and the two fakes', () => {
  assert.deepEqual(outbound, []);
  assert.ok(stsRequests.every((r) => r.action === 'GetCallerIdentity' || r.action === 'AssumeRole'));
});
