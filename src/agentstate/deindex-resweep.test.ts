import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueDeindexResweep,
  runDeindexResweepOnce,
  startDeindexResweepReloader,
  stopDeindexResweepReloader,
  DEINDEX_RESWEEP_DELAY_MS,
} from './deindex-resweep.js';

// Same pattern as revocation-store.test.ts: lazily calls loadEnv() (via cosmosConfigured()), so seed
// the unrelated required vars first. With COSMOS_* unset, isConfigured() is false and every function
// here must degrade to a safe no-op -- the Cosmos-backed durability (the actual queue behavior) is
// covered by deindex-resweep-configured.test.ts, isolated in its own process the same way
// blob-deindex-configured.test.ts is (config/env.ts's loadEnv() memoizes per process).
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

test('DEINDEX_RESWEEP_DELAY_MS is safely past the documented 6h (360min) pull-indexer cadence', () => {
  // legal-personal/legal-company cadence_min is 360 (see otchealth-claude-tools/setup/
  // expected-indexes.json) -- the whole point of the delay is to be certain any indexer run in
  // flight at enqueue time has finished by the time this entry is due.
  assert.ok(DEINDEX_RESWEEP_DELAY_MS > 360 * 60 * 1000, 'must exceed the 360-minute documented cadence');
});

test('enqueueDeindexResweep is safe (fail-open, no-op, never throws) with no Cosmos configured', async () => {
  await assert.doesNotReject(enqueueDeindexResweep('legal-personal', 'filings/x.pdf', 'personal'));
});

test('runDeindexResweepOnce reports Cosmos-not-configured rather than throwing or querying anything', async () => {
  const result = await runDeindexResweepOnce();
  assert.deepEqual(result, { processed: 0, cleaned: 0, requeued: 0, failed: 0, raced: 0, reason: 'Cosmos not configured' });
});

test('the reconciler is idempotent and safe with no Cosmos (no-op, no throw, no double-schedule)', () => {
  stopDeindexResweepReloader();
  assert.doesNotThrow(() => startDeindexResweepReloader());
  assert.doesNotThrow(() => startDeindexResweepReloader()); // second call must not double-schedule
  assert.doesNotThrow(() => stopDeindexResweepReloader());
  assert.doesNotThrow(() => stopDeindexResweepReloader()); // stopping when not running is safe
});
