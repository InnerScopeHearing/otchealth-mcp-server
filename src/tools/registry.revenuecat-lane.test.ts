import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectorToolset, registerTool } from './registry.js';
import { loadEnv } from '../config/env.js';
import { requestContext } from '../server/request-context.js';
import { registerRevenueCatEntitlementCreate } from './revenuecat/entitlement-create.js';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

before(() => {
  process.env.ENABLE_WRITE_TOOLS = 'true';
  process.env.READ_ONLY_MODE = 'false';
  process.env.ENABLE_HIGH_RISK_TOOLS = 'true';
  process.env.DRY_RUN_DEFAULT = 'true';
  for (const [name, value] of Object.entries({
    CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32), N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  })) process.env[name] ??= value;
});

test('real orchestrated entitlement catalog handler admits bound Developer previews and preserves risk and role gates', async () => {
  const config = loadEnv();
  const previousHighRisk = config.ENABLE_HIGH_RISK_TOOLS;
  const previousDispatcher = getGlobalDispatcher();
  const network = new MockAgent();
  network.disableNetConnect();
  setGlobalDispatcher(network);
  const previous = { map: process.env.REVENUECAT_PROJECT_KEY_ENV_JSON, key: process.env.REVENUECAT_PROJECT_KEY_AWARE, high: process.env.ENABLE_HIGH_RISK_TOOLS };
  process.env.REVENUECAT_PROJECT_KEY_ENV_JSON = JSON.stringify({ proja2cc4776: 'REVENUECAT_PROJECT_KEY_AWARE' });
  process.env.REVENUECAT_PROJECT_KEY_AWARE = 'sk_synthetic_aware_only';
  try {
    type Handler = (args: Record<string, unknown>) => Promise<any>;
    let handler: Handler | undefined;
    const register = () => {
      const server = { registerTool(_name: string, _config: unknown, candidate: Handler) { handler = candidate; return { remove() {} }; } } as unknown as McpServer;
      registerRevenueCatEntitlementCreate(server, () => 'rc-real-entitlement-fixture');
      assert.ok(handler);
    };
    const invoke = (callerAgent: string, project_id = 'proja2cc4776', dry_run?: boolean) => requestContext.run({ callerHash: 'rc-real-entitlement-fixture', correlationId: 'rc-real-entitlement-fixture', callerAgent },
      () => handler!({ project_id, lookup_key: 'synthetic_entitlement', dry_run }));
    process.env.ENABLE_HIGH_RISK_TOOLS = 'true';
    register();
    const preview = await invoke('developer');
    assert.notEqual(preview.isError, true, JSON.stringify(preview));
    assert.equal(preview.structuredContent?.result?.executed, false);
    assert.equal(preview.structuredContent?.result?.dry_run, true, 'default preview must not perform a provider write');
    assert.equal((await invoke('developer', 'unbound_project')).structuredContent?.error?.code, 'revenuecat_project_not_authorized');
    assert.equal((await invoke('cro')).structuredContent?.error?.code, 'forbidden_role', 'existing unrelated role restriction stays');
    process.env.ENABLE_HIGH_RISK_TOOLS = 'false';
    // loadEnv is cached per process. Exercise the actual gate using its test-owned config,
    // rather than changing only process.env and accidentally leaving the cached switch true.
    config.ENABLE_HIGH_RISK_TOOLS = false;
    register();
    assert.equal((await invoke('developer', 'proja2cc4776', false)).structuredContent?.error?.code, 'write_disabled', 'do not bypass the existing high-risk switch for an actual write');
  } finally {
    config.ENABLE_HIGH_RISK_TOOLS = previousHighRisk;
    setGlobalDispatcher(previousDispatcher);
    await network.close();
    for (const [name, value] of Object.entries({ REVENUECAT_PROJECT_KEY_ENV_JSON: previous.map, REVENUECAT_PROJECT_KEY_AWARE: previous.key, ENABLE_HIGH_RISK_TOOLS: previous.high })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

const reads = ['list_projects', 'project_get', 'app_list', 'app_get', 'product_list', 'product_get',
  'offering_list', 'offering_get', 'package_list', 'package_get', 'entitlement_list', 'entitlement_get'].map(n => `revenuecat_${n}`);
const writes = ['product_create', 'product_update', 'offering_create', 'offering_update',
  'package_create', 'package_update', 'entitlement_create', 'entitlement_update'].map(n => `revenuecat_${n}`);

test('CTO receives exact catalog readers and Developer receives only bounded catalog writes', () => {
  const env = loadEnv();
  for (const name of reads) {
    assert.equal(connectorToolset(env, 'cto').has(name), true, name);
    assert.equal(connectorToolset(env, 'developer').has(name), true, name);
  }
  for (const name of writes) {
    assert.equal(connectorToolset(env, 'developer').has(name), true, name);
    assert.equal(connectorToolset(env, 'cto').has(name), false, name);
    for (const lane of ['coo', 'cfo', 'clo', 'clo-personal', 'cpo', 'cco', 'exec', 'external-read']) {
      assert.equal(connectorToolset(env, lane).has(name), false, `${lane}:${name}`);
    }
  }
  for (const name of ['customer_create', 'product_delete', 'grant_entitlement', 'revoke_entitlement', 'subscription_revoke_apple']) {
    assert.equal(connectorToolset(env, 'developer').has(`revenuecat_${name}`), false, name);
  }
  const overridden = { ...env, CONNECTOR_TOOLSET: 'brain_search' };
  for (const lane of ['cto', 'developer']) for (const name of [...reads, ...writes]) {
    assert.equal(connectorToolset(overridden, lane).has(name), false, `${lane}:${name}`);
  }
});

test('actual registered execution refuses Developer unbound and non-catalog operations before handler', async () => {
  const previous = { map: process.env.REVENUECAT_PROJECT_KEY_ENV_JSON, key: process.env.REVENUECAT_PROJECT_KEY_AWARE, global: process.env.REVENUECAT_API_KEY };
  process.env.REVENUECAT_PROJECT_KEY_ENV_JSON = JSON.stringify({ proja2cc4776: 'REVENUECAT_PROJECT_KEY_AWARE' });
  process.env.REVENUECAT_PROJECT_KEY_AWARE = 'sk_synthetic_aware_only';
  process.env.REVENUECAT_API_KEY = 'sk_synthetic_global_only';
  try {
    type Handler = (args: Record<string, unknown>) => Promise<any>;
    let calls = 0;
    let handler: Handler | undefined;
    const register = (name: string, canonicalName?: string) => {
      const server = { registerTool(_name: string, _config: unknown, candidate: Handler) { handler = candidate; return { remove() {} }; } } as unknown as McpServer;
      registerTool(server, {
        name, canonicalName, category: 'write_simple',
        annotations: { title: 'Synthetic RC gate', description: 'Synthetic admission test', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputShape: { project_id: z.string().optional() }, outputShape: { admitted: z.boolean() },
        handler: async () => { calls++; return { data: { admitted: true } }; },
      }, () => 'rc-admission-fixture');
      assert.ok(handler);
    };
    const invoke = (project_id?: string) => requestContext.run({ callerHash: 'rc-admission-fixture', correlationId: 'rc-admission-fixture', callerAgent: 'developer' },
      () => handler!({ project_id, dry_run: true }));
    register('revenuecat_product_create');
    assert.notEqual((await invoke('proja2cc4776')).isError, true);
    assert.equal(calls, 1);
    for (const project of ['proj_other', undefined]) {
      assert.equal((await invoke(project)).structuredContent?.error?.code, 'revenuecat_project_not_authorized');
      assert.equal(calls, 1);
    }
    delete process.env.REVENUECAT_PROJECT_KEY_AWARE;
    assert.equal((await invoke('proja2cc4776')).structuredContent?.error?.code, 'revenuecat_project_not_authorized');
    assert.equal(calls, 1, 'missing bound key must not use global fallback');
    process.env.REVENUECAT_PROJECT_KEY_AWARE = 'sk_synthetic_aware_only';
    for (const name of ['revenuecat_customer_create', 'revenuecat_product_delete', 'revenuecat_grant_entitlement', 'revenuecat_set_subscriber_attributes', 'revenuecat_future_mutation']) {
      register(name);
      assert.equal((await invoke('proja2cc4776')).structuredContent?.error?.code, 'revenuecat_operation_not_authorized', name);
      assert.equal(calls, 1, name);
    }
    register('product_delete', 'revenuecat_product_delete');
    assert.equal((await invoke('proja2cc4776')).structuredContent?.error?.code, 'revenuecat_operation_not_authorized', 'canonical alias cannot bypass');
    assert.equal(calls, 1);
  } finally {
    for (const [name, value] of Object.entries({ REVENUECAT_PROJECT_KEY_ENV_JSON: previous.map, REVENUECAT_PROJECT_KEY_AWARE: previous.key, REVENUECAT_API_KEY: previous.global })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
