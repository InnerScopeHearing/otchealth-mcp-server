import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const CTO_TOKEN = `synthetic-fixed-profile-cto-${'c'.repeat(40)}`;
const COO_TOKEN = `synthetic-fixed-profile-coo-${'o'.repeat(40)}`;
const DEVELOPER_TOKEN = `synthetic-fixed-profile-developer-${'d'.repeat(40)}`;

let app: import('fastify').FastifyInstance;

type ListedMcpTool = {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
};

before(async () => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'p'.repeat(40),
    ADMIN_REVOKE_TOKEN: 'r'.repeat(40),
    N8N_WEBHOOK_SECRET: 'n'.repeat(40),
    NODE_ENV: 'test',
    REVOCATION_MEMORY_ONLY_MODE: 'development',
    READ_ONLY_MODE: 'false',
    ENABLE_WRITE_TOOLS: 'true',
    DRY_RUN_DEFAULT: 'true',
    OAUTH_TOKEN_SIGNING_SECRET: 's'.repeat(48),
    OAUTH_DEFAULT_AGENT: 'cto',
    CODEX_CTO_MCP_TOKEN: CTO_TOKEN,
    CODEX_COO_MCP_TOKEN: COO_TOKEN,
    CODEX_DEVELOPER_MCP_TOKEN: DEVELOPER_TOKEN,
  };
  for (const [key, value] of Object.entries(required)) process.env[key] = value;
  delete process.env.TOOL_CATALOG_CURATION_MODE;
  delete process.env.TOOL_CATALOG_CURATE_LANES;

  const { loadRevocations } = await import('../auth/revocation-store.js');
  await loadRevocations();

  const { default: Fastify } = await import('fastify');
  const { registerMcpRoutes } = await import('./mcp.js');
  app = Fastify({ logger: false });
  registerMcpRoutes(app);
  await app.ready();
});

after(async () => {
  await app?.close();
});

function rpc(method: string, id: number, params?: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

async function postMcp(
  url: string,
  token: string,
  payload: Record<string, unknown>,
  taskClass?: string,
) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      ...(taskClass ? { 'x-otc-task-class': taskClass } : {}),
    },
    payload,
  });
}

async function initialize(url: string, token: string, taskClass?: string) {
  return postMcp(
    url,
    token,
    rpc('initialize', 1, {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'fixed-profile-test', version: '1' },
    }),
    taskClass,
  );
}

async function listTools(url: string, token: string, taskClass?: string) {
  const response = await postMcp(url, token, rpc('tools/list', 2), taskClass);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { result?: { tools?: ListedMcpTool[] }; error?: unknown };
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result?.tools ?? [];
}

test('fixed read-only endpoint binds its profile on initialize and tools/list, ignoring task-class headers', async () => {
  const url = '/mcp/profile/read-only';
  const initialized = await initialize(url, CTO_TOKEN, 'engineering');
  assert.equal(initialized.statusCode, 200, initialized.body);
  assert.ok(initialized.json().result?.protocolVersion);

  const tools = await listTools(url, CTO_TOKEN, 'engineering');
  const names = new Set(tools.map((tool) => tool.name));
  assert.equal(
    tools.length,
    13,
    'the CTO baseline profile exposes only the existing 13-tool read-only baseline',
  );
  assert.ok(names.has('brain_search'));
  assert.ok(!names.has('github_create_branch'), 'the URL profile stays read-only despite an engineering header');
  assert.ok(!names.has('memory_write'), 'the fixed profile narrows the authenticated CTO connector surface');
});

