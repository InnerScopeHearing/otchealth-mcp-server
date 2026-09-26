import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConnectorSetupCodeCreate } from './setup-code-create.js';
import { DEFAULT_TTL_MINUTES, SetupCodeError } from '../../auth/setup-codes.js';

type SetupCodeMinter = typeof import('../../auth/setup-codes.js').mintSetupCode;

// GOVERNANCE (src/catalog/governance.ts's 'connector_setup_code_create' rule) runs INSIDE
// registerTool's real wrapper, so these tests exercise the REAL registration path (not a stub),
// mirroring registry.lane-curation.test.ts's convention for the same reason: only that proves what
// actually gets enforced, not just what a pure helper computes in isolation.
//
// Tests default every call to dry_run=true and explicitly inject a fake minter into the one
// dry_run=false regression. This keeps the suite hermetic even if a developer has a configured
// shared agent-state store in their environment.

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
  // Exercise the registered write tool while ensuring calls without an explicit dry_run are safe.
  process.env.READ_ONLY_MODE = 'false';
  process.env.ENABLE_WRITE_TOOLS = 'true';
  process.env.DRY_RUN_DEFAULT = 'true';
});

interface McpToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: {
    result: unknown;
    dry_run?: boolean;
    error?: { code: string; message: string };
  };
}

function fakeServer(): { server: McpServer; handlers: Record<string, (args: unknown) => Promise<McpToolResult>> } {
  const handlers: Record<string, (args: unknown) => Promise<McpToolResult>> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<McpToolResult>) => {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  return { server, handlers };
}

/** Registers the tool AND invokes it, both inside the SAME requestContext.run() call -- the
 *  AsyncLocalStorage context registry.ts's currentCallerAgent() reads is only live for the duration
 *  of that callback (and whatever it awaits synchronously within it), so calling the captured
 *  handler AFTER run() has already returned would silently see an empty caller_agent instead of the
 *  one this test intends. Mirrors registry.lane-curation.test.ts's exact pattern. */
async function callAsAgent(
  callerAgent: string,
  input: Record<string, unknown>,
  minter?: SetupCodeMinter,
): Promise<McpToolResult> {
  const { requestContext, currentCallerHash } = await import('../../server/request-context.js');
  const { server, handlers } = fakeServer();
  let result: McpToolResult | undefined;
  await requestContext.run(
    { callerHash: 'test-hash', correlationId: 'test-corr', callerAgent, connectorSurface: false, m365StaticAuth: false },
    async () => {
      registerConnectorSetupCodeCreate(server, currentCallerHash, minter);
      // An omitted dry_run is also forced into preview mode, independent of environment defaults.
      result = await handlers.connector_setup_code_create!({ dry_run: true, ...input });
    },
  );
  return result!;
}

