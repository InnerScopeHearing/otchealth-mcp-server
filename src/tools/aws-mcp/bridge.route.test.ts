/**
 * The AWS bridge over the REAL MCP route (src/server/mcp.ts) and the real bearer authentication.
 *
 * The unit tests set the authentication kind by hand. This file proves the plumbing that produces it:
 * validateBearer records how the request authenticated, mcp.ts puts that into the request context,
 * and the bridge handler refuses anything but an OAuth session on the CTO lane.
 *
 * AWS_MCP_BRIDGE_DISABLED is set for the whole file, so no request can reach STS or the AWS MCP Server
 * whatever the gate decides. The two refusal codes tell the cases apart: an OAuth CTO session passes
 * the gate and is stopped by the kill switch (aws_mcp_disabled); a static credential is stopped by
 * the gate itself (aws_mcp_forbidden) before the kill switch is even consulted.
 *
 * The server listens on 127.0.0.1 only. Every credential is synthetic.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

const SIGNING_SECRET = 'synthetic-signing-' + 's'.repeat(40);
const pad = (label: string, ch: string): string => `synthetic-${label}-` + ch.repeat(40);
const TOKENS = {
  connector: pad('connector', 'c'),
  m365Cto: pad('m365-cto', 'm'),
  codexCto: pad('codex-cto', 'x'),
  copilot: pad('copilot', 'p'),
};

Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track-key',
  CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: TOKENS.connector,
  ADMIN_REVOKE_TOKEN: pad('admin', 'a'),
  N8N_WEBHOOK_SECRET: pad('webhook', 'n'),
  COPILOT_AGENT_TOKEN: TOKENS.copilot,
  M365_CTO_MCP_TOKEN: TOKENS.m365Cto,
  CODEX_CTO_MCP_TOKEN: TOKENS.codexCto,
  OAUTH_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
  // The connector token is bound to the CTO lane: the exposure the bridge guards against.
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
  TOOL_CATALOG_CURATION_MODE: 'off',
  // The kill switch makes it impossible for any request in this file to reach AWS.
  AWS_MCP_BRIDGE_DISABLED: 'true',
});
delete process.env.AWS_AI_READER_ROLE_ARN;

const { default: Fastify } = await import('fastify');
const { registerMcpRoutes } = await import('../../server/mcp.js');
const { issueAccessToken } = await import('../../auth/oauth-tokens.js');

const realFetch = globalThis.fetch;
const outbound: string[] = [];
// Anything that is not the loopback server is recorded, so the file can assert nothing left the machine.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('http://127.0.0.1:')) outbound.push(url);
  return realFetch(input, init);
}) as typeof fetch;

const app = Fastify();
registerMcpRoutes(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

interface Auth {
  bearer?: string;
  /** The M365 declarative-agent carrier: a query-string token with no Authorization header. */
  m365Query?: string;
}
interface Outcome {
  tool: string;
  isError: boolean;
  text: string;
  raw: string;
}

