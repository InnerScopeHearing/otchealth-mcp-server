import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * 2026-09-04: the connector-surface (dcr_/occ_ OAuth client) branch of registerTool()'s
 * `toolConfig` sends ONLY `{ description, inputSchema }` -- no `annotations` at all -- so an MCP
 * client's approval machinery (OpenAI Codex's `writes`-mode policy is the concrete motivator) sees
 * every tool as write-capable and prompts on every call, including read-only tools like
 * brain_search. That shape was deliberate (commit 66cdde5, a Claude web client bug,
 * anthropics/claude-code#25081) -- see parseConnectorAnnotationsMode's doc comment in registry.ts
 * (next to connectorToolset()) for the full history of what was and was not independently proven
 * about WHICH field mattered, including the #80/#82 saga that found unexpected extra fields are not
 * uniformly fatal to Claude's client.
 *
 * This file locks in the fix: the connector surface now ALSO sends `annotations` (the four boolean
 * hints -- readOnlyHint/destructiveHint/idempotentHint/openWorldHint), while continuing to omit
 * `outputSchema`, the outer `title`, and `annotations.title` unconditionally (unrelated to the new
 * flag; those three were never re-proven safe and add nothing an approval gate needs). The whole
 * thing is gated by CONNECTOR_ANNOTATIONS_MODE (default 'on') so it can be reverted to the exact
 * prior bare shape with one task-definition env-var change and a rollout (no image rebuild), if a
 * real client regresses.
 *
 * Uses the SAME technique as registry.lane-curation.test.ts and
 * registry.readonly-annotations.test.ts: boot the REAL registry (registerAllTools) inside a
 * simulated connector-surface request context, then read the MCP SDK's own internal
 * `_registeredTools` table -- which stores exactly what was passed to `server.registerTool()`,
 * `undefined` for any field the config object omitted (verified by reading
 * node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js's registerTool/
 * _createRegisteredTool directly) -- so this proves the actual wire-shaping code path, not a mock.
 *
 * Every import that can transitively reach registerAllTools()'s full tool graph is a DYNAMIC import
 * inside before()/test bodies, never a static top-level one, for the exact module-load-ordering
 * reason registry.readonly-annotations.test.ts documents (a static import of anything that calls
 * loadEnv() at import time would run before the env stub below ever executes).
 */

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

afterEach(() => {
  delete process.env.CONNECTOR_ANNOTATIONS_MODE;
});

interface RawRegisteredTool {
  title?: string;
  description?: string;
  inputSchema?: z.AnyZodObject;
  outputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** Boots the full registry against a fresh McpServer with connectorSurface:true for `lane`, then
 *  returns the SDK's own internal registration table (same access pattern as
 *  registry.lane-curation.test.ts's registeredToolNames helper). */
async function registerConnectorSurface(lane: string): Promise<Record<string, RawRegisteredTool>> {
  const { registerAllTools } = await import('./index.js');
  const { currentCallerHash, requestContext } = await import('../server/request-context.js');
  // Mirrors server/mcp.ts's actual connector-surface McpServer construction (minimal capabilities).
  const mcp = new McpServer({ name: 'test-connector-annotations', version: '0' }, { capabilities: { tools: {} } });
  await requestContext.run(
    { callerHash: 'test-hash', correlationId: 'test-corr', callerAgent: lane, connectorSurface: true },
    async () => {
      registerAllTools(mcp, currentCallerHash);
    },
  );
  return (mcp as unknown as { _registeredTools: Record<string, RawRegisteredTool> })._registeredTools;
}

/** Same as above but connectorSurface:false (the internal/full-catalog path), to prove the new
 *  flag never touches that branch either way. */
async function registerInternalLane(lane: string): Promise<Record<string, RawRegisteredTool>> {
  const { registerAllTools } = await import('./index.js');
  const { currentCallerHash, requestContext } = await import('../server/request-context.js');
  const mcp = new McpServer({ name: 'test-internal-lane', version: '0' }, { capabilities: { tools: { listChanged: true }, logging: {} } });
  await requestContext.run(
    { callerHash: 'test-hash', correlationId: 'test-corr', callerAgent: lane, connectorSurface: false },
    async () => {
      registerAllTools(mcp, currentCallerHash);
    },
  );
  return (mcp as unknown as { _registeredTools: Record<string, RawRegisteredTool> })._registeredTools;
}

test('CRO Chat request context registers the two bounded revenue reads and does not leak them to constrained connector lanes', async () => {
  const toolNames = ['shopify_location_list', 'cio_admin_read_workspace_health'] as const;
  const croTools = await registerConnectorSurface('cro');
  const negativeLanes = [
    ['coo', await registerConnectorSurface('coo')],
    ['unknown', await registerConnectorSurface('totally-unknown-lane')],
    ['wefunder', await registerConnectorSurface('wefunder-campaign-director')],
  ] as const;

  for (const name of toolNames) {
    assert.ok(croTools[name], `CRO Chat must register ${name} through the real request-context path`);
    for (const [lane, tools] of negativeLanes) {
      assert.equal(tools[name], undefined, `${lane} Chat must not register ${name}`);
    }
  }
});

test('pure: parseConnectorAnnotationsMode defaults to "on"; only the literal string "off" (any case/whitespace) reverts it', async () => {
  const { parseConnectorAnnotationsMode } = await import('./registry.js');
  assert.equal(parseConnectorAnnotationsMode(undefined), 'on');
  assert.equal(parseConnectorAnnotationsMode(''), 'on');
  assert.equal(parseConnectorAnnotationsMode('   '), 'on');
  assert.equal(parseConnectorAnnotationsMode('garbage'), 'on');
  assert.equal(parseConnectorAnnotationsMode('on'), 'on');
  assert.equal(parseConnectorAnnotationsMode('off'), 'off');
  assert.equal(parseConnectorAnnotationsMode('OFF'), 'off');
  assert.equal(parseConnectorAnnotationsMode('  Off  '), 'off');
});

test('DEFAULT (CONNECTOR_ANNOTATIONS_MODE unset): connector surface includes annotations.readOnlyHint (plus the other 3 hints) matching the tool\'s real values, for a known read tool and a known write tool', async () => {
  delete process.env.CONNECTOR_ANNOTATIONS_MODE;
  const tools = await registerConnectorSurface('cto');

  // brain_search: category 'read', readOnlyHint:true, destructiveHint:false, idempotentHint:true,
  // openWorldHint:false (src/tools/kb/brain-search.ts) -- exactly the tool Codex must pass silently.
  const read = tools['brain_search'];
  assert.ok(read, 'brain_search should be registered on the cto connector surface');
  assert.deepEqual(
    read.annotations,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    'brain_search must carry its real annotations on the connector surface',
  );

  // memory_write: category 'write_simple', readOnlyHint:false, destructiveHint:false,
  // idempotentHint:false, openWorldHint:true (src/tools/agentstate/memory-write.ts) -- a different
  // boolean combination than brain_search, so a per-field passthrough bug (not just readOnlyHint)
  // would be caught here.
  const write = tools['memory_write'];
  assert.ok(write, 'memory_write should be registered on the cto connector surface');
  assert.deepEqual(
    write.annotations,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    'memory_write must carry its real annotations on the connector surface',
  );
});

test('the connector surface still omits outputSchema, the outer title, and annotations.title -- the regression 66cdde5 exists to prevent stays prevented', async () => {
  delete process.env.CONNECTOR_ANNOTATIONS_MODE;
  const tools = await registerConnectorSurface('cto');
  for (const name of ['brain_search', 'memory_write']) {
    const t = tools[name];
    assert.ok(t, `${name} should be registered`);
    assert.equal(t.outputSchema, undefined, `${name}: outputSchema must stay OFF the connector surface`);
    assert.equal(t.title, undefined, `${name}: the outer title must stay OFF the connector surface`);
    assert.equal(t.annotations?.title, undefined, `${name}: annotations.title must stay OFF the connector surface`);
    assert.ok(t.description, `${name}: description must still be present`);
  }
  assert.equal(
    tools['memory_write'].description,
    'Save one short note for the current app. Set dry_run=false to run.',
    'memory_write must keep the concise connector-facing description',
  );
  assert.equal(
    tools['checkpoint'].description,
    'Save a few short session notes for the current app. Set dry_run=false to run.',
    'checkpoint must keep the concise connector-facing description',
  );
});

test('memory_write uses a neutral, validation-equivalent schema only on the connector surface', async () => {
  const developerConnector = await registerConnectorSurface('developer');
  const developerInternal = await registerInternalLane('developer');
  const connector = developerConnector['memory_write'];
  const internal = developerInternal['memory_write'];
  assert.ok(connector?.inputSchema, 'memory_write: connector schema must be registered');
  assert.ok(internal?.inputSchema, 'memory_write: internal schema must be registered');
  const connectorShape = connector.inputSchema.shape;
  const internalShape = internal.inputSchema.shape;
  const valid = {
    agent: 'developer', kind: 'fact', text: 'Non-sensitive test marker.',
    idempotency_key: 'chat-developer-schema-projection-20260922', dry_run: false,
  };
  const invalid = { agent: 'developer', kind: 'fact', text: '', idempotency_key: 'short', dry_run: false };

  assert.deepEqual(Object.keys(connectorShape).sort(), Object.keys(internalShape).sort(), 'memory_write: connector fields must not drift');
  for (const [field, schema] of Object.entries(connectorShape)) {
    assert.ok((schema as z.ZodTypeAny).description == null, 'memory_write.' + field + ': connector schema must not carry field prose');
  }
  assert.ok(
    Object.values(internalShape).some((schema) => Boolean((schema as z.ZodTypeAny).description)),
    'memory_write: internal schema must retain its operator guidance',
  );
  assert.equal(z.object(connectorShape).safeParse(valid).success, true, 'memory_write: connector schema must accept a valid payload');
  assert.equal(z.object(internalShape).safeParse(valid).success, true, 'memory_write: internal schema must accept the same valid payload');
  assert.equal(z.object(connectorShape).safeParse(invalid).success, false, 'memory_write: connector schema must reject the invalid payload');
  assert.equal(z.object(internalShape).safeParse(invalid).success, false, 'memory_write: internal schema must reject the same invalid payload');
});

test('checkpoint retains its described, validation-equivalent input contract on the connector surface', async () => {
  const connectorTools = await registerConnectorSurface('cto');
  const internalTools = await registerInternalLane('cto');
  const connector = connectorTools['checkpoint'];
  const internal = internalTools['checkpoint'];
  assert.ok(connector?.inputSchema, 'checkpoint: connector schema must be registered');
  assert.ok(internal?.inputSchema, 'checkpoint: internal schema must be registered');
  const connectorShape = connector.inputSchema.shape;
  const internalShape = internal.inputSchema.shape;
  const valid = {
    agent: 'cto', memories: [{ kind: 'status', text: 'Non-sensitive test marker.' }], dry_run: false,
  };
  const invalid = {
    agent: 'cto',
    memories: Array.from({ length: 21 }, () => ({ kind: 'status', text: 'Over the fixed cap.' })),
    dry_run: false,
  };

  assert.deepEqual(Object.keys(connectorShape).sort(), Object.keys(internalShape).sort(), 'checkpoint: connector fields must not drift');
  for (const field of ['agent', 'summary', 'memories', 'dry_run', 'acknowledge_warning']) {
    const connectorField = connectorShape[field] as z.ZodTypeAny | undefined;
    const internalField = internalShape[field] as z.ZodTypeAny | undefined;
    assert.ok(connectorField?.description, 'checkpoint.' + field + ': connector field must retain guidance');
    assert.equal(connectorField?.description, internalField?.description, 'checkpoint.' + field + ': connector guidance must match the internal contract');
  }
  assert.equal(z.object(connectorShape).safeParse(valid).success, true, 'checkpoint: connector schema must accept a valid payload');
  assert.equal(z.object(internalShape).safeParse(valid).success, true, 'checkpoint: internal schema must accept the same valid payload');
  assert.equal(z.object(connectorShape).safeParse(invalid).success, false, 'checkpoint: connector schema must reject a 21-memory payload');
  assert.equal(z.object(internalShape).safeParse(invalid).success, false, 'checkpoint: internal schema must reject a 21-memory payload');
  assert.equal(connector.outputSchema, undefined, 'checkpoint: output schema must remain omitted from the connector surface');
  assert.equal(connector.title, undefined, 'checkpoint: outer title must remain omitted from the connector surface');
  assert.equal(connector.annotations?.title, undefined, 'checkpoint: annotation title must remain omitted from the connector surface');
  assert.deepEqual(
    connector.annotations,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    'checkpoint: connector annotations must retain their write contract',
  );
});

test('kill switch: CONNECTOR_ANNOTATIONS_MODE=off reverts the connector surface to the EXACT prior bare shape (no annotations key at all)', async () => {
  process.env.CONNECTOR_ANNOTATIONS_MODE = 'off';
  const tools = await registerConnectorSurface('cto');
  for (const name of ['brain_search', 'memory_write']) {
    const t = tools[name];
    assert.ok(t, `${name} should still be registered with the kill switch off`);
    assert.equal(t.annotations, undefined, `${name}: annotations must be entirely absent when the kill switch is off (the pre-fix shape)`);
    assert.equal(t.outputSchema, undefined);
    assert.equal(t.title, undefined);
    assert.ok(t.description, `${name}: description must still be present even with the kill switch off`);
  }
});

test('the internal (non-connector) lane is byte-identical regardless of CONNECTOR_ANNOTATIONS_MODE -- the flag only ever touches the connector-surface branch', async () => {
  delete process.env.CONNECTOR_ANNOTATIONS_MODE;
  const toolsDefault = await registerInternalLane('cto');
  process.env.CONNECTOR_ANNOTATIONS_MODE = 'off';
  const toolsOff = await registerInternalLane('cto');

  for (const name of ['brain_search', 'memory_write']) {
    for (const [label, tools] of [['default', toolsDefault], ['mode=off', toolsOff]] as const) {
      const t = tools[name];
      assert.ok(t, `${name} should be registered on the internal lane (${label})`);
      assert.ok(t.title, `${name}: internal lane must still carry the outer title (${label})`);
      assert.ok(t.outputSchema, `${name}: internal lane must still carry outputSchema (${label})`);
      assert.ok(t.annotations?.title, `${name}: internal lane must still carry annotations.title (${label})`);
      assert.equal(
        typeof t.annotations?.readOnlyHint,
        'boolean',
        `${name}: internal lane must still carry annotations.readOnlyHint (${label})`,
      );
    }
  }
});

test('COO connector exposes only the safe n8n credential-type schema read, not credential or workflow mutations', async () => {
  const coo = await registerConnectorSurface('coo');
  const schema = coo['n8n_credential_schema_get'];
  assert.ok(schema, 'COO Chat must receive the explicitly approved n8n credential-type schema read');
  assert.deepEqual(
    schema.annotations,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    'the schema endpoint must retain its real read-only connector annotations',
  );
  for (const forbidden of [
    'n8n_credential_list', 'n8n_credential_create', 'n8n_credential_delete',
    'n8n_create_workflow', 'n8n_update_workflow', 'n8n_run_workflow',
    'n8n_project_create', 'n8n_variable_create',
  ]) {
    assert.equal(coo[forbidden], undefined, `COO connector must not receive ${forbidden}`);
  }
  for (const lane of ['cro', 'wefunder-campaign-director', 'external-read', 'unknown']) {
    const tools = await registerConnectorSurface(lane);
    assert.equal(tools['n8n_credential_schema_get'], undefined, `${lane} must not receive the COO n8n schema read`);
  }
});