test('connector_setup_code_create registers under the exact tool name', async () => {
  const { server, handlers } = fakeServer();
  registerConnectorSetupCodeCreate(server, () => 'h');
  assert.ok(handlers.connector_setup_code_create, 'connector_setup_code_create must be registered');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CALLER ALLOWLIST: only cto/exec may mint. Enforced at TWO layers (governance.ts + in-handler);
// these tests exercise the REAL combined path (whichever layer fires, the OUTCOME must be refused).
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a non-cto/exec caller is refused, EVEN FOR A VALID role (developer is a mintable ROLE, not a minting CALLER)', async () => {
  const result = await callAsAgent('developer', { role: 'cfo' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, 'forbidden_role');
});

for (const bad of ['coo', 'cro', 'clo', 'cfo', 'clo-personal', '', 'random-lane']) {
  test(`caller_agent="${bad || '(empty)'}" is refused from minting`, async () => {
    const result = await callAsAgent(bad, { role: 'cfo' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error?.code, 'forbidden_role');
  });
}

for (const allowed of ['cto', 'exec']) {
  test(`caller_agent="${allowed}" PASSES the caller-allowlist gate (reaches the dry-run plan, not a forbidden_role refusal)`, async () => {
    const result = await callAsAgent(allowed, { role: 'cfo' });
    assert.equal(result.structuredContent.dry_run, true);
    assert.notEqual(result.structuredContent.error?.code, 'forbidden_role', `caller "${allowed}" must not be refused by the caller allowlist`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ROLE ALLOWLIST: the Zod z.enum(ELEVATION_ROLES) input shape rejects clo-personal (and anything
// else outside the explicit elevation roles) BEFORE the handler -- and therefore BEFORE mintSetupCode -- ever runs.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('SAFETY-CRITICAL: role="clo-personal" is rejected at input validation, even for the cto caller', async () => {
  const result = await callAsAgent('cto', { role: 'clo-personal' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, 'invalid_input');
  // Specifically NOT forbidden_role or a store error -- it must never even reach a role/caller
  // decision, because the input itself is malformed by the schema's own allowlist.
});

for (const bad of ['exec', 'cpo', 'cco', 'admin', 'ADMIN', 'cto ']) {
  test(`role="${bad}" (outside the explicit elevation roles) is rejected at input validation`, async () => {
    const result = await callAsAgent('cto', { role: bad });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error?.code, 'invalid_input');
  });
}

for (const role of ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'chat_shared', 'wefunder-campaign-director', 'cto-make-github-pilot']) {
  test(`role="${role}" passes input validation for an allowed caller (reaches the mint attempt)`, async () => {
    const result = await callAsAgent('cto', { role });
    assert.notEqual(result.structuredContent.error?.code, 'invalid_input', `role "${role}" must be a valid input`);
    assert.notEqual(result.structuredContent.error?.code, 'forbidden_role');
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Misc input hygiene.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('an unexpected extra field is rejected (strict input shape)', async () => {
  const result = await callAsAgent('cto', { role: 'cfo', extra_unexpected_field: 'x' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, 'invalid_input');
});

test('ttl_minutes out of the documented [1, 1440] range is rejected at input validation', async () => {
  const tooBig = await callAsAgent('cto', { role: 'cfo', ttl_minutes: 5000 });
  assert.equal(tooBig.structuredContent.error?.code, 'invalid_input');
  const tooSmall = await callAsAgent('cto', { role: 'cfo', ttl_minutes: 0 });
  assert.equal(tooSmall.structuredContent.error?.code, 'invalid_input');
});

test('dry_run=true returns only a nonsecret setup-code plan and does not mint', async () => {
  let mintCalls = 0;
  const minter: SetupCodeMinter = async () => {
    mintCalls += 1;
    throw new SetupCodeError('setup_code_store_unavailable', 'Synthetic test store unavailable.');
  };
  const response = await callAsAgent('cto', { role: 'cfo', dry_run: true }, minter);

  assert.equal(mintCalls, 0, 'dry_run=true must return before the minter is invoked');
  assert.equal(response.structuredContent.dry_run, true);
  const plan = response.structuredContent.result as Record<string, unknown>;
  assert.deepEqual(plan, {
    planned: true,
    minted: false,
    role: 'cfo',
    ttl_minutes: DEFAULT_TTL_MINUTES,
  });
  assert.equal(plan.code, undefined);
  assert.match(response.content.map((item) => item.text).join('\n'), /DRY RUN/i);
  assert.doesNotMatch(JSON.stringify(response), /\bundefined\b/);
});

test('dry_run=false reaches only the injected fake minter and never touches a live store', async () => {
  const mintInputs: Parameters<SetupCodeMinter>[0][] = [];
  const minter: SetupCodeMinter = async (input) => {
    mintInputs.push(input);
    throw new SetupCodeError('setup_code_store_unavailable', 'Synthetic test store unavailable.');
  };
  const response = await callAsAgent('cto', { role: 'cfo', dry_run: false }, minter);

  assert.equal(mintInputs.length, 1);
  assert.deepEqual(mintInputs[0], {
    role: 'cfo',
    createdBy: 'cto',
    label: undefined,
    ttlMinutes: undefined,
  });
  assert.equal(response.structuredContent.dry_run, false);
  const result = response.structuredContent.result as Record<string, unknown>;
  assert.equal(result.planned, undefined);
  assert.equal(result.minted, false);
  assert.equal(result.error, 'setup_code_store_unavailable');
  assert.equal(result.code, undefined);
});

test('the tool description warns that the result contains a one-time owner secret', async () => {
  const { server } = fakeServer();
  let capturedDescription = '';
  server.registerTool = ((name: string, config: { description?: string }) => {
    if (name === 'connector_setup_code_create') capturedDescription = config.description ?? '';
  }) as unknown as McpServer['registerTool'];
  registerConnectorSetupCodeCreate(server, () => 'h');
  assert.match(capturedDescription, /one-time|shown exactly once|never recoverable/i);
  assert.match(capturedDescription, /privately/i);
});
