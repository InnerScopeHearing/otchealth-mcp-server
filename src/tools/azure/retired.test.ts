import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * The azure_* family is RETIRED (see src/azure/retired.ts for the full why). These tests assert the
 * behaviour that retirement is supposed to produce, through the REAL registration path
 * (registerAllTools -> registry.ts's registerTool -> the SDK's own _registeredTools table), calling
 * the tools exactly as a caller would.
 *
 * The bar is deliberately higher than "it fails". The defect being fixed is a failure that READS
 * like something else: before this change, azure_containerapp_set_env answered
 *
 *   Tool azure_containerapp_set_env failed: managed identity unavailable
 *   (IDENTITY_ENDPOINT/IDENTITY_HEADER unset). ... Next step: Check server logs for the correlation_id.
 *
 * -- indistinguishable from a transient auth blip, and pointing nowhere. So these tests assert the
 * error's CONTENT, not just its existence: a dedicated error code, the word RETIRED, an explicit
 * "retrying will not help", and a named replacement in otchealth-cto's aws-recovery-console.yml.
 *
 * Production parity matters here: the write tools are gated by ENABLE_WRITE_TOOLS /
 * ENABLE_HIGH_RISK_TOOLS and default dry_run=true, and the live task definition has both flags TRUE.
 * With the production values a dry-run call previously returned a confident "DRY RUN: would set ..."
 * plan for a resource that no longer exists -- a failure returned as a plausible value. So this file
 * sets those flags to their production values and asserts the tombstone fires on the dry-run path
 * too, which is exactly the path a cautious caller would try first.
 */

// Must be set before the first loadEnv() (it caches for the process lifetime).
const PROD_LIKE: Record<string, string> = {
  READ_ONLY_MODE: 'false',
  ENABLE_WRITE_TOOLS: 'true',
  ENABLE_HIGH_RISK_TOOLS: 'true',
  DRY_RUN_DEFAULT: 'true',
  CIO_SITE_ID: 'test',
  CIO_TRACK_KEY: 'test',
  CIO_APP_API_BEARER: 'test',
  PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
  ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
  N8N_WEBHOOK_SECRET: 'c'.repeat(32),
};
before(() => {
  for (const [k, v] of Object.entries(PROD_LIKE)) process.env[k] = v;
});

// The ECS runtime has neither door open. Cleared per test so a stray value in the ambient
// environment cannot make these assertions pass or fail for the wrong reason.
beforeEach(() => {
  delete process.env.IDENTITY_ENDPOINT;
  delete process.env.IDENTITY_HEADER;
  delete process.env.AZURE_SEARCH_ADMIN_KEY;
  delete process.env.AZURE_SUBSCRIPTION_ID;
});
afterEach(() => {
  delete process.env.IDENTITY_ENDPOINT;
  delete process.env.IDENTITY_HEADER;
  delete process.env.AZURE_SEARCH_ADMIN_KEY;
  delete process.env.AZURE_SUBSCRIPTION_ID;
});

/** Minimal VALID arguments per tool: enough to clear registry.ts's strict zod parse and reach the
 *  handler, so what these tests observe is the tombstone and never an input-validation error. */
const MINIMAL_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  azure_containerapp_get: { name: 'otchealth-mcp-gateway' },
  azure_containerapp_set_env: { name: 'otchealth-mcp-gateway', env: [{ name: 'SOME_FLAG', value: 'x' }] },
  azure_job_execute: { job_name: 'daily-digest' },
  azure_job_executions: { job_name: 'daily-digest' },
  azure_job_get: { job_name: 'daily-digest' },
  azure_job_update: { job_name: 'daily-digest', cron: '0 6 * * *' },
  azure_job_upsert: { job_name: 'daily-digest', properties: { environmentId: 'x' } },
  azure_jobs_list: {},
  azure_logs_query: { kql: 'ContainerAppConsoleLogs_CL | take 1' },
  azure_resource_list: {},
  azure_search_index_stats: { index: 'memory-exec' },
  azure_search_index_upsert: { service: 'otchealth-dataroom-s1', index_name: 'memory-exec', definition: { fields: [] } },
  azure_search_indexer_upsert: { service: 'otchealth-dataroom-s1', indexer_name: 'memory-exec-idxr', definition: {} },
};

interface RegisteredTool {
  /** The MCP SDK's own RegisteredTool.handler -- the exact function a tools/call dispatches to. */
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: { error?: { code?: string; message?: string; next_step?: string }; result?: unknown };
  }>;
  description?: string;
  _meta?: unknown;
}

const CTO_CONTEXT = {
  callerHash: 'test-hash',
  correlationId: 'test-corr',
  callerAgent: 'cto',
  connectorSurface: false,
  m365StaticAuth: false,
};

/** Run `fn` as the 'cto' lane. Needed for the CALL as well as the registration: registry.ts reads
 *  currentCallerAgent() again inside the handler wrapper, and azure_* is CTO-gated in
 *  catalog/governance.ts -- outside a context the call is refused with `forbidden_role` before the
 *  handler runs, which would prove nothing about the tombstone. */
