import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COO_INTERCOM_CONNECTOR_TOOLSET,
  connectorToolset,
} from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { projectCallerSurfaceTools } from './list-tools.js';

const service = (names: string[]) => [{ service: 'intercom', tools: names.map((name) => ({ name })) }];

test('COO projection reports 13 callable Intercom tools without changing the 72-tool registry inventory', () => {
  assert.equal(COO_INTERCOM_CONNECTOR_TOOLSET.length, 13);
  const globalNames = [
    ...COO_INTERCOM_CONNECTOR_TOOLSET,
    ...Array.from({ length: 59 }, (_, index) => `intercom_registry_only_${index}`),
  ];
  const services = service(globalNames);
  const before = structuredClone(services);
  const result = projectCallerSurfaceTools(
    services,
    true,
    connectorToolset(loadEnv(), 'coo'),
  );

  assert.equal(globalNames.length, 72);
  assert.equal(result.mode, 'connector_allowlist');
  assert.equal(result.tools.length, 13);
  assert.deepEqual(result.tools, [...COO_INTERCOM_CONNECTOR_TOOLSET]);
  assert.deepEqual(services, before);
});

test('external and unknown connector lanes expose only their allowlist intersection', () => {
  const services = service([
    'brain_search',
    'intercom_team_list',
    'github_create_branch',
    'catalog_list_tools',
  ]);
  const result = projectCallerSurfaceTools(services, true, new Set(['brain_search', 'catalog_list_tools']));

  assert.equal(result.mode, 'connector_allowlist');
  assert.deepEqual(result.tools, ['brain_search', 'catalog_list_tools']);
});

test('CTO ship lane projection is distinct from external projection', () => {
  const services = service(['github_create_branch', 'brain_search', 'intercom_team_list']);
  const env = loadEnv();
  const ship = projectCallerSurfaceTools(services, true, connectorToolset(env, 'cto'));
  const external = projectCallerSurfaceTools(services, true, connectorToolset(env, 'unknown'));

  assert.equal(ship.mode, 'connector_allowlist');
  assert.equal(external.mode, 'connector_allowlist');
  assert.equal(ship.tools.includes('github_create_branch'), true);
  assert.equal(external.tools.includes('github_create_branch'), false);
});

test('non-connector callers retain the complete listed inventory', () => {
  const services = service(['intercom_team_list', 'intercom_contact_get', 'catalog_list_tools']);
  const result = projectCallerSurfaceTools(services, false);

  assert.equal(result.mode, 'full');
  assert.deepEqual(result.tools, services[0].tools.map((tool) => tool.name));
});

test('service filtering remains caller-local and does not invent tools', () => {
  const services = service(['intercom_team_list', 'intercom_ticket_type_list']);
  const result = projectCallerSurfaceTools(services, true, new Set(['intercom_team_list']));

  assert.deepEqual(result.tools, ['intercom_team_list']);
});
