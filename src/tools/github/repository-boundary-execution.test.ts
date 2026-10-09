import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { GITHUB_REPOSITORY_WRITE_TOOLS } from '../../config/github-operator.js';
import { requestContext } from '../../server/request-context.js';
import { registerTool } from '../registry.js';

type RegisteredHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const syntheticEnvironment: Record<string, string> = {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track-key',
  CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: `synthetic-${'a'.repeat(40)}`,
  ADMIN_REVOKE_TOKEN: `synthetic-${'b'.repeat(40)}`,
  N8N_WEBHOOK_SECRET: `synthetic-${'c'.repeat(40)}`,
  READ_ONLY_MODE: 'false',
  ENABLE_WRITE_TOOLS: 'true',
  ENABLE_HIGH_RISK_TOOLS: 'true',
  DRY_RUN_DEFAULT: 'true',
  SHIELD_MODE: 'off',
  COLD_START_MODE: 'off',
  TOOL_CATALOG_CURATION_MODE: 'off',
};
const previousEnvironment = Object.fromEntries(
  Object.keys(syntheticEnvironment).map((key) => [key, process.env[key]]),
);

before(() => Object.assign(process.env, syntheticEnvironment));
after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function captureBoundaryHandler(toolName: string, canonicalName = toolName): {
  handler: RegisteredHandler;
  handlerCalls: () => number;
} {
  let registered: RegisteredHandler | undefined;
  let calls = 0;
  const server = {
    registerTool(_name: string, _config: unknown, candidate: RegisteredHandler) {
      registered = candidate;
      return { remove() {} };
    },
  } as unknown as McpServer;

  registerTool(server, {
    name: toolName,
    canonicalName,
    category: 'write_simple',
    annotations: {
      title: toolName,
      description: toolName,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string(),
      repo: z.string(),
      payload: z.unknown().optional(),
    },
    outputShape: { executed: z.boolean() },
    handler: async () => {
      calls += 1;
      return { data: { executed: true }, summary: 'synthetic handler executed' };
    },
  }, () => 'github-boundary-test-hash');

  assert.ok(registered, `${toolName} should register`);
  return { handler: registered, handlerCalls: () => calls };
}

async function callActualTool(
  name: string,
  args: Record<string, unknown>,
  register: (server: McpServer, callerHash: () => string) => void,
  callerAgent = 'developer',
): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: 'github-boundary-actual-test', version: '0' }, { capabilities: { tools: {} } });
  register(server, () => 'github-boundary-test-hash');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'github-boundary-actual-client', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await requestContext.run(
      {
        callerHash: 'github-boundary-test-hash',
        correlationId: `github-boundary-actual-${name}`,
        callerAgent,
      },
      async () => await client.callTool({ name, arguments: args }) as unknown as Record<string, unknown>,
    );
  } finally {
    await client.close();
    await server.close();
  }
}

async function invoke(
  handler: RegisteredHandler,
  callerAgent: string,
  owner: string,
  payload?: unknown,
): Promise<Record<string, unknown>> {
  return requestContext.run(
    {
      callerHash: 'github-boundary-test-hash',
      correlationId: `github-boundary-${callerAgent}`,
      callerAgent,
    },
    () => handler({ owner, repo: 'otchealth-mcp-server', payload, dry_run: true }),
  );
}

function errorCode(response: Record<string, unknown>): string | undefined {
  const structured = response.structuredContent as Record<string, unknown> | undefined;
  const error = structured?.error as Record<string, unknown> | undefined;
  return error?.code as string | undefined;
}

test('every direct GitHub repository mutation rejects an external owner before its handler', async () => {
  for (const tool of GITHUB_REPOSITORY_WRITE_TOOLS) {
    const captured = captureBoundaryHandler(tool);
    const response = await invoke(captured.handler, 'cto', 'external-owner', { body: 'clean' });
    assert.equal(errorCode(response), 'github_owner_not_allowed', tool);
    assert.equal(captured.handlerCalls(), 0, `${tool} must not reach its handler`);
  }
});

