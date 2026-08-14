import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- see opensearch-unconfigured.test.ts's header for why (loadEnv() caching).
// This scenario: OPENSEARCH_ENDPOINT is set, NO explicit AWS_ACCESS_KEY_ID/SECRET, but the ECS
// task-role container-credentials env IS present -- the "configured via the ECS fallback signal"
// branch of searchConfigured().
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.OPENSEARCH_ENDPOINT ||= 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/fake-task-role';

const { searchConfigured } = await import('./opensearch.js');

test('searchConfigured: true when the endpoint is set and no explicit keys, but the ECS container-credentials env is present', () => {
  assert.equal(searchConfigured(), true);
});
