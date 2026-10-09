import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { COMPANY_GITHUB_OPERATOR_LANES } from '../../config/github-operator.js';

before(() => {
  process.env.CIO_SITE_ID ??= 'test';
  process.env.CIO_TRACK_KEY ??= 'test';
  process.env.CIO_APP_API_BEARER ??= 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
  process.env.READ_ONLY_MODE = 'false';
  process.env.ENABLE_WRITE_TOOLS = 'true';
  process.env.ENABLE_HIGH_RISK_TOOLS = 'true';
  process.env.DRY_RUN_DEFAULT = 'true';
});

async function callCreateBranch(callerAgent: string, owner = 'InnerScopeHearing') {
  const { registerGitHubCreateBranch } = await import('./create-branch.js');
  const { requestContext } = await import('../../server/request-context.js');

  const server = new McpServer({ name: 'github-operator-test', version: '0' }, { capabilities: { tools: {} } });
  registerGitHubCreateBranch(server, () => 'operator-test-hash');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'github-operator-test-client', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await requestContext.run(
      { callerHash: 'operator-test-hash', correlationId: `operator-test-${callerAgent}`, callerAgent },
      () => client.callTool({
        name: 'github_create_branch',
        arguments: {
          owner,
          repo: 'otchealth-mcp-server',
          branch: `operator-test-${callerAgent}`,
          dry_run: true,
        },
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
}

async function callUpdatePullRequestBranch(callerAgent: string, owner = 'InnerScopeHearing') {
  const { registerGitHubPrUpdateBranch } = await import('./pr-update-branch.js');
  const { requestContext } = await import('../../server/request-context.js');

  const server = new McpServer({ name: 'github-operator-test', version: '0' }, { capabilities: { tools: {} } });
  registerGitHubPrUpdateBranch(server, () => 'operator-test-hash');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'github-operator-test-client', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await requestContext.run(
      { callerHash: 'operator-test-hash', correlationId: `operator-test-${callerAgent}`, callerAgent },
      () => client.callTool({
        name: 'github_pr_update_branch',
        arguments: {
          owner,
          repo: 'otchealth-mcp-server',
          pull_number: 42,
          dry_run: true,
        },
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
}

async function callDestructiveDelete(
  tool: 'github_label_delete' | 'github_release_delete',
  callerAgent: string,
) {
  const { registerGitHubLabelDelete } = await import('./label-delete.js');
  const { registerGitHubReleaseDelete } = await import('./release-delete.js');
  const { requestContext } = await import('../../server/request-context.js');
  const register = tool === 'github_label_delete' ? registerGitHubLabelDelete : registerGitHubReleaseDelete;

  const server = new McpServer({ name: 'github-delete-governance-test', version: '0' }, { capabilities: { tools: {} } });
  register(server, () => 'operator-test-hash');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'github-delete-governance-client', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const argumentsForTool = tool === 'github_label_delete'
      ? { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', label_name: 'synthetic', dry_run: true }
      : { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', release_id: 42, dry_run: true };
    return await requestContext.run(
      { callerHash: 'operator-test-hash', correlationId: `delete-test-${tool}-${callerAgent}`, callerAgent },
      () => client.callTool({ name: tool, arguments: argumentsForTool }),
    );
  } finally {
    await client.close();
    await server.close();
  }
}

test('every canonical company lane passes real GitHub write governance while dry-run stays non-mutating', async () => {
  for (const [index, lane] of COMPANY_GITHUB_OPERATOR_LANES.entries()) {
    const owner = index % 2 === 0 ? 'innerscopehearing' : 'INNERSCOPEHEARING';
    const result = lane === 'clo-personal'
      ? await callUpdatePullRequestBranch(lane, owner)
      : await callCreateBranch(lane, owner);
    assert.ok(!result.isError, `${lane} must pass a real GitHub write execution gate: ${JSON.stringify(result)}`);
    assert.match(result.content?.[0]?.type === 'text' ? result.content[0].text : '', /DRY RUN/i, `${lane} must remain a dry run`);
  }
});

test('every canonical company lane rejects an external repository owner before a dry-run handler can execute', async () => {
  for (const lane of COMPANY_GITHUB_OPERATOR_LANES) {
    const result = await callCreateBranch(lane, 'external-owner');
    assert.equal(result.isError, true, `${lane} must refuse an external owner`);
    assert.match(result.content?.[0]?.type === 'text' ? result.content[0].text : '', /restricted|owner|InnerScopeHearing/i);
  }
});

test('unknown and external identities fail real GitHub write governance before mutation', async () => {
  for (const lane of ['', 'unknown', 'external-read']) {
    const result = await callCreateBranch(lane);
    assert.equal(result.isError, true, `${lane || '(empty)'} must be denied`);
    assert.match(result.content?.[0]?.type === 'text' ? result.content[0].text : '', /restricted|identity|forbidden/i);
  }
});

test('the isolated Make pilot cannot invoke the shared GitHub operator write', async () => {
  const result = await callCreateBranch('cto-make-github-pilot');
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.type === 'text' ? result.content[0].text : '', /restricted|identity|forbidden/i);
});

test('destructive label/release deletion remains CTO-only under real registered categories', async () => {
  for (const tool of ['github_label_delete', 'github_release_delete'] as const) {
    const developer = await callDestructiveDelete(tool, 'developer');
    assert.equal(developer.isError, true, `${tool} must deny Developer`);
    assert.match(
      developer.content?.[0]?.type === 'text' ? developer.content[0].text : '',
      /restricted|identity|forbidden/i,
    );

    const cto = await callDestructiveDelete(tool, 'cto');
    assert.ok(!cto.isError, `${tool} must retain CTO dry-run access: ${JSON.stringify(cto)}`);
    assert.match(cto.content?.[0]?.type === 'text' ? cto.content[0].text : '', /DRY RUN/i);
  }
});
