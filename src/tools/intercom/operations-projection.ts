/** Safe, bounded projections for the generic Intercom operation surface. */

export const OPERATION_METADATA_FIELDS = [
  'operation_id', 'method', 'path', 'domain', 'tags', 'summary', 'effect',
  'destructive', 'customer_content', 'availability',
] as const;

const DEFAULT_FIELDS = new Set([
  'id', 'name', 'type', 'enabled', 'active', 'status', 'state', 'created_at',
  'updated_at', 'deleted_at', 'mode', 'timezone', 'visibility', 'archived',
  'published', 'version', 'source', 'availability', 'office_hours', 'open',
  'priority', 'waiting_since', 'snoozed_until', 'admin_assignee_id',
  'team_assignee_id', 'needs_response', 'last_customer_reply_at',
  'last_admin_reply_at', 'count_conversation_parts', 'correlation_id', 'entity_version_id',
  'away_mode_enabled', 'away_mode_reassign', 'away_status_reason_id',
  'time_zone_name', 'time_intervals', 'twenty_four_seven', 'office_hours_schedule_id',
  'exception_date', 'exception_type', 'recurring_annually', 'type', 'ip_allowlist', 'allowed_ips', 'allowlist',
  'default_time_attribute_id', 'attribute_ids', 'attributeIDs', 'attribute_id', 'attributes',
  'predicates', 'role_predicates', 'definition', 'app', 'state',
]);

// These fields can help operators understand configuration state. Free-form content,
// connector credentials, customer data and message bodies are never projected.
const OPTIONAL_CONFIG_FIELDS = new Set([
  'id', 'timezone', 'office_hours', 'working_hours', 'availability', 'fallback_behavior',
  'routing_mode', 'assignment_mode', 'enabled_channels', 'supported_channels',
  'event_types', 'locale', 'language', 'visibility', 'is_default', 'priority',
  'name', 'type', 'required', 'weekday', 'day', 'start', 'end', 'start_time',
  'end_time', 'field', 'operator', 'conditions', 'filters', 'rules', 'days',
  'audiences', 'audience_ids', 'data_inputs', 'http_method', 'direct_fin_usage',
  'time_zone_name', 'time_intervals', 'start_minute', 'end_minute', 'day_of_week',
  'twenty_four_seven', 'office_hours_schedule_id', 'exception_date', 'exception_type', 'recurring_annually',
  'entity_version_id', 'definition', 'state', 'value_redacted', 'value_type', 'comparison',
  'attribute', 'attributes', 'attribute_id', 'attribute_ids', 'default_time_attribute_id', 'method',
  'attributeIDs', 'ip_allowlist', 'allowed_ips', 'allowlist', 'away_mode_enabled',
  'away_mode_reassign', 'away_status_reason_id', 'app', 'predicates',
]);

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
// OpenAPI component/property/parameter names are source-controlled and may use camelCase or
// PascalCase. Keep those exact names so callers can construct valid requests and resolve refs.
const MAX_ITEMS = 20;
const MAX_STRING = 180;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 4000;
const MAX_SCHEMA_FIELDS = 512;
const PREDICATE_FIELDS = new Set(['conditions', 'filters', 'rules', 'predicates', 'role_predicates']);
const SAFE_ROLE_VALUES = new Set(['admin', 'user', 'owner', 'member', 'manager', 'teammate', 'contact', 'lead', 'visitor']);

function safeScalar(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function projectConfig(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new Error('Configuration projection exceeds the bounded nested array size.');
    return value.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) return projectRecord(item as Record<string, unknown>, OPTIONAL_CONFIG_FIELDS, depth + 1);
      return safeScalar(item);
    }).filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') return projectRecord(value as Record<string, unknown>, OPTIONAL_CONFIG_FIELDS, depth + 1);
  return safeScalar(value);
}

