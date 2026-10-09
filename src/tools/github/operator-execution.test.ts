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
  process.env.DRY_RUN_DEFAULT = 'true';
});

async function callCreateBranch(callerAgent: string) {
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
          owner: 'InnerScopeHearing',
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

test('every canonical company lane passes real GitHub write governance while dry-run stays non-mutating', async () => {
  for (const lane of COMPANY_GITHUB_OPERATOR_LANES) {
    const result = await callCreateBranch(lane);
    assert.ok(!result.isError, `${lane} must pass the real github_create_branch execution gate: ${JSON.stringify(result)}`);
    assert.match(result.content?.[0]?.type === 'text' ? result.content[0].text : '', /DRY RUN/i, `${lane} must remain a dry run`);
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
