import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPinnedObservationDiagnostic } from './internal-diagnostics.js';

test('pinned observation diagnostic projection is CTO-only, allowlisted, and drops raw metadata', () => {
  const error = {
    name: 'PinnedObservationReaderError',
    code: 'github_observation_receipt_unverified',
    message: 'The pinned GraphRAG observation receipt could not be verified.',
    internalDiagnostic: {
      type: 'github_observation_receipt',
      stage: 'archive_digest',
      providerMetadata: 'synthetic-provider-metadata-must-not-leak',
      signedUrl: 'https://example.invalid/?sig=synthetic-secret',
      token: 'synthetic-token',
    },
  };

  const projected = projectPinnedObservationDiagnostic(error, 'github_graphrag_observation_receipt_get', 'cto', 'synthetic-correlation');
  assert.deepEqual(projected, {
    type: 'github_observation_receipt',
    stage: 'archive_digest',
    correlation_id: 'synthetic-correlation',
  });
  assert.equal(JSON.stringify(projected).includes('synthetic-provider-metadata-must-not-leak'), false);
  assert.equal(JSON.stringify(projected).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(projected).includes('synthetic-token'), false);
  assert.equal(projectPinnedObservationDiagnostic(error, 'github_graphrag_observation_receipt_get', 'developer', 'synthetic-correlation'), null);
  assert.equal(projectPinnedObservationDiagnostic({
    ...error,
    name: 'PinnedObservationReaderError',
  }, 'github_repository_get', 'cto', 'synthetic-correlation'), null, 'a forged matching error from another canonical tool must not expose the stage');
  assert.equal(projectPinnedObservationDiagnostic({
    ...error,
    internalDiagnostic: { type: 'github_observation_receipt', stage: 'provider-response-body' },
  }, 'github_graphrag_observation_receipt_get', 'cto', 'synthetic-correlation'), null);
  assert.equal(projectPinnedObservationDiagnostic({
    ...error,
    name: 'Error',
  }, 'github_graphrag_observation_receipt_get', 'cto', 'synthetic-correlation'), null);
});
