import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- see opensearch-unconfigured.test.ts's header for why (loadEnv() caching).
// This scenario: OPENSEARCH_ENDPOINT is set, but NO credential signal of any kind is present (no
// explicit AWS keys, no ECS container-credentials env) -- searchConfigured() must be false, since
// resolveAwsCredentials() would have nothing to resolve at call time.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.OPENSEARCH_ENDPOINT ||= 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;

const { searchConfigured } = await import('./opensearch.js');

test('searchConfigured: false when the endpoint is set but no credential signal of any kind is present', () => {
  assert.equal(searchConfigured(), false);
});
