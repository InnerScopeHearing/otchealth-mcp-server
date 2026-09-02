import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConnectorSetupCodeCreate } from './setup-code-create.js';

// GOVERNANCE (src/catalog/governance.ts's 'connector_setup_code_create' rule) runs INSIDE
// registerTool's real wrapper, so these tests exercise the REAL registration path (not a stub),
// mirroring registry.lane-curation.test.ts's convention for the same reason: only that proves what
// actually gets enforced, not just what a pure helper computes in isolation.
//
// Minting itself needs the shared agent-state plane (agentstate/store.ts), which is unconfigured in
// this hermetic test process (no PG_HOST) -- exactly like every other durable-store-backed route in
// this repo's test suite (see oauth.test.ts's header, semantic-cache.test.ts's header). The role
// allowlist (Zod z.enum) and the caller allowlist (governance.ts + the in-handler check) are both
// enforced BEFORE mintSetupCode is ever called, so they are fully testable here regardless; the
// mint/consume logic itself is exhaustively covered directly in auth/setup-codes.test.ts.

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
});

interface McpToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: {
    result: unknown;
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
async function callAsAgent(callerAgent: string, input: Record<string, unknown>): Promise<McpToolResult> {
  const { requestContext, currentCallerHash } = await import('../../server/request-context.js');
  const { server, handlers } = fakeServer();
  let result: McpToolResult | undefined;
  await requestContext.run(
    { callerHash: 'test-hash', correlationId: 'test-corr', callerAgent, connectorSurface: false, m365StaticAuth: false },
    async () => {
      registerConnectorSetupCodeCreate(server, currentCallerHash);
      result = await handlers.connector_setup_code_create!(input);
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
  test(`caller_agent="${allowed}" PASSES the caller-allowlist gate (reaches the mint attempt, not a forbidden_role refusal)`, async () => {
    const result = await callAsAgent(allowed, { role: 'cfo' });
    // The shared agent-state plane is unconfigured in this hermetic process, so the actual mint
    // fails with setup_code_store_unavailable -- but critically NOT with forbidden_role. That
    // distinction is exactly what proves the caller-allowlist gate was passed and the request
    // reached mintSetupCode (see auth/setup-codes.test.ts for the exhaustive mint/consume coverage
    // against an injected, working fake store).
    assert.notEqual(result.structuredContent.error?.code, 'forbidden_role', `caller "${allowed}" must not be refused by the caller allowlist`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ROLE ALLOWLIST: the Zod z.enum(ELEVATION_ROLES) input shape rejects clo-personal (and anything
// else outside the six roles) BEFORE the handler -- and therefore BEFORE mintSetupCode -- ever runs.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('SAFETY-CRITICAL: role="clo-personal" is rejected at input validation, even for the cto caller', async () => {
  const result = await callAsAgent('cto', { role: 'clo-personal' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error?.code, 'invalid_input');
  // Specifically NOT forbidden_role or a store error -- it must never even reach a role/caller
  // decision, because the input itself is malformed by the schema's own allowlist.
});

for (const bad of ['exec', 'cpo', 'cco', 'admin', 'ADMIN', 'cto ']) {
  test(`role="${bad}" (outside the six elevation roles) is rejected at input validation`, async () => {
    const result = await callAsAgent('cto', { role: bad });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error?.code, 'invalid_input');
  });
}

for (const role of ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer']) {
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
