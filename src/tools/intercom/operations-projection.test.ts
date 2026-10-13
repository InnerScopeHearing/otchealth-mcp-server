import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectOperationMetadata,
  projectOperationResponse,
  projectOperationSchema,
  safeRequestedConfigFields,
} from './operations-projection.js';

test('operation schemas retain usable fields and reachable refs while omitting examples and prose', () => {
  const projected = projectOperationSchema({
    operation_id: 'finAsk', method: 'POST', path: '/fin/ask', domain: 'fin_runtime',
    parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }], body_required: true,
    body_schema: { $ref: '#/components/schemas/AskRequest', description: 'private prose', example: { body: 'example PHI' } },
    components: { schemas: { AskRequest: {
      type: 'object', required: ['body', 'user'],
      properties: { body: { type: 'string', example: 'example PHI', description: 'message body' }, user: { $ref: '#/components/schemas/userProfile' } },
    }, userProfile: { type: 'object', required: ['id'], properties: { id: { type: 'string', default: 'example-user' } } } } },
  }) as Record<string, any>;
  assert.equal(projected.parameters[0].name, 'userId');
  assert.equal(projected.body_schema.$ref, '#/components/schemas/AskRequest');
  assert.deepEqual(projected.components.schemas.AskRequest.required, ['body', 'user']);
  assert.equal(projected.components.schemas.AskRequest.properties.body.type, 'string');
  assert.equal(projected.components.schemas.AskRequest.properties.user.$ref, '#/components/schemas/userProfile');
  assert.equal(Object.hasOwn(projected.components.schemas.AskRequest.properties.body, 'example'), false);
  assert.equal(JSON.stringify(projected).includes('example PHI'), false);
  assert.equal(JSON.stringify(projected).includes('private prose'), false);
});

test('response projection keeps operational and paging metadata while removing raw bodies and credentials', () => {
  const projected = projectOperationResponse({
    conversations: [{ id: 'c-1', state: 'open', admin_assignee_id: 'a-1', source: { body: 'customer PHI', author: { email: 'private@example.invalid' } }, contact_ids: ['contact-1'] }],
    pages: { type: 'next', next: { starting_after: 'cursor-2' } },
    api_token: 'secret-token', result: { body: 'raw data connector result' },
  }) as Record<string, any>;
  assert.equal(projected.conversations[0].state, 'open');
  assert.equal(projected.conversations[0].admin_assignee_id, 'a-1');
  assert.equal(projected.pagination.next_starting_after, 'cursor-2');
  assert.doesNotMatch(JSON.stringify(projected), /customer PHI|private@example|contact-1|secret-token|raw data connector result/);

  const conversation = projectOperationResponse({ conversations: [{ id: 'c-2', name: 'private identity', state: 'open' }] }, ['name'], 'listConversations');
  assert.doesNotMatch(JSON.stringify(conversation), /private identity/);
});

test('catalog metadata stays compact and optional requested fields are allowlisted', () => {
  assert.deepEqual(projectOperationMetadata({ operation_id: 'createArticle', description: 'not included', summary: 'Create an article', method: 'POST', path: '/articles', domain: 'admin', tags: ['Knowledge'], effect: 'write', destructive: false, customer_content: false }), {
    operation_id: 'createArticle', method: 'POST', path: '/articles', domain: 'admin', tags: ['Knowledge'], summary: 'Create an article', effect: 'write', destructive: false, customer_content: false,
  });
  assert.deepEqual(safeRequestedConfigFields(['timezone', 'authorization', 'office_hours', 'customer_email', 'priority']), ['timezone', 'office_hours', 'priority']);
  assert.deepEqual(projectOperationResponse('unstructured customer text'), { value_type: 'text', value_length: 26 });
});
