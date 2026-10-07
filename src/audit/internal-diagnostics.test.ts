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

test('workflow-run diagnostic projection accepts only a bounded status or fixed field name', () => {
  const errorFor = (stage: string, detail: unknown) => ({
    name: 'PinnedObservationReaderError',
    code: 'github_observation_receipt_unverified',
    message: 'The pinned GraphRAG observation receipt could not be verified.',
    internalDiagnostic: {
      type: 'github_observation_receipt',
      stage,
      detail,
      responseBody: 'synthetic-error-body-must-not-leak',
      token: 'synthetic-token-must-not-leak',
    },
  });

  const status = projectPinnedObservationDiagnostic(
    errorFor('workflow_run_metadata', {
      kind: 'http_status',
      status: 403,
      responseBody: 'synthetic-nested-body-must-not-leak',
      token: 'synthetic-nested-token-must-not-leak',
    }),
    'github_graphrag_observation_receipt_get',
    'cto',
    'synthetic-correlation',
  );
  assert.deepEqual(status, {
    type: 'github_observation_receipt',
    stage: 'workflow_run_metadata',
    correlation_id: 'synthetic-correlation',
    detail: { kind: 'http_status', status: 403 },
  });

  const field = projectPinnedObservationDiagnostic(
    errorFor('workflow_run_metadata', { kind: 'run_metadata_field', field: 'head_repository.id' }),
    'github_graphrag_observation_receipt_get',
    'cto',
    'synthetic-correlation',
  );
  assert.deepEqual(field, {
    type: 'github_observation_receipt',
    stage: 'workflow_run_metadata',
    correlation_id: 'synthetic-correlation',
    detail: { kind: 'run_metadata_field', field: 'head_repository.id' },
  });

  assert.equal(JSON.stringify(status).includes('synthetic-error-body-must-not-leak'), false);
  assert.equal(JSON.stringify(status).includes('synthetic-nested-body-must-not-leak'), false);
  assert.equal(JSON.stringify(status).includes('synthetic-token-must-not-leak'), false);
  assert.equal(projectPinnedObservationDiagnostic(
    errorFor('workflow_run_metadata', { kind: 'http_status', status: 600 }),
    'github_graphrag_observation_receipt_get',
    'cto',
    'synthetic-correlation',
  ), null);
  assert.equal(projectPinnedObservationDiagnostic(
    errorFor('workflow_run_metadata', { kind: 'run_metadata_field', field: 'provider_metadata' }),
    'github_graphrag_observation_receipt_get',
    'cto',
    'synthetic-correlation',
  ), null);
  assert.equal(projectPinnedObservationDiagnostic(
    errorFor('archive_digest', { kind: 'http_status', status: 403 }),
    'github_graphrag_observation_receipt_get',
    'cto',
    'synthetic-correlation',
  ), null);
  assert.equal(projectPinnedObservationDiagnostic(
    errorFor('workflow_run_metadata', { kind: 'http_status', status: 403 }),
    'github_graphrag_observation_receipt_get',
    'developer',
    'synthetic-correlation',
  ), null);
});
