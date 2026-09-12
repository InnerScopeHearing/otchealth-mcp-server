import assert from 'node:assert/strict';
import test from 'node:test';
import { filterPersonalSharedMemory, sharedMemoryAgentAllowed } from './shared-memory-access.js';

const rows = [
  { id: 'company', agent: 'clo', text: 'synthetic company fixture' },
  { id: 'personal', agent: 'clo-personal', text: 'synthetic personal fixture' },
];

test('corporate CLO cannot select or receive personal shared-memory rows', () => {
  assert.equal(sharedMemoryAgentAllowed('clo', 'clo-personal'), false);
  assert.deepEqual(filterPersonalSharedMemory(rows, 'clo').map((row) => row.id), ['company']);
});

test('personal-ring callers retain their own explicitly authorized rows', () => {
  for (const caller of ['clo-personal', 'exec']) {
    assert.equal(sharedMemoryAgentAllowed(caller, 'clo-personal'), true);
    assert.deepEqual(filterPersonalSharedMemory(rows, caller).map((row) => row.id), ['company', 'personal']);
  }
});

test('anonymous shared-memory responses exclude historical personal rows', () => {
  assert.deepEqual(filterPersonalSharedMemory(rows, undefined).map((row) => row.id), ['company']);
});
