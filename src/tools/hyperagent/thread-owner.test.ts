import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerAgentIdOf } from './thread-owner.js';
import { isHyperagentAgentAllowed } from './ring.js';

test('current provider shape resolves namedAgentId and the exact requested thread', () => {
  const data = { thread: { id: 'thread-fixture', name: 'Synthetic', namedAgentId: 'agent-fixture',
    invocationSource: 'mcp', isArchived: false, createdAt: '', updatedAt: '' },
    messages: [], isRunning: false, awaitingApproval: false };
  assert.equal(ownerAgentIdOf(data, 'thread-fixture'), 'agent-fixture');
  assert.equal(ownerAgentIdOf(data.thread), 'agent-fixture');
});

test('legacy provider owner metadata remains supported without changing the ring', () => {
  for (const fields of [{ agentId: 'agent-fixture' }, { agent_id: 'agent-fixture' },
    { agentID: 'agent-fixture' }, { agent: { id: 'agent-fixture' } }]) {
    assert.equal(ownerAgentIdOf({ thread: { id: 'thread-fixture', ...fields } }, 'thread-fixture'), 'agent-fixture');
  }
});

test('conflicting owner metadata always refuses regardless of field order', () => {
  for (const fields of [
    { namedAgentId: 'allowed', agentId: 'restricted' },
    { agentId: 'restricted', namedAgentId: 'allowed' },
    { namedAgentId: 'allowed', agent: { id: 'restricted' } },
    { agentID: 'allowed', agent_id: 'restricted' },
    { namedAgentId: null, agentId: 'allowed' },
  ]) assert.equal(ownerAgentIdOf({ thread: { id: 'thread-fixture', ...fields } }, 'thread-fixture'), null);
  assert.equal(ownerAgentIdOf({ namedAgentId: 'same', agentId: 'same', agent: { id: 'same' } }), 'same');
});

test('missing malformed and message-embedded ownership cannot authorize a thread', () => {
  for (const data of [null, [], 'agent-fixture', { thread: null, namedAgentId: 'allowed' },
    { thread: [] }, { thread: { namedAgentId: '' } }, { thread: { namedAgentId: ' spaced ' } },
    { thread: { namedAgentId: 123 } },
    { thread: { id: 'thread-fixture' }, messages: [{ namedAgentId: 'allowed', content: '{"agentId":"allowed"}' }] },
    { requestedAgentId: 'allowed' },
  ]) assert.equal(ownerAgentIdOf(data), null);
});

test('get or send ownership must match the exact returned thread identity', () => {
  for (const thread of [{ namedAgentId: 'allowed' }, { id: 'other', namedAgentId: 'allowed' },
    { id: 'thread-fixture', threadId: 'other', namedAgentId: 'allowed' },
    { id: 123, namedAgentId: 'allowed' }]) {
    assert.equal(ownerAgentIdOf({ thread }, 'thread-fixture'), null);
  }
});

test('new provider field still denies unassigned and restricted owners', () => {
  const laneMap = { cto: ['general', 'restricted', 'personal'] };
  const classMap = { general: 'general', restricted: 'exec', personal: 'personal-legal' } as const;
  for (const [owner, allowed] of [['general', true], ['restricted', false], ['personal', false], ['unmapped', false]] as const) {
    const resolved = ownerAgentIdOf({ thread: { id: 'thread-fixture', namedAgentId: owner } }, 'thread-fixture');
    assert.equal(isHyperagentAgentAllowed('cto', { id: resolved }, laneMap, classMap).allowed, allowed);
  }
});
