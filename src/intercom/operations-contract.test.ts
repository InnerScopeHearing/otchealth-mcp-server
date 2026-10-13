import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOperation,
  getOperationSchema,
  listOperations,
  validateOperationRequest,
} from './operations-contract.js';

test('manifest exposes bounded operation discovery and exact method/domain metadata', () => {
  assert.equal(listOperations().length, 50);
  assert.equal(listOperations({ limit: 101 }).length, 0);
  assert.equal(listOperations({ domain: 'fin_runtime', limit: 100 }).length, 7);
  assert.equal(getOperation('startFinConversation')?.method, 'POST');
  assert.equal(getOperation('startFinConversation')?.domain, 'fin_runtime');
  assert.equal(getOperation('startFinConversation')?.effect, 'write');
  assert.equal(getOperation('SearchContacts')?.effect, 'write');
  assert.equal(getOperation('createTicketTypeAttribute')?.customer_content, false);
  assert.equal(getOperation('attachTagToContact')?.customer_content, true);
  assert.equal(getOperation('getMacro')?.method, 'GET');
  assert.equal(getOperationSchema('getMacro')?.parameters[0]?.name, 'id');
  const searchSchema = getOperationSchema('SearchContacts');
  assert.ok(searchSchema?.components.schemas.contact_search_request);
  assert.equal(searchSchema?.response_content_types.includes('application/json'), true);
});

test('required path, query, and nested body constraints fail closed', () => {
  assert.equal(validateOperationRequest({ operation_id: 'getMacro' }).valid, false);
  assert.equal(validateOperationRequest({ operation_id: 'getMacro', path_params: { id: '123' } }).valid, true);
  assert.equal(validateOperationRequest({ operation_id: 'listMacros', query: { unsupported: 1 } }).valid, false);
  assert.equal(validateOperationRequest({ operation_id: 'startFinConversation', body: {} }).valid, false);
  assert.equal(validateOperationRequest({
    operation_id: 'startFinConversation',
    body: { conversation_id: 'c1', message: {}, user: {} },
  }).valid, false);
  assert.equal(validateOperationRequest({
    operation_id: 'SearchContacts',
    body: { query: { field: 'email', operator: '=', value: 'a@example.com' } },
  }).valid, true);
  assert.equal(validateOperationRequest({ operation_id: 'doesNotExist' }).valid, false);
});

test('path interpolation only accepts a single unreserved segment', () => {
  for (const id of ['../contacts', 'a/b', 'a?query', '#fragment', '..']) {
    assert.equal(validateOperationRequest({ operation_id: 'getMacro', path_params: { id } }).valid, false);
  }
  assert.equal(validateOperationRequest({ operation_id: 'retrieveArticle', path_params: { article_id: '123' } }).valid, true);
  assert.equal(validateOperationRequest({ operation_id: 'retrieveArticle', path_params: { article_id: '1.5' } }).valid, false);
});

test('reporting job identifiers follow their documented path rather than the erroneous query declaration', () => {
  const request = { operation_id: 'get__export_reporting_data_job_identifier_', path_params: { job_identifier: 'job-123' }, query: { app_id: 'test-app', client_id: 'test-client' } };
  assert.equal(validateOperationRequest(request).valid, true);
  assert.equal(validateOperationRequest({ operation_id: request.operation_id, query: { job_identifier: 'job-123' } }).valid, false);
});

test('documented conversation attribute variants and Unix snooze timestamps remain usable', () => {
  assert.equal(validateOperationRequest({ operation_id: 'createConversationAttribute', body: { name: 'Review_attribute', data_type: 'string' } }).valid, true);
  assert.equal(validateOperationRequest({ operation_id: 'createConversationAttribute', body: { name: 'Review_attribute', data_type: 'unsupported' } }).valid, false);
  assert.equal(validateOperationRequest({ operation_id: 'manageConversation', path_params: { conversation_id: 'conversation-1' }, body: { message_type: 'snoozed', admin_id: 'admin-1', snoozed_until: 1800000000 } }).valid, true);
});
