import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { connectorToolset, CTO_SHIP_LANE_TOOLSET } from './registry.js';
import { loadEnv, type Env } from '../config/env.js';

// github_workflow_run_failed_log_excerpt returns CI job log text, so it is CTO-only on every surface:
// advertised on the CTO connector lane alone, refused by governance and by its own handler for
// everyone else. (The CTO's exact-set assertion lives in registry.connector-lanes.test.ts.)
const TOOL = 'github_workflow_run_failed_log_excerpt';

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

test('the failed-step CI log excerpt reader is advertised only to the CTO connector lane', () => {
  assert.equal(CTO_SHIP_LANE_TOOLSET.includes(TOOL), false, 'CTO-only reader must not be in the shared ship set');
  assert.equal(connectorToolset(loadEnv(), 'cto').has(TOOL), true);
  for (const lane of ['developer', 'cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'exec', 'external-read']) {
    assert.equal(connectorToolset(loadEnv(), lane).has(TOOL), false, lane);
  }
  const overridden = { ...loadEnv(), CONNECTOR_TOOLSET: 'brain_search' } as Env;
  assert.equal(connectorToolset(overridden, 'cto').has(TOOL), false, 'an explicit CONNECTOR_TOOLSET override keeps its exact meaning');
});
