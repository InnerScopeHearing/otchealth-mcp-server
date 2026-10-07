import { test } from 'node:test';
import assert from 'node:assert/strict';

// The dispatcher must never let the dead-letter audit flag fall through to a live Azure read: with
// the default ack=true that would DRAIN real messages instead of auditing them. Own file (own
// `node --test` process) because loadEnv() memoizes the STATE_BACKEND chosen here.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.STATE_BACKEND = 'cosmos';

const { readMessages } = await import('./queue.js');

test('a dead-letter audit on a non-Postgres backend returns [] without touching the live queue', async () => {
  assert.deepEqual(await readMessages('cto', { deadLetter: true }), []);
  assert.deepEqual(await readMessages('cto', { deadLetter: true, ack: true }), []);
});
