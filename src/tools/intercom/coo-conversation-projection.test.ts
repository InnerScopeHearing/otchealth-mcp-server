import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext } from '../../server/request-context.js';
import {
  assertCooChatConversationSearchInput,
  projectIntercomConversationForCooChat,
  projectIntercomConversationsForCooChat,
} from './coo-conversation-projection.js';

function withContext<T>(callerAgent: string, connectorSurface: boolean, fn: () => T): T {
  return requestContext.run({
    callerHash: 'synthetic-caller',
    correlationId: 'synthetic-correlation',
    callerAgent,
    connectorSurface,
  }, fn);
}

const richConversation = {
  id: '215400000000001',
  title: '[SYNTHETIC QA CS-QA-20261002-01] do not expose this subject',
  state: 'open',
  created_at: 100,
  updated_at: 300,
  admin_assignee_id: 111,
  team_assignee_id: 222,
  ai_agent_participated: false,
  source: {
    subject: 'private subject',
    body: 'private body',
    author: { email: 'hidden@example.invalid', name: 'Hidden Customer' },
  },
  contacts: { contacts: [{ id: 'private-contact' }] },
  tags: {
    tags: [
      { name: 'product-support' },
      { name: 'safety-escalation' },
      { name: 'customer-free-text-tag' },
    ],
  },
  statistics: {
    last_contact_reply_at: 250,
    last_admin_reply_at: 200,
    last_close_at: null,
    count_conversation_parts: 7,
  },
  conversation_parts: { conversation_parts: [{ body: 'private message' }] },
};

test('COO connector receives only operational conversation metadata', () => {
  withContext('coo', true, () => {
    assert.deepEqual(projectIntercomConversationForCooChat(richConversation), {
      id: '215400000000001',
      state: 'open',
      created_at: 100,
      updated_at: 300,
      admin_assignee_id: '111',
      team_assignee_id: '222',
      needs_response: true,
      waiting_since: 250,
      last_customer_reply_at: 250,
      last_admin_reply_at: 200,
      last_close_at: null,
      count_conversation_parts: 7,
      ai_agent_participated: false,
      synthetic_test: true,
      operational_tags: ['product-support', 'safety-escalation'],
    });
    assert.equal(JSON.stringify(projectIntercomConversationForCooChat(richConversation)).includes('hidden@example.invalid'), false);
    assert.equal(JSON.stringify(projectIntercomConversationForCooChat(richConversation)).includes('private body'), false);
  });
});

test('COO list projection applies to every conversation and identifies no-reply open cases', () => {
  withContext('coo', true, () => {
    const projected = projectIntercomConversationsForCooChat([
      richConversation,
      {
        id: '215400000000002',
        state: 'open',
        created_at: 500,
        statistics: { last_contact_reply_at: null, last_admin_reply_at: null },
      },
    ]) as Array<Record<string, unknown>>;
    assert.equal(projected.length, 2);
    assert.equal(projected[1]?.needs_response, true);
    assert.equal(projected[1]?.waiting_since, 500);
  });
});

test('COO search accepts queue metadata fields and rejects customer/message fields', () => {
  withContext('coo', true, () => {
    assert.doesNotThrow(() => assertCooChatConversationSearchInput({ field: 'state' }));
    assert.doesNotThrow(() => assertCooChatConversationSearchInput({
      conditions: [{ field: 'created_at' }, { field: 'team_assignee_id' }],
    }));
    assert.throws(
      () => assertCooChatConversationSearchInput({ field: 'source.author.email' }),
      /operational queue metadata fields/,
    );
    assert.throws(
      () => assertCooChatConversationSearchInput({ conditions: [{ field: 'source.subject' }] }),
      /operational queue metadata fields/,
    );
  });
});

test('other lanes and non-connector COO callers retain raw conversation behavior', () => {
  for (const [callerAgent, connectorSurface] of [['cro', true], ['coo', false]] as const) {
    withContext(callerAgent, connectorSurface, () => {
      assert.strictEqual(projectIntercomConversationForCooChat(richConversation), richConversation);
      assert.deepEqual(projectIntercomConversationsForCooChat([richConversation]), [richConversation]);
      assert.doesNotThrow(() => assertCooChatConversationSearchInput({ field: 'source.author.email' }));
    });
  }
});
