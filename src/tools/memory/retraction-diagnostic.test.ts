import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retractionAuthorityDiagnosticHandler } from './retraction-diagnostic.js';

const base = { callerAgent: 'cto', callerHash: 'hash', correlationId: 'corr' } as never;

test('CTO receives only fixed metadata from both healthy authorities', async () => {
  const result = await retractionAuthorityDiagnosticHandler({}, base, {
    read: async () => ({
      schema: 'retraction-authority-diagnostic.v1',
      shared_source: 'healthy',
      memory_source: 'healthy',
      cache_age_ms: 42,
      verified: true,
    }),
  });
  assert.deepEqual(result.data, {
    schema: 'retraction-authority-diagnostic.v1',
    shared_source: 'healthy',
    memory_source: 'healthy',
    cache_age_ms: 42,
    verified: true,
  });
  assert.equal(JSON.stringify(result).includes('supersedes'), false);
});

test('non-CTO callers are refused before the reader runs', async () => {
  let calls = 0;
  const result = await retractionAuthorityDiagnosticHandler({}, { ...base, callerAgent: 'developer' } as never, {
    read: async () => { calls++; throw new Error('must not run'); },
  });
  assert.deepEqual(result.data, { error: 'forbidden_role' });
  assert.equal(calls, 0);
});

test('partial authority is explicit and does not expose source errors', async () => {
  const result = await retractionAuthorityDiagnosticHandler({}, base, {
    read: async () => ({
      schema: 'retraction-authority-diagnostic.v1',
      shared_source: 'error',
      memory_source: 'healthy',
      cache_age_ms: 0,
      verified: false,
    }),
  });
  assert.equal((result.data as any).verified, false);
  assert.equal(JSON.stringify(result).includes('provider-secret'), false);
});