test('every direct GitHub repository mutation preserves the MedReview/phi write carveout', async () => {
  for (const [index, tool] of GITHUB_REPOSITORY_WRITE_TOOLS.entries()) {
    const captured = captureBoundaryHandler(tool);
    const repo = index % 2 === 0 ? 'MedReview-App' : 'synthetic-phi-service';
    const response = await requestContext.run(
      {
        callerHash: 'github-boundary-test-hash',
        correlationId: `github-boundary-phi-${tool}`,
        callerAgent: 'cto',
      },
      () => captured.handler({
        owner: 'InnerScopeHearing',
        repo,
        payload: { body: 'synthetic test fixture' },
        dry_run: true,
      }),
    );
    assert.equal(errorCode(response), 'github_write_phi_rejected', tool);
    assert.equal(captured.handlerCalls(), 0, `${tool} must not reach its handler`);
  }
});

test('case-insensitive company owner and clean code preserve ordinary dry-run execution', async () => {
  for (const owner of ['InnerScopeHearing', 'innerscopehearing', 'INNERSCOPEHEARING']) {
    const captured = captureBoundaryHandler('github_create_branch');
    const response = await invoke(captured.handler, 'developer', owner, {
      branch: 'codex/operator-boundary',
    });
    assert.equal(errorCode(response), undefined, owner);
    assert.equal(captured.handlerCalls(), 1, owner);
  }
});

test('shared and adjacent writes reject deeply nested late markers before handlers', async () => {
  const lateMarker = `${'ordinary engineering text '.repeat(1_000)}[MNPI] restricted`;
  for (const tool of ['github_push_files', 'github_release_update']) {
    const captured = captureBoundaryHandler(tool);
    const response = await invoke(captured.handler, 'cto', 'InnerScopeHearing', {
      nested: { files: [{ content: lateMarker }] },
    });
    assert.equal(errorCode(response), 'github_pre_share_blocked', tool);
    assert.equal(captured.handlerCalls(), 0, `${tool} must not reach its handler`);
  }
});