function projectRecord(
  record: Record<string, unknown>,
  fields: ReadonlySet<string>,
  depth = 0,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    if (!SAFE_KEY.test(key) || !Object.hasOwn(record, key)) continue;
    const value = record[key];
    let projected: unknown;
    if (PREDICATE_FIELDS.has(key)) projected = projectPredicates(value, depth + 1);
    else if (key === 'app') projected = projectApp(value);
    else if (key === 'audiences' || key === 'audience_ids') projected = projectAudienceIds(value);
    else if (OPTIONAL_CONFIG_FIELDS.has(key)) projected = projectConfig(value, depth + 1);
    else projected = safeScalar(value);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

function projectApp(value: unknown): unknown {
  const app = asRecord(value);
  return app && Object.hasOwn(app, 'id') ? { id: safeScalar(app.id) } : undefined;
}

function projectPredicates(value: unknown, depth = 0): unknown {
  if (depth > 3) return { value_redacted: true, value_type: 'nested' };
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new Error('Audience predicate projection exceeds the bounded list size.');
    return value.map((item) => projectPredicates(item, depth + 1));
  }
  const source = asRecord(value);
  if (!source) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of ['attribute', 'type', 'comparison', 'operator']) {
    const safe = safeScalar(source[key]);
    if (safe !== undefined) projected[key] = safe;
  }
  for (const key of ['predicates', 'conditions']) {
    if (Object.hasOwn(source, key)) projected[key] = projectPredicates(source[key], depth + 1);
  }
  if (Object.hasOwn(source, 'value')) {
    const value = source.value;
    const attribute = String(source.attribute ?? '').toLowerCase();
    if (typeof value === 'boolean' || typeof value === 'number') projected.value = value;
    else if (typeof value === 'string' && (/role/.test(attribute) || String(source.type ?? '').toLowerCase() === 'role') && SAFE_ROLE_VALUES.has(value.toLowerCase())) projected.value = value;
    else projected.value_redacted = true;
    projected.value_type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  }
  return projected;
}

function projectAudienceIds(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_ITEMS) throw new Error('Audience ID projection exceeds the bounded list size.');
  return value.map((item) => {
    if (typeof item === 'string' || typeof item === 'number') return item;
    const record = asRecord(item);
    return record && Object.hasOwn(record, 'id') ? { id: safeScalar(record.id) } : undefined;
  }).filter((item) => item !== undefined);
}

export function projectOperationMetadata(operation: object): Record<string, unknown> {
  const source = operation as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of OPERATION_METADATA_FIELDS) {
    const value = source[field];
    if (field === 'tags' && Array.isArray(value)) {
      result.tags = value.filter((tag): tag is string => typeof tag === 'string').slice(0, 8).map((tag) => tag.slice(0, 60));
    } else {
      const projected = safeScalar(value);
      if (projected !== undefined) result[field] = projected;
    }
  }
  return result;
}

export function projectOperationSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const record = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['operation_id', 'method', 'path', 'domain', 'effect', 'destructive', 'customer_content', 'body_required']) {
    const value = safeScalar(record[key]);
    if (value !== undefined) result[key] = value;
  }
  if (Array.isArray(record.response_content_types)) {
    if (record.response_content_types.length > MAX_SCHEMA_FIELDS) throw new Error('Operation schema exceeds the bounded response content type count.');
    result.response_content_types = record.response_content_types.filter((item): item is string => typeof item === 'string' && (item === 'application/json' || item.endsWith('+json')));
  }
  const state = { nodes: 0 };
  const parameters = Array.isArray(record.parameters) ? record.parameters : [];
  if (parameters.length > MAX_SCHEMA_FIELDS) throw new Error('Operation schema exceeds the bounded parameter count.');
  result.parameters = parameters.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Operation schema contains a malformed parameter.');
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : '';
    assertSchemaName(name);
    return [{ name, in: safeScalar(item.in), required: safeScalar(item.required), schema: projectSchemaNode(item.schema, 0, state) }];
  });
  if (record.body_schema !== undefined) result.body_schema = projectSchemaNode(record.body_schema, 0, state);
  const components = asRecord(record.components);
  const componentSchemas = asRecord(components?.schemas);
  if (componentSchemas) {
    const projected: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(componentSchemas)) {
      assertSchemaName(name);
      projected[name] = projectSchemaNode(child, 0, state);
    }
    result.components = { schemas: projected };
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function assertSchemaName(name: string): void {
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name) || name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new Error('Operation schema contains an unsupported field name.');
  }
}

function assertSchemaPattern(pattern: string): void {
  if (!pattern || pattern.length > 512 || /[\u0000-\u001f\u007f]/.test(pattern)) throw new Error('Operation schema contains an unsupported pattern property name.');
}