async function asCto<T>(fn: () => Promise<T>): Promise<T> {
  const { requestContext } = await import('../../server/request-context.js');
  return requestContext.run(CTO_CONTEXT, fn);
}

/** Register the whole catalog once, as the 'cto' lane (azure_* is CTO-gated in governance.ts, so any
 *  other lane would be refused before the handler and prove nothing about the tombstone). */
async function registeredTools(): Promise<Record<string, RegisteredTool>> {
  const { registerAllTools } = await import('../index.js');
  const { currentCallerHash, requestContext } = await import('../../server/request-context.js');
  const mcp = new McpServer(
    { name: 'test', version: '0' },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );
  await requestContext.run(CTO_CONTEXT, async () => {
    registerAllTools(mcp, currentCallerHash);
  });
  return (mcp as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

async function azureToolNames(): Promise<string[]> {
  return Object.keys(await registeredTools())
    .filter((n) => n.startsWith('azure_'))
    .sort();
}

test('ANTI-ROT: every azure_* tool the server actually registers is declared in RETIRED_AZURE_TOOLS, and vice versa', async () => {
  // Without this, a future azure_* tool could be added with no tombstone and every other test here
  // would still pass -- the check would silently stop covering the thing it exists to cover.
  const { RETIRED_AZURE_TOOLS } = await import('../../azure/retired.js');
  const registered = await azureToolNames();
  const declared = Object.keys(RETIRED_AZURE_TOOLS).sort();
  assert.deepEqual(
    registered,
    declared,
    'every registered azure_* tool must declare its door + replacement in src/azure/retired.ts, and ' +
      'every declared entry must still be a real registered tool',
  );
  assert.ok(registered.length >= 13, `expected at least 13 azure_* tools, found ${registered.length}`);
  // The set is pinned by name so a silent rename/removal is visible in the diff, not just in a count.
  assert.deepEqual(registered, [
    'azure_containerapp_get',
    'azure_containerapp_set_env',
    'azure_job_execute',
    'azure_job_executions',
    'azure_job_get',
    'azure_job_update',
    'azure_job_upsert',
    'azure_jobs_list',
    'azure_logs_query',
    'azure_resource_list',
    'azure_search_index_stats',
    'azure_search_index_upsert',
    'azure_search_indexer_upsert',
  ]);
});

test('THE CONTRACT: every azure_* tool refuses with a named, actionable, explicitly-non-transient error', async () => {
  const tools = await registeredTools();
  const names = Object.keys(tools).filter((n) => n.startsWith('azure_')).sort();

  for (const name of names) {
    const args = MINIMAL_ARGS[name];
    assert.ok(args, `no MINIMAL_ARGS entry for ${name} -- add one so this tool is really exercised`);
    const res = await asCto(() => tools[name].handler({ ...args }, {}));

    assert.equal(res.isError, true, `${name} should refuse, not succeed`);
    const err = res.structuredContent?.error;
    assert.ok(err, `${name} returned no structured error`);

    // A DEDICATED code, not the catch-all `tool_error` a bare throw would produce.
    assert.equal(err!.code, 'azure_control_plane_retired', `${name} must carry the retirement error code`);

    const message = String(err!.message);
    const nextStep = String(err!.next_step);

    assert.match(message, /RETIRED/, `${name}: the message must say the tool is retired`);
    assert.match(
      message,
      /retrying will not help/i,
      `${name}: the message must state that this is not worth retrying`,
    );
    assert.match(
      message,
      /aws-recovery-console\.yml/,
      `${name}: the message must name where AWS control-plane operations actually live`,
    );
    // The tool that inspired this: 55c84f6b is the deleted subscription every ARM path targets.
    assert.match(message, /55c84f6b/, `${name}: the message must name the dead subscription`);

    // next_step must be REAL guidance, not registry.ts's generic fallback.
    assert.notEqual(
      nextStep,
      'Check server logs for the correlation_id.',
      `${name}: next_step is still the generic fallback -- the caller learns nothing`,
    );
    assert.ok(nextStep.length > 40, `${name}: next_step is too thin to act on: "${nextStep}"`);

    // And no half-success: nothing plausible-looking comes back alongside the error.
    assert.equal(res.structuredContent?.result ?? null, null, `${name} must not return a result payload`);

    const text = (res.content || []).map((c) => c.text || '').join('\n');
    assert.doesNotMatch(
      text,
      /DRY RUN: would/,
      `${name}: a dry-run plan was rendered for a resource that no longer exists`,
    );
  }
});

test('the refusal happens BEFORE any network attempt', async () => {
  // "Fails immediately" is the actual requirement; an error raised after a doomed outbound call is
  // slower, noisier in logs, and can still surface as a connect/timeout error under a different
  // network. Proven by making any fetch a hard failure and observing the SAME clean refusal.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (...a: unknown[]) => {
    fetchCalls += 1;
    throw new Error(`unexpected outbound fetch: ${String(a[0])}`);
  }) as typeof globalThis.fetch;
  try {
    const tools = await registeredTools();
    for (const name of Object.keys(tools).filter((n) => n.startsWith('azure_'))) {
      const res = await asCto(() => tools[name].handler({ ...MINIMAL_ARGS[name] }, {}));
      assert.equal(
        res.structuredContent?.error?.code,
        'azure_control_plane_retired',
        `${name} must refuse without reaching the network`,
      );
    }
    assert.equal(fetchCalls, 0, 'a retired azure_* tool attempted an outbound request');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the advertised description steers a model away before it spends a call', async () => {
  const tools = await registeredTools();
  for (const name of Object.keys(tools).filter((n) => n.startsWith('azure_'))) {
    const description = String(tools[name].description || '');
    assert.match(description, /RETIRED -- DO NOT USE/, `${name}: tools/list still advertises it as usable`);
    assert.match(description, /aws-recovery-console\.yml|infra\/aws|OpenSearch/, `${name}: description names no alternative`);
  }
});

test('KNOWN-NEGATIVE: the guard is a live condition, not a blanket kill -- a real Azure runtime is NOT refused', async () => {
  // Guards against the opposite failure: a hardcoded throw would keep "failing" even if the
  // condition it describes stopped being true, which is how a tombstone rots into its own lie.
  const { assertAzureToolLive } = await import('../../azure/retired.js');
  process.env.IDENTITY_ENDPOINT = 'http://169.254.170.2/identity';
  process.env.IDENTITY_HEADER = 'header';
  process.env.AZURE_SUBSCRIPTION_ID = '11111111-2222-3333-4444-555555555555';
  assert.doesNotThrow(() => assertAzureToolLive('azure_containerapp_get'));

  // Either condition alone is still fatal, so the guard is not passing for a weak reason.
  process.env.AZURE_SUBSCRIPTION_ID = '55c84f6b-ef90-4259-a58b-50835cc4cab4';
  assert.throws(() => assertAzureToolLive('azure_containerapp_get'), /permanently deleted/);
  delete process.env.AZURE_SUBSCRIPTION_ID;
  delete process.env.IDENTITY_ENDPOINT;
  delete process.env.IDENTITY_HEADER;
  assert.throws(() => assertAzureToolLive('azure_containerapp_get'), /no Azure managed identity/);
});

test('the two Azure Search WRITE tools have a real second door, and only they do', async () => {
  // These are the one honest exception: otchealth-dataroom-s1.search.windows.net still answers, and
  // searchAdminKey() takes AZURE_SEARCH_ADMIN_KEY directly without touching ARM. So they are gated
  // on the credential that would actually make them work, not tombstoned on a belief.
  const { assertAzureToolLive } = await import('../../azure/retired.js');
  process.env.AZURE_SEARCH_ADMIN_KEY = 'a-real-admin-key';

  assert.doesNotThrow(() => assertAzureToolLive('azure_search_index_upsert'));
  assert.doesNotThrow(() => assertAzureToolLive('azure_search_indexer_upsert'));

  // index_stats needs an ARM listQueryKeys call, so the admin key does NOT revive it.
  assert.throws(() => assertAzureToolLive('azure_search_index_stats'), /RETIRED/);
  assert.throws(() => assertAzureToolLive('azure_containerapp_set_env'), /RETIRED/);
});

test('a search WRITE tool with no admin key says so, rather than blaming the identity alone', async () => {
  const { assertAzureToolLive } = await import('../../azure/retired.js');
  assert.throws(
    () => assertAzureToolLive('azure_search_index_upsert'),
    /AZURE_SEARCH_ADMIN_KEY direct key, is not set either/,
  );
});

test('an azure_* tool with no tombstone entry fails loudly at the guard rather than silently passing', async () => {
  const { assertAzureToolLive } = await import('../../azure/retired.js');
  assert.throws(
    () => assertAzureToolLive('azure_something_new'),
    /not listed in RETIRED_AZURE_TOOLS/,
  );
});

test('the advertised description tracks the guard rather than asserting death unconditionally', async () => {
  // A catalog entry that says "RETIRED -- DO NOT USE" about a tool that would in fact work is the
  // same defect in miniature: a confident claim the runtime contradicts. With the search admin key
  // present, the two tools that key revives must advertise their ORIGINAL description, while every
  // ARM-only tool stays stamped.
  process.env.AZURE_SEARCH_ADMIN_KEY = 'a-real-admin-key';
  const tools = await registeredTools();

  for (const name of ['azure_search_index_upsert', 'azure_search_indexer_upsert']) {
    const description = String(tools[name].description || '');
    assert.doesNotMatch(
      description,
      /RETIRED -- DO NOT USE/,
      `${name} is usable with AZURE_SEARCH_ADMIN_KEY set, so the catalog must not call it dead`,
    );
  }
  for (const name of ['azure_containerapp_set_env', 'azure_search_index_stats']) {
    assert.match(
      String(tools[name].description || ''),
      /RETIRED -- DO NOT USE/,
      `${name} has no direct-key path, so the admin key must not un-retire it`,
    );
  }
});
