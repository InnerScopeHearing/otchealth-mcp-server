import assert from 'node:assert/strict';
import test from 'node:test';
import { queryDurableHistories } from '../../src/server/relationship-query/durable-query.mjs';

for (const [key, value] of Object.entries({
  CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-placeholder-value-000000000',
  ADMIN_REVOKE_TOKEN: 'synthetic-placeholder-value-000000000',
  N8N_WEBHOOK_SECRET: 'synthetic-placeholder-value-000000000',
})) process.env[key] ??= value;

test('local fixture yields a replayable accepted typed relationship claim', async () => {
  const { createLocalBrainAssertionFixture } = await import('./brain-assertion-local-fixture.mjs');
  const fixture = createLocalBrainAssertionFixture();
  assert.equal(fixture.original.accepted, true);
  assert.equal(fixture.original.assertion.semantic_intent.support.kind, 'verified_fact');
  assert.doesNotThrow(() => queryDurableHistories({ entries: [fixture.entry], query: { kind: 'candidate_links', include_stale: true, limit: 1 }, now: () => Date.parse('2026-09-14T00:00:00.000Z') }));
});
