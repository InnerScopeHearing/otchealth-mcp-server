import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { LANE_TOOLSETS, isToolInLaneAllowlist } from '../config/lane-toolsets.js';
import { loadEnv, type Env } from '../config/env.js';
import {
  connectorToolset,
  CRO_CONNECTOR_TOOLSET,
  DEVELOPER_SETUP_TOOLSET,
  EXTERNAL_READONLY_TOOLSET,
} from './registry.js';

const DEPOT_SETUP_TOOLS = [
  'depot_list_projects', 'depot_project_get', 'depot_workflow_list',
  'depot_run_list', 'depot_run_get', 'depot_run_status_get', 'depot_run_metrics_get',
] as const;

const REVENUECAT_SETUP_TOOLS = [
  'revenuecat_list_projects', 'revenuecat_project_get',
  'revenuecat_app_list', 'revenuecat_app_get',
  'revenuecat_offering_list', 'revenuecat_offering_get',
  'revenuecat_product_list', 'revenuecat_product_get',
  'revenuecat_package_list', 'revenuecat_package_get',
  'revenuecat_entitlement_list', 'revenuecat_entitlement_get',
] as const;

const REVENUECAT_CATALOG_WRITES = [
  'revenuecat_product_create', 'revenuecat_product_update',
  'revenuecat_offering_create', 'revenuecat_offering_update',
  'revenuecat_package_create', 'revenuecat_package_update',
  'revenuecat_entitlement_create', 'revenuecat_entitlement_update',
] as const;

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [key, value] of Object.entries(required)) process.env[key] ??= value;
});

function defaultConnectorEnv(): Env {
  return { ...loadEnv(), CONNECTOR_TOOLSET: '' };
}

test('default Developer connector exposes exact setup metadata and bounded RevenueCat catalog writes', () => {
  assert.deepEqual(DEVELOPER_SETUP_TOOLSET, ['developer_task_rollup', ...DEPOT_SETUP_TOOLS, ...REVENUECAT_SETUP_TOOLS, ...REVENUECAT_CATALOG_WRITES]);
  const tools = connectorToolset(defaultConnectorEnv(), 'developer');
  for (const name of DEVELOPER_SETUP_TOOLSET) assert.equal(tools.has(name), true, name);

  for (const name of [
    'depot_project_create', 'depot_project_delete', 'depot_token_create', 'depot_token_list',
    'revenuecat_customer_get', 'revenuecat_customer_list', 'revenuecat_subscriber_get_v1',
    'revenuecat_customer_create', 'revenuecat_customer_delete',
    'revenuecat_entitlement_delete', 'revenuecat_product_delete', 'revenuecat_package_delete',
    'revenuecat_grant_entitlement', 'revenuecat_revoke_entitlement', 'revenuecat_subscription_revoke_apple',
  ]) assert.equal(tools.has(name), false, `${name} must not be added to Developer setup visibility`);
});

test('explicit CONNECTOR_TOOLSET override stays authoritative for Developer setup tools', () => {
  const overridden = { ...defaultConnectorEnv(), CONNECTOR_TOOLSET: 'brain_search' } as Env;
  const tools = connectorToolset(overridden, 'developer');
  assert.equal(tools.has('brain_search'), true);
  for (const name of DEVELOPER_SETUP_TOOLSET) assert.equal(tools.has(name), false, name);
});

test('Developer RevenueCat M365 seed uses the same exact metadata and bounded catalog names', () => {
  for (const name of [...REVENUECAT_SETUP_TOOLS, ...REVENUECAT_CATALOG_WRITES]) {
    assert.equal(isToolInLaneAllowlist('developer', name), true, name);
    assert.ok((LANE_TOOLSETS.developer as readonly string[]).includes(name), `${name} must be explicit in the M365 seed`);
  }
  for (const name of [
    'revenuecat_customer_get', 'revenuecat_customer_list', 'revenuecat_subscriber_get_v1',
    'revenuecat_entitlement_delete', 'revenuecat_product_delete', 'revenuecat_api_key_list',
    'revenuecat_grant_entitlement', 'revenuecat_revoke_entitlement', 'revenuecat_subscription_revoke_apple',
  ]) assert.equal(isToolInLaneAllowlist('developer', name), false, name);
});

test('other connector roles keep their existing Depot and RevenueCat curation', () => {
  const env = defaultConnectorEnv();
  const cfo = connectorToolset(env, 'cfo');
  const cro = connectorToolset(env, 'cro');
  const external = connectorToolset(env, 'external-read');

  for (const name of DEPOT_SETUP_TOOLS) {
    assert.equal(cfo.has(name), false, `CFO must not gain ${name}`);
    assert.equal(cro.has(name), false, `CRO must not gain ${name}`);
    assert.equal(external.has(name), false, `external must not gain ${name}`);
  }
  assert.equal(cro.has('revenuecat_offering_list'), true, 'preserve existing CRO RevenueCat offering visibility');
  assert.equal(cro.has('revenuecat_product_list'), true, 'preserve existing CRO RevenueCat product visibility');
  assert.deepEqual([...external].sort(), [...EXTERNAL_READONLY_TOOLSET].sort());
  for (const name of CRO_CONNECTOR_TOOLSET) assert.equal(cro.has(name), true, name);
});
