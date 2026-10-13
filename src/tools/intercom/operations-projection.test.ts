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
  const composed = projectOperationSchema({ body_schema: {
    allOf: [{ type: 'object', properties: { lookupKey: { type: 'string', pattern: '^[A-Z]{1,50}$', readOnly: false }, _default_title_: { type: 'string' } } }],
    oneOf: [{ type: 'string' }, { type: 'number' }],
    additionalProperties: { type: 'string', writeOnly: true },
    discriminator: { propertyName: 'kind', mapping: { lookup: '#/components/schemas/Lookup' } },
  } }) as any;
  assert.equal(composed.body_schema.allOf[0].properties.lookupKey.pattern, '^[A-Z]{1,50}$');
  assert.equal(composed.body_schema.allOf[0].properties._default_title_.type, 'string');
  assert.equal(composed.body_schema.oneOf.length, 2);
  assert.deepEqual(composed.body_schema.additionalProperties, { type: 'string', writeOnly: true });
  assert.equal(composed.body_schema.discriminator.mapping.lookup, '#/components/schemas/Lookup');
  assert.throws(() => projectOperationSchema({ body_schema: { properties: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`field${i}`, { type: 'string' }])) } }), /bounded property count/);
  let deeplyNested: Record<string, unknown> = { type: 'string' };
  for (let depth = 0; depth < 34; depth += 1) deeplyNested = { items: deeplyNested };
  assert.throws(() => projectOperationSchema({ body_schema: deeplyNested }), /bounded nesting depth/);
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

test('official response projections keep config state, redact predicate values, and report truncation', () => {
  const officeHours = projectOperationResponse({ id: 's-1', time_zone_name: 'UTC', twenty_four_seven: false, time_intervals: [{ day_of_week: 1, start_minute: 540, end_minute: 1020, note: 'omit' }] }, [], 'getOfficeHoursSchedule') as any;
  assert.equal(officeHours.time_zone_name, 'UTC');
  assert.equal(officeHours.time_intervals[0].start_minute, 540);
  assert.equal(officeHours.time_intervals[0].end_minute, 1020);
  const exception = projectOperationResponse({ id: 'e-1', office_hours_schedule_id: 's-1', exception_date: '2026-10-14', type: 'closed', recurring_annually: false, note: 'omit' }, [], 'getOfficeHoursException') as any;
  assert.equal(exception.office_hours_schedule_id, 's-1');
  assert.equal(exception.exception_date, '2026-10-14');
  assert.equal(exception.type, 'closed');
  const allowlist = projectOperationResponse(['192.0.2.1', '2001:db8::1'], [], 'getIpAllowlist') as any;
  assert.deepEqual(allowlist.items, ['192.0.2.1', '2001:db8::1']);
  const connector = projectOperationResponse({ entity_version_id: 32, definition: { state: 'live', method: 'GET', direct_fin_usage: true, audiences: [{ id: 'aud-1', name: 'private audience name' }], data_inputs: [{ name: 'account_id', type: 'string', required: true }], headers: ['secret'], body: 'raw' } }, [], 'retrieveDataConnectorVersion') as any;
  assert.equal(connector.entity_version_id, 32);
  assert.deepEqual(connector.definition.audiences, [{ id: 'aud-1' }]);
  assert.equal(connector.definition.data_inputs[0].name, 'account_id');
  assert.equal(connector.definition.method, 'GET');
  assert.doesNotMatch(JSON.stringify(connector), /secret|raw/);
  const audience = projectOperationResponse({ conditions: [{ attribute: 'email', type: 'string', comparison: 'eq', value: 'private@example.invalid' }, { attribute: 'is_admin', type: 'boolean', comparison: 'eq', value: true }, { attribute: 'role', type: 'enum', comparison: 'eq', value: 'admin' }] }, [], 'retrieveAudience') as any;
  assert.equal(audience.conditions[0].value_redacted, true);
  assert.equal(audience.conditions[0].value_type, 'string');
  assert.equal(audience.conditions[1].value, true);
  assert.equal(audience.conditions[2].value, 'admin');
  const datasets = projectOperationResponse({ datasets: [{ name: 'Conversations', default_time_attribute_id: 'created_at', attributes: [{ id: 'attr-1', name: 'created_at', type: 'date', description: 'omit' }] }] }, [], 'get__export_reporting_data_get_datasets') as any;
  assert.equal(datasets.datasets[0].default_time_attribute_id, 'created_at');
  assert.equal(datasets.datasets[0].attributes[0].id, 'attr-1');
  assert.equal(datasets.datasets[0].attributes[0].name, 'created_at');
  const many = projectOperationResponse({ data: Array.from({ length: 24 }, (_, i) => ({ id: `item-${i}` })), pages: { next: { starting_after: 'unsafe-cursor-after-truncated-page' } } }) as any;
  assert.deepEqual(many.projection_info, { truncated: true, lists: [{ path: 'data', returned_count: 20, source_count: 24 }] });
  assert.equal(many.data.length, 20);
  assert.equal(many.pagination?.next_starting_after, undefined);
  const admin = projectOperationResponse({ id: 'admin-id', name: 'private name', email: 'private@example.invalid', app: { id: 'app-id', name: 'private app', email: 'private app email' }, away_mode_enabled: true }, ['name', 'email'], 'identifyAdmin') as any;
  assert.deepEqual(admin, { id: 'admin-id', away_mode_enabled: true, app: { id: 'app-id' } });
});

test('catalog metadata stays compact and optional requested fields are allowlisted', () => {
  assert.deepEqual(projectOperationMetadata({ operation_id: 'createArticle', description: 'not included', summary: 'Create an article', method: 'POST', path: '/articles', domain: 'admin', tags: ['Knowledge'], effect: 'write', destructive: false, customer_content: false }), {
    operation_id: 'createArticle', method: 'POST', path: '/articles', domain: 'admin', tags: ['Knowledge'], summary: 'Create an article', effect: 'write', destructive: false, customer_content: false,
  });
  assert.deepEqual(safeRequestedConfigFields(['timezone', 'authorization', 'office_hours', 'customer_email', 'priority']), ['timezone', 'office_hours', 'priority']);
  assert.deepEqual(projectOperationResponse('unstructured customer text'), { value_type: 'text', value_length: 26 });
});