test('real push-files and workflow-dispatch schemas reject nested late markers without upstream calls', async () => {
  const { registerGitHubPushFiles } = await import('./push-files.js');
  const { registerGitHubDispatchWorkflow } = await import('./dispatch-workflow.js');
  const lateMarker = `${'ordinary engineering text '.repeat(1_000)}[MNPI] restricted`;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('unexpected upstream fetch');
  }) as typeof fetch;
  try {
    const push = await callActualTool('github_push_files', {
      owner: 'InnerScopeHearing',
      repo: 'otchealth-mcp-server',
      branch: 'codex/synthetic',
      message: 'synthetic test',
      files: [{ path: 'src/synthetic.ts', content: lateMarker }],
      dry_run: true,
    }, registerGitHubPushFiles);
    assert.equal(errorCode(push), 'github_pre_share_blocked');

    const dispatch = await callActualTool('github_dispatch_workflow', {
      owner: 'InnerScopeHearing',
      repo: 'otchealth-mcp-server',
      workflow_id: 'ci.yml',
      ref: 'main',
      inputs: { release_notes: lateMarker },
      dry_run: true,
    }, registerGitHubDispatchWorkflow);
    assert.equal(errorCode(dispatch), 'github_pre_share_blocked');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('real registered handlers reject unsafe route inputs before dry-run handlers or upstream fetch', async () => {
  const { registerGitHubGetFileContents } = await import('./get-file-contents.js');
  const { registerGitHubCreateOrUpdateFile } = await import('./create-or-update-file.js');
  const { registerGitHubContentsDeleteFile } = await import('./contents-delete-file.js');
  const { registerGitHubRefDelete } = await import('./ref-delete.js');
  const { registerGitHubLabelDelete } = await import('./label-delete.js');
  const { registerGitHubBranchGetProtection } = await import('./branch-get-protection.js');
  const { registerGitHubDispatchWorkflow } = await import('./dispatch-workflow.js');
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('unsafe route reached upstream');
  }) as typeof fetch;

  const cases: Array<{
    name: string;
    register: (server: McpServer, callerHash: () => string) => void;
    caller?: string;
    args: Record<string, unknown>;
  }> = [
    {
      name: 'github_get_file_contents', register: registerGitHubGetFileContents,
      args: { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', path: '../../../../repos/external/repo/README.md' },
    },
    {
      name: 'github_create_or_update_file', register: registerGitHubCreateOrUpdateFile,
      args: {
        owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', path: 'src/%2e%2e/outside.ts',
        message: 'synthetic', content: 'export {};', dry_run: true,
      },
    },
    {
      name: 'github_contents_delete_file', register: registerGitHubContentsDeleteFile, caller: 'cto',
      args: {
        owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', path: '%252e%252e',
        message: 'synthetic', sha: 'a'.repeat(40), dry_run: true,
      },
    },
    {
      name: 'github_ref_delete', register: registerGitHubRefDelete,
      args: { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', ref: '../..', dry_run: true },
    },
    {
      name: 'github_label_delete', register: registerGitHubLabelDelete, caller: 'cto',
      args: { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', label_name: '.%2e', dry_run: true },
    },
    {
      name: 'github_branch_get_protection', register: registerGitHubBranchGetProtection,
      args: { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', branch: 'safe%252F..%252Foutside' },
    },
    {
      name: 'github_dispatch_workflow', register: registerGitHubDispatchWorkflow,
      args: {
        owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', workflow_id: '%2fexternal.yml',
        ref: 'main', dry_run: true,
      },
    },
    {
      name: 'github_get_file_contents', register: registerGitHubGetFileContents,
      args: { owner: 'InnerScopeHearing%2Fexternal', repo: 'otchealth-mcp-server', path: 'README.md' },
    },
  ];

  try {
    for (const item of cases) {
      const response = await callActualTool(item.name, item.args, item.register, item.caller);
      assert.equal(errorCode(response), 'github_invalid_path', item.name);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('canonical-name boundary cannot be bypassed through a stripped M365 alias', async () => {
  const ownerAlias = captureBoundaryHandler('push_files', 'github_push_files');
  const ownerDenied = await invoke(ownerAlias.handler, 'developer', 'external-owner', { body: 'clean' });
  assert.equal(errorCode(ownerDenied), 'github_owner_not_allowed');
  assert.equal(ownerAlias.handlerCalls(), 0);

  const contentAlias = captureBoundaryHandler('push_files', 'github_push_files');
  const contentDenied = await invoke(contentAlias.handler, 'developer', 'InnerScopeHearing', {
    files: [{ content: '[MNPI] restricted' }],
  });
  assert.equal(errorCode(contentDenied), 'github_pre_share_blocked');
  assert.equal(contentAlias.handlerCalls(), 0);
});

test('clo-personal refuses broad content while Exec clean engineering and metadata writes remain available', async () => {
  const personalContent = captureBoundaryHandler('github_create_issue');
  const denied = await invoke(personalContent.handler, 'clo-personal', 'InnerScopeHearing', {
    title: 'ordinary-looking unmarked personal matter',
  });
  assert.equal(errorCode(denied), 'github_pre_share_blocked');
  assert.equal(personalContent.handlerCalls(), 0);

  for (const [lane, tool] of [
    ['clo-personal', 'github_pr_update_branch'],
    ['exec', 'github_create_issue'],
  ] as const) {
    const allowed = captureBoundaryHandler(tool);
    const response = await invoke(allowed.handler, lane, 'InnerScopeHearing', {
      title: 'ordinary clean engineering change', pull_number: 42,
    });
    assert.equal(errorCode(response), undefined, `${lane}:${tool}`);
    assert.equal(allowed.handlerCalls(), 1, `${lane}:${tool}`);
  }
});
