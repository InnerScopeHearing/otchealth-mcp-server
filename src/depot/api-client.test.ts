import '../test-helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listProjects, listBuilds, getUsage, DepotApiError } from './api-client.js';

// DEPOT_TOKEN is intentionally unset in the test env, so every Depot call must
// fail fast with a clear "not configured" error instead of making a network call.

test('depot client throws depot_not_configured when DEPOT_TOKEN is unset', async () => {
  await assert.rejects(
    () => listProjects(),
    (err: unknown) => {
      assert.ok(err instanceof DepotApiError);
      assert.equal((err as DepotApiError).code, 'depot_not_configured');
      assert.match((err as DepotApiError).nextStep, /DEPOT_TOKEN/);
      return true;
    },
  );
});

test('depot listBuilds without project id surfaces a config error (not a silent empty)', async () => {
  // Token missing fires first; either way the call must reject, never resolve empty.
  await assert.rejects(() => listBuilds({}), (err: unknown) => err instanceof DepotApiError);
});

test('depot getUsage rejects cleanly when unconfigured', async () => {
  await assert.rejects(() => getUsage({}), (err: unknown) => err instanceof DepotApiError);
});