test('fixed engineering endpoint uses the URL profile, preserves seat-specific filters, and rejects direct calls to hidden tools', async () => {
  const url = '/mcp/profile/engineering';
  const initialized = await initialize(url, CTO_TOKEN, 'read_only');
  assert.equal(initialized.statusCode, 200, initialized.body);

  const ctoTools = await listTools(url, CTO_TOKEN, 'read_only');
  const ctoNames = new Set(ctoTools.map((tool) => tool.name));
  assert.equal(
    ctoTools.length,
    31,
    'the eligible engineering profile is the 13-tool baseline plus 18 GitHub tools',
  );
  assert.ok(
    ctoNames.has('github_create_branch'),
    'CTO retains an engineering tool even when a conflicting task-class header is present',
  );
  assert.ok(!ctoNames.has('github_merge_pull_request'), 'the fixed engineering profile does not advertise merge');
  assert.ok(!ctoNames.has('memory_write'), 'the fixed engineering profile cannot broaden the CTO connector surface');
  assert.ok(ctoTools.length <= 40, `bounded profile returned ${ctoTools.length} tools`);

  const branchTool = ctoTools.find((tool) => tool.name === 'github_create_branch');
  assert.ok(branchTool, 'the profile exposes its confirmed engineering write tool');
  assert.ok(Object.hasOwn(branchTool.inputSchema?.properties ?? {}, 'dry_run'));
  assert.ok(Object.hasOwn(branchTool.inputSchema?.properties ?? {}, 'acknowledge_warning'));

  const branchPreview = await postMcp(
    url,
    CTO_TOKEN,
    rpc('tools/call', 4, {
      name: 'github_create_branch',
      arguments: {
        owner: 'InnerScopeHearing',
        repo: 'otchealth-mcp-server',
        branch: 'fixed-profile-preview-only',
        dry_run: true,
        acknowledge_warning: true,
      },
    }),
    'read_only',
  );
  assert.equal(branchPreview.statusCode, 200, branchPreview.body);
  assert.match(branchPreview.body, /"executed":false/);
  assert.match(branchPreview.body, /"dry_run":true/);

  const hiddenCall = await postMcp(
    url,
    CTO_TOKEN,
    rpc('tools/call', 3, { name: 'github_merge_pull_request', arguments: { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', number: 1 } }),
    'engineering',
  );
  assert.equal(hiddenCall.statusCode, 200, hiddenCall.body);
  assert.match(hiddenCall.body, /not found|unknown tool/i, 'a direct call cannot bypass the profile list');

  const cooTools = await listTools(url, COO_TOKEN, 'engineering');
  const cooNames = new Set(cooTools.map((tool) => tool.name));
  assert.ok(cooNames.has('brain_search'));
  assert.ok(
    !cooNames.has('github_create_branch'),
    'the profile does not replace the authenticated COO connector allowlist',
  );
  const cooHiddenCall = await postMcp(
    url,
    COO_TOKEN,
    rpc('tools/call', 6, {
      name: 'github_create_branch',
      arguments: { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', branch: 'coo-must-not-call' },
    }),
  );
  assert.match(cooHiddenCall.body, /not found|unknown tool/i);

  const developerTools = await listTools(url, DEVELOPER_TOKEN, 'read_only');
  const developerNames = new Set(developerTools.map((tool) => tool.name));
  assert.ok(developerNames.has('github_create_branch'));

  const developerBranchCall = rpc('tools/call', 5, {
    name: 'github_create_branch',
    arguments: {
      owner: 'InnerScopeHearing',
      repo: 'otchealth-mcp-server',
      branch: 'developer-profile-authorization-check',
      dry_run: true,
      acknowledge_warning: true,
    },
  });
  const developerProfilePreview = await postMcp(url, DEVELOPER_TOKEN, developerBranchCall);
  const developerNormalPreview = await postMcp('/mcp', DEVELOPER_TOKEN, developerBranchCall);
  assert.equal(developerProfilePreview.statusCode, 200, developerProfilePreview.body);
  assert.equal(developerNormalPreview.statusCode, 200, developerNormalPreview.body);
  const profileResult = developerProfilePreview.json().result?.structuredContent?.result;
  const normalResult = developerNormalPreview.json().result?.structuredContent?.result;
  assert.deepEqual(profileResult, normalResult, 'the selected profile must leave handler behavior unchanged');
  assert.deepEqual(profileResult, {
    executed: false,
    dry_run: true,
    branch: 'developer-profile-authorization-check',
  });
});

test('/mcp remains unchanged and ignores task-class headers, and fixed endpoints still require authentication', async () => {
  const normalTools = await listTools('/mcp', CTO_TOKEN, 'read_only');
  assert.ok(normalTools.some((tool) => tool.name === 'memory_write'), 'the existing authenticated CTO connector view is unchanged');

  const unauthenticated = await app.inject({
    method: 'POST',
    url: '/mcp/profile/read-only',
    payload: rpc('initialize', 4, {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'fixed-profile-test', version: '1' },
    }),
  });
  assert.equal(unauthenticated.statusCode, 401);

  const unknown = await app.inject({
    method: 'POST',
    url: '/mcp/profile/not-a-profile',
    payload: rpc('tools/list', 5),
  });
  assert.equal(unknown.statusCode, 404);

  const get = await app.inject({ method: 'GET', url: '/mcp/profile/engineering' });
  assert.equal(get.statusCode, 405);
});