async function callTool(name: string, args: Record<string, unknown>, auth: Auth): Promise<Outcome | 'not_found'> {
  const query = auth.m365Query ? `?m365_dev_token=${encodeURIComponent(auth.m365Query)}` : '';
  const response = await realFetch(`${base}/mcp${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `HTTP ${response.status} for ${name}: ${raw.slice(0, 300)}`);
  const jsonText = raw.startsWith('event:') ? (/^data: (.*)$/m.exec(raw)?.[1] ?? '') : raw;
  const message = JSON.parse(jsonText) as {
    result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    error?: { code: number; message: string };
  };
  const text = message.result?.content?.map((c) => c.text).join('\n') ?? message.error?.message ?? '';
  if (/not found/i.test(text) && (message.error || message.result?.isError)) return 'not_found';
  return { tool: name, isError: message.result?.isError === true, text, raw };
}

/**
 * Call a bridge tool by its name, or by the short alias an M365 session registers instead of it
 * (the M365 shim strips the first word, so aws_mcp_tool_list becomes mcp_tool_list for that lane).
 */
async function callBridge(baseName: 'aws_mcp_tool_list' | 'aws_mcp_tool_call', auth: Auth): Promise<Outcome> {
  const args = baseName === 'aws_mcp_tool_call' ? { tool_name: 'aws___list_regions' } : {};
  for (const name of [baseName, baseName.replace(/^aws_/, '')]) {
    const outcome = await callTool(name, args, auth);
    if (outcome !== 'not_found') return outcome;
  }
  assert.fail(`${baseName} is not callable under any of its names for this session`);
}

const BOTH = ['aws_mcp_tool_list', 'aws_mcp_tool_call'] as const;

test('an OAuth CTO session (the claude.ai connector path) passes the access gate and is stopped only by the kill switch', async () => {
  const token = issueAccessToken('dcr_fixture', 'mcp', SIGNING_SECRET, 'https://fixture.invalid', 'cto');
  for (const tool of BOTH) {
    const outcome = await callBridge(tool, { bearer: token });
    assert.equal(outcome.isError, true, tool);
    assert.match(outcome.text, /aws_mcp_disabled: the AWS bridge is switched off by the operator/, `${tool}: ${outcome.text.slice(0, 200)}`);
    assert.doesNotMatch(outcome.text, /aws_mcp_forbidden/);
  }
});

test('an OAuth session issued to a per-agent client on the CTO lane is also an OAuth session', async () => {
  const token = issueAccessToken('synthetic-per-agent-client', 'mcp', SIGNING_SECRET, 'https://fixture.invalid', 'cto');
  const outcome = await callBridge('aws_mcp_tool_list', { bearer: token });
  assert.match(outcome.text, /aws_mcp_disabled/);
});

test('the static connector token bound to the CTO lane is refused as a connector credential', async () => {
  for (const tool of BOTH) {
    const outcome = await callBridge(tool, { bearer: TOKENS.connector });
    assert.equal(outcome.isError, true, tool);
    assert.match(outcome.text, /aws_mcp_forbidden: the AWS bridge serves OAuth-authenticated CTO sessions only/, `${tool}: ${outcome.text.slice(0, 200)}`);
    assert.match(outcome.text, /"connector" credential/);
    assert.doesNotMatch(outcome.text, /aws_mcp_disabled/);
  }
});

test('the M365 token for the CTO lane is refused as an m365 credential, from a header and from the query string it ships in', async () => {
  for (const auth of [{ bearer: TOKENS.m365Cto }, { m365Query: TOKENS.m365Cto }]) {
    for (const tool of BOTH) {
      const outcome = await callBridge(tool, auth);
      assert.equal(outcome.isError, true, `${tool} via ${Object.keys(auth)[0]}`);
      assert.match(outcome.text, /aws_mcp_forbidden: the AWS bridge serves OAuth-authenticated CTO sessions only/, `${tool}: ${outcome.text.slice(0, 200)}`);
      assert.match(outcome.text, /"m365" credential/);
      assert.doesNotMatch(outcome.text, /aws_mcp_disabled/);
    }
  }
});

test('the Codex per-seat token for the CTO lane is refused as a codex credential', async () => {
  for (const tool of BOTH) {
    const outcome = await callBridge(tool, { bearer: TOKENS.codexCto });
    assert.equal(outcome.isError, true, tool);
    assert.match(outcome.text, /aws_mcp_forbidden: the AWS bridge serves OAuth-authenticated CTO sessions only/, `${tool}: ${outcome.text.slice(0, 200)}`);
    assert.match(outcome.text, /"codex" credential/);
  }
});

test('an OAuth session on any other lane never reaches the bridge', async () => {
  const token = issueAccessToken('synthetic-per-agent-client', 'mcp', SIGNING_SECRET, 'https://fixture.invalid', 'cfo');
  for (const tool of BOTH) {
    const args = tool === 'aws_mcp_tool_call' ? { tool_name: 'aws___list_regions' } : {};
    const outcome = await callTool(tool, args, { bearer: token });
    assert.notEqual(outcome, 'not_found', 'the tool is registered for this lane, so governance is what stops it');
    if (outcome === 'not_found') continue;
    assert.equal(outcome.isError, true, tool);
    assert.match(outcome.raw, /forbidden_role/);
    assert.doesNotMatch(outcome.text, /aws_mcp_disabled/);
  }
});

test('a request with no credential, or with an unknown one, never reaches a tool', async () => {
  for (const auth of [{}, { bearer: pad('unknown', 'u') }]) {
    const response = await realFetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aws_mcp_tool_list', arguments: {} } }),
    });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
});

test('nothing in this file reached the network beyond the loopback server', () => {
  assert.deepEqual(outbound, []);
});