function projectSchemaNode(value: unknown, depth: number, state = { nodes: 0 }): unknown {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('Operation schema exceeds the bounded nesting depth.');
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Operation schema contains a malformed schema node.');
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) throw new Error('Operation schema exceeds the bounded node count.');
  const schema = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['$ref', 'type', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'required', 'nullable', 'format', 'pattern', 'readOnly', 'writeOnly']) {
    const scalar = schema[key];
    if (Array.isArray(scalar)) {
      if (scalar.length > MAX_SCHEMA_FIELDS) throw new Error(`Operation schema ${key} constraint exceeds the bounded size.`);
      out[key] = scalar.map(schemaScalar);
    }
    else {
      const projected = schemaScalar(scalar);
      if (projected !== undefined) out[key] = projected;
    }
  }
  if (schema.discriminator !== undefined) {
    const discriminator = asRecord(schema.discriminator);
    if (!discriminator || typeof discriminator.propertyName !== 'string') throw new Error('Operation schema discriminator is malformed.');
    const mapping = asRecord(discriminator.mapping);
    const projectedMapping: Record<string, string> = {};
    if (mapping) {
      if (Object.keys(mapping).length > MAX_SCHEMA_FIELDS) throw new Error('Operation schema discriminator mapping exceeds the bounded size.');
      for (const [key, target] of Object.entries(mapping)) {
        assertSchemaName(key);
        if (typeof target !== 'string' || target.length > 512) throw new Error('Operation schema discriminator mapping is malformed.');
        projectedMapping[key] = target;
      }
    }
    out.discriminator = { propertyName: schemaScalar(discriminator.propertyName), ...(mapping ? { mapping: projectedMapping } : {}) };
  }
  for (const key of ['properties', 'patternProperties']) {
    if (schema[key] !== undefined && (!schema[key] || typeof schema[key] !== 'object' || Array.isArray(schema[key]))) throw new Error(`Operation schema ${key} constraint is malformed.`);
    const source = asRecord(schema[key]);
    if (!source) continue;
    if (Object.keys(source).length > MAX_SCHEMA_FIELDS) throw new Error('Operation schema exceeds the bounded property count.');
    const props: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(source)) {
      if (key === 'patternProperties') assertSchemaPattern(name);
      else assertSchemaName(name);
      props[name] = projectSchemaNode(child, depth + 1, state);
    }
    out[key] = props;
  }
  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties === 'boolean') out.additionalProperties = schema.additionalProperties;
    else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') out.additionalProperties = projectSchemaNode(schema.additionalProperties, depth + 1, state);
    else throw new Error('Operation schema has an unsupported additionalProperties constraint.');
  }
  if (schema.items !== undefined) out.items = projectSchemaNode(schema.items, depth + 1, state);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key])) throw new Error(`Operation schema ${key} constraint is malformed.`);
    if (schema[key].length > MAX_SCHEMA_FIELDS) throw new Error(`Operation schema ${key} constraint exceeds the bounded size.`);
    out[key] = (schema[key] as unknown[]).map((child) => projectSchemaNode(child, depth + 1, state));
  }
  return out;
}

function schemaScalar(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > 2048) throw new Error('Operation schema scalar exceeds the bounded size.');
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  throw new Error('Operation schema contains an unsupported constraint value.');
}

export function projectOperationResponse(
  value: unknown,
  requestedConfigFields: string[] = [],
  operationId?: string,
): unknown {
  const requested = requestedConfigFields.filter((field) => OPTIONAL_CONFIG_FIELDS.has(field)).slice(0, 12);
  const conversationRead = operationId !== undefined && ['listConversations', 'retrieveConversation', 'searchConversations'].includes(operationId);
  const customRecordRead = operationId !== undefined && ['listCustomObjectInstances', 'getCustomObjectInstancesById'].includes(operationId);
  const identitySafeAdminRead = operationId === 'identifyAdmin';
  const fields = new Set(conversationRead ? OPERATIONAL_CONVERSATION_FIELDS : customRecordRead ? CUSTOM_RECORD_METADATA_FIELDS : identitySafeAdminRead ? ADMIN_METADATA_FIELDS : DEFAULT_FIELDS);
  // Requested config fields apply only to configuration resources, never to operational customer
  // records where an otherwise-safe field name such as `name` could reveal identity.
  if (!conversationRead && !customRecordRead && !identitySafeAdminRead) for (const field of requested) fields.add(field);
  if (operationId && ['listDataConnectors', 'RetrieveDataConnector', 'listDataConnectorVersions', 'retrieveDataConnectorVersion'].includes(operationId)) {
    for (const field of ['http_method', 'direct_fin_usage', 'audiences', 'audience_ids', 'data_inputs']) fields.add(field);
  }
  if (operationId && ['listAudiences', 'retrieveAudience'].includes(operationId)) fields.add('conditions');
  if (operationId && ['listAudiences', 'retrieveAudience'].includes(operationId)) fields.add('role_predicates');
  if (operationId && ['listOfficeHoursSchedules', 'getOfficeHoursSchedule', 'listOfficeHoursExceptions', 'getOfficeHoursException'].includes(operationId)) {
    for (const field of ['weekday', 'day', 'start', 'end', 'start_time', 'end_time', 'office_hours', 'time_zone_name', 'time_intervals', 'twenty_four_seven', 'office_hours_schedule_id', 'exception_date', 'type', 'recurring_annually']) fields.add(field);
  }
  if (operationId === 'getIpAllowlist') for (const field of ['ip_allowlist', 'allowed_ips', 'allowlist']) fields.add(field);
  if (operationId === 'identifyAdmin') for (const field of ['away_mode_enabled', 'away_mode_reassign', 'away_status_reason_id', 'app']) fields.add(field);
  if (operationId === 'get__export_reporting_data_get_datasets') {
    for (const field of ['default_time_attribute_id', 'attribute_ids', 'attributeIDs', 'attributes']) fields.add(field);
  }
  if (operationId && ['listDataConnectorVersions', 'retrieveDataConnectorVersion'].includes(operationId)) {
    for (const field of ['entity_version_id', 'definition']) fields.add(field);
  }
  if (operationId === 'getIpAllowlist' && Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => safeScalar(item));
    return { items, projection_info: { path: '$', returned_count: items.length, source_count: value.length, truncated: value.length > MAX_ITEMS } };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => projectValue(item, fields, operationId));
    return { items, projection_info: { path: '$', returned_count: items.length, source_count: value.length, truncated: value.length > MAX_ITEMS } };
  }
  if (typeof value === 'string') return { value_type: 'text', value_length: value.length };
  if (!value || typeof value !== 'object') return { value: safeScalar(value) ?? null };
  return projectValue(value, fields, operationId);
}

