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
  'last_admin_reply_at', 'count_conversation_parts', 'correlation_id',
]);

// These fields can help operators understand configuration state. Free-form content,
// connector credentials, customer data and message bodies are never projected.
const OPTIONAL_CONFIG_FIELDS = new Set([
  'timezone', 'office_hours', 'working_hours', 'availability', 'fallback_behavior',
  'routing_mode', 'assignment_mode', 'enabled_channels', 'supported_channels',
  'event_types', 'locale', 'language', 'visibility', 'is_default', 'priority',
  'name', 'type', 'required', 'weekday', 'day', 'start', 'end', 'start_time',
  'end_time', 'field', 'operator', 'conditions', 'filters', 'rules', 'days',
  'audiences', 'audience_ids', 'data_inputs', 'http_method', 'direct_fin_usage',
]);

const SAFE_KEY = /^[a-z][a-z0-9_]{0,47}$/;
// OpenAPI component/property/parameter names are source-controlled and may use camelCase or
// PascalCase. Keep those exact names so callers can construct valid requests and resolve refs.
const SAFE_SCHEMA_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/;
const MAX_ITEMS = 20;
const MAX_STRING = 180;

function safeScalar(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function projectConfig(value: unknown, depth = 0): unknown {
  if (depth > 3) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => {
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
    const projected = OPTIONAL_CONFIG_FIELDS.has(key) ? projectConfig(value, depth + 1) : safeScalar(value);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
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
    result.response_content_types = record.response_content_types.filter((item): item is string => item === 'application/json' || item.endsWith('+json')).slice(0, 4);
  }
  const parameters = Array.isArray(record.parameters) ? record.parameters : [];
  result.parameters = parameters.slice(0, 40).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : '';
    if (!SAFE_SCHEMA_NAME.test(name)) return [];
    return [{ name, in: safeScalar(item.in), required: safeScalar(item.required), schema: projectSchemaNode(item.schema, 0) }];
  });
  if (record.body_schema !== undefined) result.body_schema = projectSchemaNode(record.body_schema, 0);
  const components = asRecord(record.components);
  const componentSchemas = asRecord(components?.schemas);
  if (componentSchemas) {
    const projected: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(componentSchemas)) {
      if (!SAFE_SCHEMA_NAME.test(name)) continue;
      projected[name] = projectSchemaNode(child, 0);
    }
    result.components = { schemas: projected };
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function projectSchemaNode(value: unknown, depth: number): unknown {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const schema = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['$ref', 'type', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'required', 'additionalProperties', 'nullable', 'format']) {
    const scalar = schema[key];
    if (Array.isArray(scalar)) out[key] = scalar.slice(0, 20).map(safeScalar).filter((v) => v !== undefined);
    else {
      const projected = safeScalar(scalar);
      if (projected !== undefined) out[key] = projected;
    }
  }
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const props: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(schema.properties as Record<string, unknown>).slice(0, 100)) {
      if (!SAFE_SCHEMA_NAME.test(name)) continue;
      props[name] = projectSchemaNode(child, depth + 1);
    }
    out.properties = props;
  }
  if (schema.items !== undefined) out.items = projectSchemaNode(schema.items, depth + 1);
  return out;
}

export function projectOperationResponse(
  value: unknown,
  requestedConfigFields: string[] = [],
  operationId?: string,
): unknown {
  const requested = requestedConfigFields.filter((field) => OPTIONAL_CONFIG_FIELDS.has(field)).slice(0, 12);
  const conversationRead = operationId !== undefined && ['listConversations', 'retrieveConversation', 'searchConversations'].includes(operationId);
  const customRecordRead = operationId !== undefined && ['listCustomObjectInstances', 'getCustomObjectInstancesById'].includes(operationId);
  const fields = new Set(conversationRead ? OPERATIONAL_CONVERSATION_FIELDS : customRecordRead ? CUSTOM_RECORD_METADATA_FIELDS : DEFAULT_FIELDS);
  // Requested config fields apply only to configuration resources, never to operational customer
  // records where an otherwise-safe field name such as `name` could reveal identity.
  if (!conversationRead && !customRecordRead) for (const field of requested) fields.add(field);
  if (operationId && ['listDataConnectors', 'RetrieveDataConnector', 'listDataConnectorVersions', 'retrieveDataConnectorVersion'].includes(operationId)) {
    for (const field of ['http_method', 'direct_fin_usage', 'audiences', 'audience_ids', 'data_inputs']) fields.add(field);
  }
  if (operationId && ['listAudiences', 'retrieveAudience'].includes(operationId)) fields.add('conditions');
  if (operationId && ['listOfficeHoursSchedules', 'getOfficeHoursSchedule', 'listOfficeHoursExceptions', 'getOfficeHoursException'].includes(operationId)) {
    for (const field of ['weekday', 'day', 'start', 'end', 'start_time', 'end_time', 'office_hours']) fields.add(field);
  }
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => projectValue(item, fields));
  if (typeof value === 'string') return { value_type: 'text', value_length: value.length };
  if (!value || typeof value !== 'object') return { value: safeScalar(value) ?? null };
  return projectValue(value, fields);
}

const OPERATIONAL_CONVERSATION_FIELDS = new Set([
  'id', 'state', 'created_at', 'updated_at', 'open', 'priority', 'waiting_since',
  'snoozed_until', 'admin_assignee_id', 'team_assignee_id', 'needs_response',
  'last_customer_reply_at', 'last_admin_reply_at', 'count_conversation_parts',
]);

const CUSTOM_RECORD_METADATA_FIELDS = new Set(['id', 'type', 'created_at', 'updated_at', 'status', 'state']);

function projectValue(value: unknown, fields: ReadonlySet<string>): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return safeScalar(value) ?? null;
  const record = value as Record<string, unknown>;
  const projected = projectRecord(record, fields);
  for (const objectKey of ['conversation']) {
    const nested = record[objectKey];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      projected[objectKey] = projectRecord(nested as Record<string, unknown>, fields);
    }
  }
  for (const listKey of ['data', 'items', 'results', 'segments', 'audiences', 'articles', 'connectors', 'data_connectors', 'reports', 'conversations', 'ticket_types', 'office_hours_schedules', 'office_hours_exceptions', 'tags', 'admins', 'macros', 'data_attributes', 'folders', 'collections', 'internal_articles', 'external_pages']) {
    const list = record[listKey];
    if (Array.isArray(list)) projected[listKey] = list.slice(0, MAX_ITEMS).map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) return projectRecord(item as Record<string, unknown>, fields);
      if (typeof item === 'string') return { value_type: 'text', value_length: item.length };
      return safeScalar(item) ?? null;
    });
  }
  const pagination = record.pages ?? record.pagination;
  if (pagination && typeof pagination === 'object' && !Array.isArray(pagination)) {
    const page = pagination as Record<string, unknown>;
    const metadata: Record<string, unknown> = {};
    for (const key of ['type', 'page', 'per_page', 'total_count', 'has_more', 'starting_after', 'next_starting_after']) {
      if (Object.hasOwn(page, key)) metadata[key] = safeScalar(page[key]);
    }
    const next = page.next;
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      const cursor = (next as Record<string, unknown>).starting_after;
      const safeCursor = safeScalar(cursor);
      if (safeCursor !== undefined) metadata.next_starting_after = safeCursor;
    }
    if (Object.keys(metadata).length) projected.pagination = metadata;
  }
  for (const key of ['count', 'total_count', 'has_more']) {
    if (Object.hasOwn(record, key)) projected[key] = safeScalar(record[key]);
  }
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
