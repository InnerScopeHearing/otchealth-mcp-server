import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requestContext } from '../../server/request-context.js';
import { MAKE_GITHUB_REPOSITORY } from '../../github/make-broker.js';

const SOURCE_SHA = 'a'.repeat(40);
const CORRELATION_ID = 'corr-make-github-dry-run-summary';
const KEY = 'make-pilot-summary-regression-0001';

const syntheticEnvironment: Record<string, string> = {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track-key',
  CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: `synthetic-${'a'.repeat(40)}`,
  ADMIN_REVOKE_TOKEN: `synthetic-${'b'.repeat(40)}`,
  N8N_WEBHOOK_SECRET: `synthetic-${'c'.repeat(40)}`,
  SHIELD_MODE: 'off',
  COLD_START_MODE: 'off',
  TOOL_CATALOG_CURATION_MODE: 'off',
  READ_ONLY_MODE: 'false',
  ENABLE_WRITE_TOOLS: 'true',
};
const previousEnvironment = Object.fromEntries(Object.keys(syntheticEnvironment).map((key) => [key, process.env[key]]));

Object.assign(process.env, syntheticEnvironment);
const { registerGitHubMakeBroker } = await import('./make-broker.js');

after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('dry-run branch creation summary and receipt include the validated source SHA', async () => {
  type CapturedHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  let handler: CapturedHandler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, candidate: CapturedHandler) {
      handler = candidate;
      return { remove() {} };
    },
  } as unknown as McpServer;

  registerGitHubMakeBroker(server, () => 'synthetic-caller-hash');
  assert.ok(handler, 'the broker should be registered for the synthetic test caller');

  const response = await requestContext.run(
    { callerHash: 'synthetic-caller-hash', correlationId: CORRELATION_ID, callerAgent: 'cto' },
    () => handler!({
      tool_name: 'github_create_branch',
      arguments: {
        owner: MAKE_GITHUB_REPOSITORY.owner,
        repo: MAKE_GITHUB_REPOSITORY.repo,
        from_sha: SOURCE_SHA,
      },
      idempotency_key: KEY,
      dry_run: true,
    }),
  );

  const serialized = JSON.stringify(response);
  assert.match(serialized, new RegExp(`Planned branch creation .* from ${SOURCE_SHA}\\.`));
  assert.doesNotMatch(serialized, /\bundefined\b/);
  const result = (response.structuredContent as { result: Record<string, unknown> }).result;
  assert.equal(result.from_sha, SOURCE_SHA);
});
