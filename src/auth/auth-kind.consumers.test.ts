/**
 * Nothing but the AWS MCP bridge may depend on HOW a request authenticated.
 *
 * validateBearer records an auth kind, the OAuth grant and the client id on a request (auth_kind,
 * auth_grant, auth_subject), and server/mcp.ts puts them into the request context. They exist for one
 * consumer, the AWS MCP bridge. The kind is never defaulted to 'oauth': only a credential that proves it
 * records one, and a path that records none leaves it undefined, which the bridge refuses.
 *
 * Two proofs that no other tool changes behavior:
 *  1. A scan of the non-test source. Only the producer (auth/bearer.ts), the context plumbing
 *     (server/mcp.ts, server/request-context.ts) and the three bridge files (access, audit, tools) name
 *     these fields, and only tools/aws-mcp/tools.ts calls the accessors. A consumer added anywhere else
 *     fails this test and forces a review.
 *  2. A differential over the real MCP route. For the same lane and connector surface, tools/list and a
 *     non-bridge tool (catalog_probe, which reports the authentication context of the call) return
 *     identical results whatever the credential kind, the OAuth grant or the client id.
 *
 * Every credential is synthetic. The server listens on 127.0.0.1 only.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------------------------
// 1. Source scan
// ---------------------------------------------------------------------------------------------
const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(?:ts|mts|mjs|js)$/.test(entry) && !/\.test\.(?:ts|mts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((f) => ({ path: relative(SRC, f).replaceAll('\\', '/'), text: readFileSync(f, 'utf8') }));

/** Every non-test file that may name the authentication-kind fields, each with the reason it is legitimate. */
const AUTH_FIELD_FILES: Readonly<Record<string, string>> = Object.freeze({
  'auth/bearer.ts': 'the producer: validateBearer records the kind, the grant and the client id',
  'server/mcp.ts': 'copies the recorded fields from the AuthContext into the request context, and does nothing else with them',
  'server/request-context.ts': 'defines the fields and their accessors',
  'tools/aws-mcp/access.ts': 'the bridge access check',
  'tools/aws-mcp/audit.ts': 'the bridge audit line',
  'tools/aws-mcp/tools.ts': 'the bridge tools, the only caller of the accessors',
});

/** The only files that may call a currentAuth* accessor: the file that defines them, and the bridge. */
const ACCESSOR_FILES: Readonly<Record<string, string>> = Object.freeze({
  'server/request-context.ts': 'defines the accessors',
  'tools/aws-mcp/tools.ts': 'the bridge tools, the only consumer',
});

