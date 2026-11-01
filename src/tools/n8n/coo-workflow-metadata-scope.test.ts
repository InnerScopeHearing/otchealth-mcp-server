import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizedCooWorkflowMetadataIds, parseCooWorkflowMetadataAllowlist } from './coo-workflow-metadata-scope.js';

test('COO workflow allowlist accepts bounded exact IDs', () => {
  assert.deepEqual(parseCooWorkflowMetadataAllowlist('w_1, w-2'), ['w_1', 'w-2']);
  assert.equal(parseCooWorkflowMetadataAllowlist(Array.from({ length: 25 }, (_, i) => `w${i}`).join(',')).length, 25);
});

test('COO workflow allowlist rejects missing, empty, malformed, duplicate, and excessive values', () => {
  for (const input of [undefined, '', 'w1,', 'w1,w1', 'bad/id', Array.from({ length: 26 }, (_, i) => `w${i}`).join(',')]) {
    assert.throws(() => parseCooWorkflowMetadataAllowlist(input), { message: 'coo_workflow_allowlist_invalid' });
  }
});

test('authorized COO IDs come only from the dedicated process environment setting', () => {
  const previous = process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST;
  try {
    process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST = 'coo-1,coo-2';
    assert.deepEqual([...authorizedCooWorkflowMetadataIds()], ['coo-1', 'coo-2']);
    delete process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST;
    assert.throws(() => authorizedCooWorkflowMetadataIds(), { message: 'coo_workflow_allowlist_invalid' });
  } finally {
    if (previous === undefined) delete process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST;
    else process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST = previous;
  }
});
