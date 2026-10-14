import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertionRecordSchema,
  memoryContextPolicySchema,
  memoryPurposeMetadataSchema,
  memoryTypeSchema,
} from './contracts.js';

const at = '2026-09-13T12:00:00.000Z';

test('memory purpose is explicit supplied metadata across the bounded taxonomy', () => {
  const purposes = ['source_assertion', 'preference', 'decision', 'correction', 'task_state', 'operational_exhaust'];
  for (const purpose of purposes) {
    assert.equal(memoryPurposeMetadataSchema.safeParse({ purpose, declaredBy: 'actor-1', declaredAt: at }).success, true);
  }
  assert.equal(memoryPurposeMetadataSchema.safeParse({ purpose: 'provider_fact', declaredBy: 'actor-1', declaredAt: at }).success, false);
  assert.equal(memoryPurposeMetadataSchema.safeParse({ purpose: 'decision', declaredAt: at }).success, false);
  assert.deepEqual(memoryTypeSchema.options, ['session_note', 'preference', 'procedure', 'assertion', 'decision']);
});

test('context policy retains required decisions and audit references within a role budget', () => {
  const policy = {
    role: 'support', tokenBudget: 2_000,
    requiredDecisionIds: ['decision-1'], includedDecisionIds: ['decision-1', 'decision-2'],
    retainedAuditRefs: ['audit-1'],
  };
  assert.equal(memoryContextPolicySchema.safeParse(policy).success, true);
  assert.equal(memoryContextPolicySchema.safeParse({ ...policy, includedDecisionIds: ['decision-2'] }).success, false);
  assert.equal(memoryContextPolicySchema.safeParse({ ...policy, tokenBudget: 0 }).success, false);
  assert.equal(memoryContextPolicySchema.safeParse({ ...policy, requiredDecisionIds: ['decision-1', 'decision-1'] }).success, false);
});

test('purpose metadata does not change the existing assertion record contract', () => {
  const assertion = {
    contractVersion: 'brain.contract.v1', assertionId: 'assertion-1', recordVersion: 'v1',
    actorId: 'actor-1', tenantId: 'tenant-1', sourceGeneration: 'generation-1', memoryType: 'assertion',
    lifecycle: 'active', statement: 'Synthetic fixture.', validTime: { basis: 'unknown', start: null, end: null },
    recordedAt: at, recordedUntil: null, authorization: [{ name: 'internal', policyVersion: 'v1' }], evidence: [], status: 'unknown',
  };
  assert.equal(assertionRecordSchema.safeParse(assertion).success, true);
  assert.equal(assertionRecordSchema.safeParse({ ...assertion, purpose: { purpose: 'decision', declaredBy: 'actor-1', declaredAt: at } }).success, false);
});