const AUTH_FIELD = /\b(?:currentAuthKind|currentAuthGrant|currentAuthSubject|authKind|authGrant|authSubject|auth_kind|auth_grant|auth_subject)\b/;
const ACCESSOR_CALL = /\bcurrentAuth(?:Kind|Grant|Subject)\s*\(/;

test('SCAN: only the producer, the context plumbing and the three bridge files name the authentication-kind fields', () => {
  const found = FILES.filter((f) => AUTH_FIELD.test(f.text)).map((f) => f.path).sort();
  assert.deepEqual(
    found,
    Object.keys(AUTH_FIELD_FILES).sort(),
    'A file outside the allow-list reads or names how a request authenticated. Only the AWS MCP bridge may depend on it; ' +
      'if this is deliberate, a new consumer needs a security review and an entry here.',
  );
});

test('SCAN: only the bridge tools call the currentAuth accessors, so no other tool can read the kind, the grant or the client id', () => {
  const callers = FILES.filter((f) => ACCESSOR_CALL.test(f.text)).map((f) => f.path).sort();
  assert.deepEqual(callers, Object.keys(ACCESSOR_FILES).sort());
  // The definition file only defines them. The call it matches is the declaration, not a use.
  const definitions = (FILES.find((f) => f.path === 'server/request-context.ts')?.text.match(/export function currentAuth(?:Kind|Grant|Subject)\(/g) ?? []).length;
  assert.equal(definitions, 3);
  const bridge = FILES.find((f) => f.path === 'tools/aws-mcp/tools.ts');
  assert.ok(bridge);
  assert.equal((bridge.text.match(/\bcurrentAuth(?:Kind|Grant|Subject)\(\)/g) ?? []).length, 3, 'one call per field, all inside bridgeContext()');
});

test('SCAN: mcp.ts only copies the recorded fields into the request context, and the AuthContext fields are optional', () => {
  const mcp = FILES.find((f) => f.path === 'server/mcp.ts');
  assert.ok(mcp);
  const lines = mcp.text.split('\n').filter((line) => AUTH_FIELD.test(line));
  assert.deepEqual(
    lines.map((line) => line.trim()),
    ['authKind: ctx.auth_kind,', 'authGrant: ctx.auth_grant,', 'authSubject: ctx.auth_subject,'],
  );
  const bearer = FILES.find((f) => f.path === 'auth/bearer.ts');
  assert.ok(bearer);
  for (const field of ['auth_kind', 'auth_grant', 'auth_subject']) {
    assert.match(bearer.text, new RegExp(`\\n\\s*${field}\\?: `), `${field} is optional on AuthContext`);
  }
  // The kind starts undefined and is set only where a credential proves it: it is not initialised to 'oauth'.
  assert.match(bearer.text, /let authKind: AuthKind \| undefined = issued \? 'oauth' : undefined;/);
  assert.doesNotMatch(bearer.text, /let authKind: AuthKind = 'oauth'/);
});

test('every allow-listed file still exists and still names the fields, so the lists cannot rot into a rubber stamp', () => {
  for (const path of Object.keys(AUTH_FIELD_FILES)) {
    const f = FILES.find((x) => x.path === path);
    assert.ok(f, `allow-listed file no longer exists: ${path}`);
    assert.match(f.text, AUTH_FIELD, `${path} no longer names the fields; remove its entry`);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Differential over the real route
// ---------------------------------------------------------------------------------------------
const SIGNING_SECRET = 'synthetic-signing-' + 's'.repeat(40);
const pad = (label: string, ch: string): string => `synthetic-${label}-` + ch.repeat(40);
const STATIC = {
  connector: pad('connector', 'c'),
  codexCto: pad('codex-cto', 'x'),
};

Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track-key',
  CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: STATIC.connector,
  ADMIN_REVOKE_TOKEN: pad('admin', 'a'),
  N8N_WEBHOOK_SECRET: pad('webhook', 'n'),
  CODEX_CTO_MCP_TOKEN: STATIC.codexCto,
  OAUTH_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
  // The static connector token is bound to the CTO lane, so it and the OAuth tokens below share a lane.
  OAUTH_DEFAULT_AGENT: 'cto',
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
  TOOL_CATALOG_CURATION_MODE: 'curate',
  // Nothing in this file may reach AWS: the bridge tools are listed but never called.
  AWS_MCP_BRIDGE_DISABLED: 'true',
});
delete process.env.AWS_AI_READER_ROLE_ARN;

const { default: Fastify } = await import('fastify');
const { registerMcpRoutes } = await import('../server/mcp.js');
const { issueAccessToken } = await import('./oauth-tokens.js');

const realFetch = globalThis.fetch;
const app = Fastify();
registerMcpRoutes(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

after(async () => {
  await app.close();
});

type Grant = 'authorization_code' | 'refresh_token' | 'client_credentials' | undefined;
const GRANTS: readonly Grant[] = ['authorization_code', 'refresh_token', 'client_credentials', undefined];
const mint = (clientId: string, grant: Grant): string =>
  issueAccessToken(clientId, 'mcp', SIGNING_SECRET, 'https://fixture.invalid', 'cto', 3600, grant);

interface Reply {
  status: number;
  message: unknown;
}

async function rpc(bearer: string, method: string, params: Record<string, unknown>): Promise<Reply> {
  const response = await realFetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const raw = await response.text();
  const jsonText = raw.startsWith('event:') ? (/^data: (.*)$/m.exec(raw)?.[1] ?? '') : raw;
  return { status: response.status, message: jsonText ? JSON.parse(jsonText) : null };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Drop what legitimately differs between two identical calls: ids, timestamps, uptime and the revision block. */
function scrub(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(UUID, '<uuid>').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>').replace(/"uptime_seconds": ?[\d.]+/g, '"uptime_seconds":<n>');
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'revision' || key === 'uptime_seconds' || key === 'started_at') continue;
      out[key] = scrub(inner);
    }
    return out;
  }
  return value;
}

const listTools = async (bearer: string): Promise<Reply> => rpc(bearer, 'tools/list', {});
const probe = async (bearer: string): Promise<Reply> => rpc(bearer, 'tools/call', { name: 'catalog_probe', arguments: { include_cto_workspace: true } });

function toolNames(reply: Reply): string[] {
  const tools = (reply.message as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
  return tools.map((t) => t.name);
}

test('DIFFERENTIAL: two identical calls differ only in what scrub() removes, so the comparisons below are not hiding noise', async () => {
  const token = mint('dcr_fixture', 'authorization_code');
  const [a, b] = [await probe(token), await probe(token)];
  assert.equal(a.status, 200);
  assert.deepEqual(scrub(a.message), scrub(b.message));
  const result = (a.message as { result?: { isError?: boolean; structuredContent?: { result?: { request_context?: Record<string, unknown> } } } }).result;
  assert.notEqual(result?.isError, true, JSON.stringify(a.message).slice(0, 300));
  const context = result?.structuredContent?.result?.request_context;
  assert.equal(context?.caller_agent, 'cto');
  assert.equal(context?.is_m365_static_auth, false);
  assert.equal(context?.is_connector_surface, true);
  const [la, lb] = [await listTools(token), await listTools(token)];
  assert.deepEqual(scrub(la.message), scrub(lb.message));
  assert.ok(toolNames(la).includes('catalog_probe'), 'a non-bridge tool is listed');
});

test('DIFFERENTIAL: the OAuth grant (or none) changes neither the tool list nor a non-bridge tool, for every client kind', async () => {
  for (const clientId of ['dcr_fixture', 'occ_fixture', 'synthetic-per-agent-client']) {
    const lists: unknown[] = [];
    const probes: unknown[] = [];
    for (const grant of GRANTS) {
      const token = mint(clientId, grant);
      const [list, called] = [await listTools(token), await probe(token)];
      assert.equal(list.status, 200, `${clientId} ${String(grant)}`);
      assert.equal(called.status, 200, `${clientId} ${String(grant)}`);
      lists.push(scrub(list.message));
      probes.push(scrub(called.message));
    }
    for (let i = 1; i < GRANTS.length; i += 1) {
      assert.deepEqual(lists[i], lists[0], `tools/list for ${clientId}: ${String(GRANTS[i])} differs from ${String(GRANTS[0])}`);
      assert.deepEqual(probes[i], probes[0], `catalog_probe for ${clientId}: ${String(GRANTS[i])} differs from ${String(GRANTS[0])}`);
    }
  }
});

test('DIFFERENTIAL: the client id changes neither the tool list nor a non-bridge tool when the connector surface is the same', async () => {
  // dcr_ and occ_ are both the connector surface; only the client id (the audit subject) differs.
  const results = [];
  for (const clientId of ['dcr_fixture', 'occ_fixture', 'dcr_' + 'x'.repeat(170)]) {
    const token = mint(clientId, 'authorization_code');
    results.push([scrub((await listTools(token)).message), scrub((await probe(token)).message)]);
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
});

test('DIFFERENTIAL: a static credential and an OAuth token on the same lane and surface get identical results from non-bridge tools', async () => {
  // The static connector token (kind connector) is CTO-lane, not the connector surface: the same shape as
  // a client_credentials client. The Codex seat token (kind codex) is CTO-lane on the connector surface:
  // the same shape as a DCR client. Only the recorded kind differs, and no non-bridge tool may care.
  const pairs: Array<[string, string, string]> = [
    ['connector static vs oauth per-agent client', STATIC.connector, mint('synthetic-per-agent-client', 'client_credentials')],
    ['codex static vs oauth dcr client', STATIC.codexCto, mint('dcr_fixture', 'authorization_code')],
  ].map(([label, a, b]) => [label, a, b] as [string, string, string]);
  for (const [label, staticToken, oauthToken] of pairs) {
    const [staticList, oauthList] = [await listTools(staticToken), await listTools(oauthToken)];
    assert.equal(staticList.status, 200, label);
    assert.deepEqual(scrub(staticList.message), scrub(oauthList.message), `tools/list: ${label}`);
    const [staticProbe, oauthProbe] = [await probe(staticToken), await probe(oauthToken)];
    assert.equal(staticProbe.status, 200, label);
    assert.deepEqual(scrub(staticProbe.message), scrub(oauthProbe.message), `catalog_probe: ${label}`);
  }
});

test('DIFFERENTIAL: the bridge tools are listed for the lane whatever the credential, and only they decide at call time', async () => {
  const names = new Set<string>();
  for (const token of [STATIC.connector, STATIC.codexCto, mint('dcr_fixture', 'authorization_code'), mint('dcr_fixture', 'client_credentials'), mint('dcr_fixture', undefined)]) {
    const listed = toolNames(await listTools(token));
    names.add(JSON.stringify(listed.filter((n) => n.startsWith('aws_mcp_')).sort()));
  }
  assert.equal(names.size, 1, 'every CTO credential sees the same bridge tools in the list');
  assert.deepEqual(JSON.parse([...names][0]), ['aws_mcp_tool_call', 'aws_mcp_tool_list']);
});