const OPERATIONAL_CONVERSATION_FIELDS = new Set([
  'id', 'state', 'created_at', 'updated_at', 'open', 'priority', 'waiting_since',
  'snoozed_until', 'admin_assignee_id', 'team_assignee_id', 'needs_response',
  'last_customer_reply_at', 'last_admin_reply_at', 'count_conversation_parts',
]);
const ADMIN_METADATA_FIELDS = new Set(['id', 'away_mode_enabled', 'away_mode_reassign', 'away_status_reason_id', 'app']);

const CUSTOM_RECORD_METADATA_FIELDS = new Set(['id', 'type', 'created_at', 'updated_at', 'status', 'state']);

function projectValue(value: unknown, fields: ReadonlySet<string>, operationId?: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return safeScalar(value) ?? null;
  const record = value as Record<string, unknown>;
  const projected = projectRecord(record, fields);
  const truncations: Array<{ path: string; returned_count: number; source_count: number }> = [];
  for (const objectKey of ['conversation']) {
    const nested = record[objectKey];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      projected[objectKey] = projectRecord(nested as Record<string, unknown>, fields);
    }
  }
  for (const listKey of ['data', 'items', 'results', 'teams', 'segments', 'audiences', 'articles', 'connectors', 'data_connectors', 'reports', 'datasets', 'conversations', 'ticket_types', 'office_hours_schedules', 'office_hours_exceptions', 'tags', 'admins', 'macros', 'data_attributes', 'folders', 'collections', 'internal_articles', 'external_pages']) {
    const list = record[listKey];
    if (Array.isArray(list)) {
      const returned = list.slice(0, MAX_ITEMS);
      projected[listKey] = returned.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) return projectRecord(item as Record<string, unknown>, fields);
      if (typeof item === 'string') return { value_type: 'text', value_length: item.length };
      return safeScalar(item) ?? null;
      });
      if (list.length > MAX_ITEMS) truncations.push({ path: listKey, returned_count: returned.length, source_count: list.length });
    }
  }
  const pagination = record.pages ?? record.pagination;
  if (pagination && typeof pagination === 'object' && !Array.isArray(pagination)) {
    const page = pagination as Record<string, unknown>;
    const metadata: Record<string, unknown> = {};
    for (const key of ['type', 'page', 'per_page', 'total_count', 'has_more', 'starting_after', 'next_starting_after']) {
      if (truncations.length > 0 && (key === 'starting_after' || key === 'next_starting_after')) continue;
      if (Object.hasOwn(page, key)) metadata[key] = safeScalar(page[key]);
    }
    const next = page.next;
    if (truncations.length === 0 && next && typeof next === 'object' && !Array.isArray(next)) {
      const cursor = (next as Record<string, unknown>).starting_after;
      const safeCursor = safeScalar(cursor);
      if (safeCursor !== undefined) metadata.next_starting_after = safeCursor;
    }
    if (Object.keys(metadata).length) projected.pagination = metadata;
  }
  for (const key of ['count', 'total_count', 'has_more']) {
    if (Object.hasOwn(record, key)) projected[key] = safeScalar(record[key]);
  }
  if (truncations.length) projected.projection_info = { truncated: true, lists: truncations };
  if (operationId === 'identifyAdmin' && record.app !== undefined) projected.app = projectApp(record.app);
  return projected;
}

export function safeRequestedConfigFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((field): field is string => typeof field === 'string' && OPTIONAL_CONFIG_FIELDS.has(field)).slice(0, 12);
}

export function operationGateReason(operationValue: object): string | null {
  const operation = operationValue as Record<string, unknown>;
  if (operation.domain === 'fin_runtime') return 'separate_fin_runtime_tool';
  if (operation.customer_content === true) return 'customer_or_conversation_content_protected';
  if (operation.unsupported_body === true) return 'unsupported_request_body';
  return null;
}
