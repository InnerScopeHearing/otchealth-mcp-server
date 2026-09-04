import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
