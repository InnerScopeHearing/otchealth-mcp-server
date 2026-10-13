import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { currentCallerAgent } from '../../server/request-context.js';
import {
  getOperation,
  getOperationSchema,
  listOperations,
  validateOperationRequest,
  type IntercomOperation,
  type OperationInput,
} from '../../intercom/operations-contract.js';
import { executeOperation } from '../../intercom/operations-client.js';
import { registerTool, type CallerHashProvider } from '../registry.js';
import {
  operationGateReason,
  projectOperationMetadata,
  projectOperationResponse,
  projectOperationSchema,
  safeRequestedConfigFields,
} from './operations-projection.js';

const SAFE_OPERATIONAL_SEARCH_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'state', 'open', 'admin_assignee_id',
  'team_assignee_id', 'priority', 'waiting_since', 'snoozed_until',
]);

// Fixed documented configuration operations only. Other OpenAPI operations remain visible in the
// catalog with a gate reason, but cannot be used as a generic API proxy.
const ADMIN_WRITE_ALLOWLIST = new Set([
  'manageConversation',
  'setAwayAdmin',
  'createOfficeHoursException', 'updateOfficeHoursException', 'deleteOfficeHoursException',
  'createOfficeHoursSchedule', 'updateOfficeHoursSchedule', 'deleteOfficeHoursSchedule',
  'createArticle', 'updateArticle', 'stageArticleDraft', 'publishArticleDraft', 'deleteArticle',
  'createInternalArticle', 'updateInternalArticle', 'deleteInternalArticle',
  'createExternalPage', 'updateExternalPage', 'deleteExternalPage',
  'createContentImportSource', 'updateContentImportSource', 'deleteContentImportSource',
  'createHelpCenterRedirect', 'deleteHelpCenterRedirect',
  'createCollection', 'updateCollection', 'deleteCollection',
  'createFolder', 'updateFolder', 'deleteFolder',
  'createDataAttribute', 'updateDataAttribute',
  'createTicketType', 'updateTicketType', 'createTicketTypeAttribute', 'updateTicketTypeAttribute',
  'createConversationAttribute', 'updateConversationAttribute',
  'createConversationAttributeOption', 'updateConversationAttributeOption',
  'createTag', 'deleteTag',
  'createDataConnector', 'updateDataConnector', 'deleteDataConnector', 'updateDataConnectorVersion',
  'createAudience', 'updateAudience', 'deleteAudience', 'post__export_reporting_data_enqueue',
  'updateIpAllowlist',
  'createContentSnippet', 'updateContentSnippet', 'deleteContentSnippet',
  'attachTagToContentSnippet', 'detachTagFromContentSnippet',
  'createCustomObjectInstances', 'deleteCustomObjectInstancesById', 'deleteCustomObjectInstancesByExternalId',
  'createDynamicContent', 'updateDynamicContent', 'deleteDynamicContent',
  'createNewsItem', 'updateNewsItem', 'deleteNewsItem', 'createPhoneSwitch',
]);

const CONVERSATION_OPERATIONAL_READS = new Set(['listConversations', 'retrieveConversation', 'searchConversations']);
const CUSTOMER_VISIBLE_WRITES = new Set(['publishArticleDraft', 'createDynamicContent', 'updateDynamicContent', 'deleteDynamicContent', 'createNewsItem', 'updateNewsItem', 'deleteNewsItem', 'createPhoneSwitch']);

const CUSTOMER_ID_KEYS = new Set(['contact_id', 'external_id', 'customer_id', 'company_id', 'ticket_id']);
const MAX_PAGE = 25;

function assertOwnRole(): void {
  const lane = currentCallerAgent();
  if (lane !== 'cto' && lane !== 'coo') {
    throw new Error('Intercom operations are restricted to the authenticated CTO or COO lane.');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function operationReadAllowed(operation: IntercomOperation): boolean {
  if (operation.domain !== 'admin') return false;
  if (operation.operation_id === 'searchConversations') return operation.method === 'POST';
  if (operation.method !== 'GET') return false;
  if (isProtectedCustomerPath(operation.path)) return CONVERSATION_OPERATIONAL_READS.has(operation.operation_id);
  return true;
}

function isProtectedCustomerPath(path: string): boolean {
  return /^\/(?:contacts|companies|tickets|fin(?:\/|$)|messages|visitors|events|calls|phone_calls)(?:\/|$)/.test(path)
    || (/^\/conversations(?:\/|$)/.test(path) && !/^\/conversations\/attributes(?:\/|$)/.test(path));
}

function operationWriteAllowed(operation: IntercomOperation): boolean {
  if (operation.domain !== 'admin') return false;
  if (operation.operation_id === 'manageConversation') return operation.path === '/conversations/{conversation_id}/parts';
  if (isProtectedCustomerPath(operation.path) || !ADMIN_WRITE_ALLOWLIST.has(operation.operation_id)) return false;
  return true;
}

function availability(operation: IntercomOperation, fin = false): { available: boolean; gate: string | null; access: string; projection: 'metadata_only' } {
  if (operation.domain !== (fin ? 'fin_runtime' : 'admin')) {
    return { available: false, gate: fin ? 'use_intercom_admin_catalog' : 'use_fin_catalog', access: 'catalog_only', projection: 'metadata_only' };
  }
  const metadataGate = operationGateReason(operation);
  if (fin) {
    return { available: true, gate: 'explicit_paid_runtime_write_requires_fin_invoke_dry_run_and_acknowledgement', access: 'explicit_write_only', projection: 'metadata_only' };
  }
  if (operationReadAllowed(operation)) return { available: true, gate: null, access: 'read', projection: 'metadata_only' };
  if (operationWriteAllowed(operation)) return { available: true, gate: requiresExplicitWarning(operation) ? 'explicit_acknowledgement_required' : 'write_defaults_to_dry_run', access: 'write', projection: 'metadata_only' };
  if (operation.operation_id === 'searchConversations') return { available: true, gate: null, access: 'read_only_documented_post_search', projection: 'metadata_only' };
  return { available: false, gate: metadataGate ?? (isProtectedCustomerPath(operation.path) ? 'customer_identity_or_phi_protected' : 'operation_not_enabled_for_generic_dispatch'), access: 'catalog_and_schema_only', projection: 'metadata_only' };
}

function operationCount(domain: 'admin' | 'fin_runtime'): number {
  let count = 0;
  for (let offset = 0; ; offset += 100) {
    const page = listOperations({ domain, offset, limit: 100 });
    count += page.length;
    if (page.length < 100) return count;
  }
}

function operationAccessCounts(domain: 'admin' | 'fin_runtime'): { enabled: number; held: number } {
  const operations = Array.from({ length: 3 }, (_, page) => listOperations({ domain, offset: page * 100, limit: 100 })).flat();
  let enabled = 0;
  let held = 0;
  for (const operation of operations) {
    const access = availability(operation, domain === 'fin_runtime').access;
    if (access === 'catalog_and_schema_only') held += 1;
    else enabled += 1;
  }
  return { enabled, held };
}

function overallCoverageCounts(): { total: number; enabled: number; held: number } {
  const admin = operationAccessCounts('admin');
  const fin = operationAccessCounts('fin_runtime');
  return { total: admin.enabled + admin.held + fin.enabled + fin.held, enabled: admin.enabled + fin.enabled, held: admin.held + fin.held };
}

function rejectCustomerIdentifiers(input: OperationInput): void {
  for (const key of Object.keys(input.path_params ?? {})) {
    if (CUSTOMER_ID_KEYS.has(key)) throw new Error('Generic dispatch cannot target customer, company, or ticket identities. Use the existing scoped tool for that operation.');
  }
}

function assertOperationalSearch(body: unknown): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const record = asRecord(value);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (/source|contact|customer|author|message|reply|body|email|phone|text|subject|tag|company/i.test(key)) {
        throw new Error('Conversation search is limited to operational status and routing fields.');
      }
      if (key === 'field') {
        if (typeof child !== 'string' || !SAFE_OPERATIONAL_SEARCH_FIELDS.has(child)) {
          throw new Error('Conversation search is limited to operational status and routing fields.');
        }
      }
      walk(child);
    }
  };
  walk(body);
}

function validateInput(input: OperationInput, operation: IntercomOperation): void {
  rejectCustomerIdentifiers(input);
  const validation = validateOperationRequest(input);
  if (!validation.valid) throw new Error(`Invalid documented Intercom operation request: ${validation.errors.join(' ')}`);
  if (operation.operation_id === 'searchConversations') assertOperationalSearch(input.body);
  if (operation.operation_id === 'manageConversation') assertSafeConversationManagement(input.body);
  if (input.body !== undefined && JSON.stringify(input.body).length > 64_000) throw new Error('Request body exceeds the bounded operation payload size.');
  if (operation.domain === 'admin' && input.body !== undefined) assertNoInlineCredentials(input.body);
  if (operation.domain === 'fin_runtime' && input.query && Object.keys(input.query).length > 10) {
    throw new Error('Fin runtime request exceeds the bounded parameter limit.');
  }
}

function assertNoInlineCredentials(value: unknown, key = ''): void {
  // These are documented opaque Intercom authentication-token references, not token values.
  if (key === 'token_ids' && Array.isArray(value)) {
    if (!value.every((id) => typeof id === 'string' && /^[A-Za-z0-9._~-]{1,160}$/.test(id))) throw new Error('Use existing Intercom token IDs.');
    return;
  }
  if (Array.isArray(value)) { value.forEach((item) => assertNoInlineCredentials(item, key)); return; }
  const record = asRecord(value);
  if (record) {
    if (typeof record.name === 'string' && typeof record.value === 'string' && /(?:authorization|api.?key|token|password|secret|credential)/i.test(record.name)) {
      assertNoInlineCredentials(record.value, record.name);
    }
    for (const [childKey, child] of Object.entries(record)) {
      if (childKey === 'token_ids' && Array.isArray(child) && child.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))) continue;
      assertNoInlineCredentials(child, childKey);
    }
    return;
  }
  if (typeof value !== 'string') return;
  if (/(?:authorization\s*[:=]|(?:api[_-]?key|token|password|secret)\s*[:=])\s*(?!\{\{|\$\{|(?:secret|vault|env):\/\/|\*{3})[^\s&;"']{5,}/i.test(value)) {
    throw new Error('Inline credential literals are rejected; use a documented secret reference.');
  }
  if (!/(?:secret|token|password|credential|api.?key|private.?key|authorization)/i.test(key)) return;
  const trimmed = value.trim();
  const directReference = /^(?:\$\{[A-Za-z_][A-Za-z0-9_.-]{0,120}\}|\{\{[A-Za-z_][A-Za-z0-9_.-]{0,120}\}\}|(?:secret|vault|env):\/\/[A-Za-z0-9_./:-]{1,160})$/i.test(trimmed);
  const bearerReference = /^(?:Bearer|Basic)\s+(?:\$\{[A-Za-z_][A-Za-z0-9_.-]{0,120}\}|\{\{[A-Za-z_][A-Za-z0-9_.-]{0,120}\}\}|(?:secret|vault|env):\/\/[A-Za-z0-9_./:-]{1,160})$/i.test(trimmed);
  if (!directReference && !bearerReference && !/^\*{3,}$/.test(trimmed)) {
    throw new Error('Credential fields accept only masked values or existing secret references; inline credential values are rejected.');
  }
}

function assertSafeConversationManagement(body: unknown): void {
  const record = asRecord(body);
  if (!record) throw new Error('Conversation management requires a documented status or assignment payload.');
  const action = record.message_type;
  const allowedByAction: Record<string, ReadonlySet<string>> = {
    assignment: new Set(['message_type', 'type', 'admin_id', 'assignee_id', 'skip_reopen']),
    close: new Set(['message_type', 'type', 'admin_id']),
    open: new Set(['message_type', 'admin_id']),
    snoozed: new Set(['message_type', 'admin_id', 'snoozed_until']),
  };
  const allowed = typeof action === 'string' ? allowedByAction[action] : undefined;
  if (!allowed || Object.keys(record).some((key) => !allowed.has(key)) || Object.hasOwn(record, 'body')) {
    throw new Error('Conversation writes are limited to status and routing actions; replies and free-form conversation bodies are blocked.');
  }
  if (action === 'assignment' && !['admin', 'team'].includes(String(record.type))) throw new Error('Conversation assignment type must be admin or team.');
}

function safeAuditInput(input: OperationInput): Record<string, unknown> {
  return {
    operation_id: input.operation_id,
    path_parameter_names: Object.keys(input.path_params ?? {}).sort(),
    query_parameter_names: Object.keys(input.query ?? {}).sort(),
    body_field_names: Object.keys(asRecord(input.body) ?? {}).sort(),
  };
}

function redactInput(input: Record<string, unknown>): unknown {
  return safeAuditInput(input as unknown as OperationInput);
}

function responseForOperation(operation: IntercomOperation, result: { status: number; data: unknown }, requestedFields?: unknown): Record<string, unknown> {
  return {
    operation_id: operation.operation_id,
    status: result.status,
    result: isReportingOperation(operation.operation_id)
      ? projectReportingResponse(result.data)
      : projectOperationResponse(result.data, safeRequestedConfigFields(requestedFields), operation.operation_id),
  };
}

function isReportingOperation(operationId: string): boolean {
  return operationId.includes('reporting_data') || operationId.startsWith('get__download_reporting_data');
}

function projectReportingResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 20).map(projectReportingResponse);
  const record = asRecord(value);
  if (!record) return projectOperationResponse(value);
  const projected: Record<string, unknown> = {};
  for (const key of ['id', 'job_identifier', 'status', 'created_at', 'updated_at', 'count', 'total_count', 'has_more']) {
    if (Object.hasOwn(record, key)) projected[key] = record[key];
  }
  for (const key of ['url', 'link', 'download_url']) {
    if (typeof record[key] !== 'string') continue;
    try {
      const url = new URL(record[key] as string);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) projected[`${key}_without_query`] = `${url.origin}${url.pathname}`.slice(0, 500);
    } catch { /* malformed links are omitted */ }
  }
  for (const key of ['job', 'report', 'data']) {
    if (Object.hasOwn(record, key)) projected[key] = projectReportingResponse(record[key]);
  }
  return projected;
}

function requiresExplicitWarning(operation: IntercomOperation): boolean {
  return operation.destructive || operation.operation_id === 'updateIpAllowlist' || CUSTOMER_VISIBLE_WRITES.has(operation.operation_id);
}

export function registerIntercomOperations(server: McpServer, callerHash: CallerHashProvider): void {
  const catalogShape = { offset: z.number().int().min(0).max(10000).optional(), limit: z.number().int().min(1).max(MAX_PAGE).optional() };
  const schemaShape = { operation_id: z.string().min(1).max(100) };
  const pathParamsShape = z.record(z.string(), z.string().max(128)).refine((value) => Object.keys(value).length <= 12, 'Too many path parameters.');
  const queryShape = z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length <= 20, 'Too many query parameters.');
  const readShape = {
    operation_id: z.string().min(1).max(100),
    path_params: pathParamsShape.optional(),
    query: queryShape.optional(),
    body: z.unknown().optional(),
    requested_config_fields: z.array(z.string().max(48)).max(12).optional(),
  };
  const writeShape = {
    operation_id: z.string().min(1).max(100),
    path_params: pathParamsShape.optional(),
    query: queryShape.optional(),
    body: z.unknown().optional(),
  };

  registerTool(server, {
    name: 'intercom_operation_catalog', category: 'read',
    annotations: { title: 'Browse Intercom operations', description: 'List fixed, documented Intercom operations with access gates. Catalog metadata only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: catalogShape, outputShape: { operations: z.array(z.unknown()), offset: z.number(), limit: z.number(), total: z.number(), counts: z.unknown(), coverage: z.unknown() },
    handler: async (input) => {
      assertOwnRole();
      const offset = input.offset ?? 0; const limit = input.limit ?? 20;
      const operations = listOperations({ domain: 'admin', offset, limit }).map((operation) => ({ ...projectOperationMetadata(operation), ...availability(operation) }));
      return { data: { operations, offset, limit, total: operationCount('admin'), counts: operationAccessCounts('admin'), coverage: overallCoverageCounts() }, summary: `Returned ${operations.length} documented Intercom operations and their access gates.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'intercom_operation_schema', category: 'read',
    annotations: { title: 'Read an Intercom operation schema', description: 'Inspect the fixed request schema for a documented Intercom operation. Schema metadata only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: schemaShape, outputShape: { operation: z.unknown(), schema: z.unknown() },
    maxResponseBytes: 20000,
    handler: async ({ operation_id }) => {
      assertOwnRole();
      const operation = getOperation(operation_id);
      const schema = getOperationSchema(operation_id);
      if (!operation || operation.domain !== 'admin' || !schema) throw new Error('Unknown Intercom admin operation.');
      return { data: { operation: { ...projectOperationMetadata(operation), ...availability(operation) }, schema: projectOperationSchema({ ...schema, ...operation }) }, summary: `Returned the bounded schema for ${operation_id}.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'intercom_operation_read', category: 'read',
    annotations: { title: 'Read Intercom configuration or operational metadata', description: 'Execute an enabled exact documented Intercom read. Conversation results are projected to operational metadata; customer messages, contact identity and raw bodies are omitted. POST is accepted only for the documented conversation search.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: readShape, outputShape: { operation_id: z.string(), status: z.number(), result: z.unknown() },
    maxResponseBytes: 12000,
    handler: async (input) => {
      assertOwnRole();
      const operation = getOperation(input.operation_id);
      if (!operation || !operationReadAllowed(operation)) throw new Error('This operation is catalog-only or must use its existing scoped Intercom tool.');
      const request: OperationInput = { operation_id: input.operation_id, path_params: input.path_params, query: input.query, body: input.body };
      validateInput(request, operation);
      const result = await executeOperation(request);
      return { data: responseForOperation(operation, result, input.requested_config_fields), summary: `Completed documented Intercom read ${operation.operation_id}; response fields were projected.` };
    },
    redactInputForLog: redactInput,
    shieldInputForScan: (input) => safeAuditInput(input as unknown as OperationInput),
  }, callerHash);

  registerTool(server, {
    name: 'intercom_operation_write', category: 'write_simple',
    annotations: { title: 'Apply an Intercom configuration change', description: 'Execute an explicitly enabled documented Intercom configuration write. Defaults to dry-run. Deletes require acknowledge_warning=true. Customer messaging and customer-record mutations are not supported here.', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputShape: writeShape, outputShape: { operation_id: z.string(), executed: z.boolean(), dry_run: z.boolean(), status: z.number().nullable(), result: z.unknown() },
    maxResponseBytes: 12000,
    handler: async (input, ctx) => {
      assertOwnRole();
      const operation = getOperation(input.operation_id);
      if (!operation || !operationWriteAllowed(operation)) throw new Error('This operation is not enabled for generic Intercom configuration writes.');
      const request: OperationInput = { operation_id: input.operation_id, path_params: input.path_params, query: input.query, body: input.body };
      validateInput(request, operation);
      if (requiresExplicitWarning(operation) && !ctx.acknowledgeWarning) throw new Error('This operation requires acknowledge_warning=true.');
      if (ctx.dryRun) return { data: { operation_id: operation.operation_id, executed: false, dry_run: true, status: null, result: null }, audit: { before: safeAuditInput(request), after: null }, summary: `DRY RUN: validated ${operation.method} ${operation.path}; no provider request was sent.` };
      const result = await executeOperation(request);
      const projected = responseForOperation(operation, result);
      return { data: { operation_id: operation.operation_id, executed: true, dry_run: false, status: result.status, result: projected.result }, audit: { before: safeAuditInput(request), after: { status: result.status, operation_id: operation.operation_id } }, summary: `Applied documented Intercom configuration operation ${operation.operation_id}; response fields were projected.` };
    },
    redactInputForLog: redactInput,
    shieldInputForScan: (input) => safeAuditInput(input as unknown as OperationInput),
  }, callerHash);

  registerTool(server, {
    name: 'intercom_fin_operation_catalog', category: 'read',
    annotations: { title: 'Browse Intercom Fin runtime operations', description: 'List fixed Fin runtime operations with explicit read/write and paid-runtime gates. Metadata only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: catalogShape, outputShape: { operations: z.array(z.unknown()), offset: z.number(), limit: z.number(), total: z.number(), counts: z.unknown(), coverage: z.unknown() },
    handler: async (input) => {
      assertOwnRole();
      const offset = input.offset ?? 0; const limit = input.limit ?? 20;
      const operations = listOperations({ domain: 'fin_runtime', offset, limit }).map((operation) => ({ ...projectOperationMetadata(operation), ...availability(operation, true) }));
      return { data: { operations, offset, limit, total: operationCount('fin_runtime'), counts: operationAccessCounts('fin_runtime'), coverage: overallCoverageCounts() }, summary: `Returned ${operations.length} documented Fin runtime operations and their gates.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'intercom_fin_operation_schema', category: 'read',
    annotations: { title: 'Read an Intercom Fin operation schema', description: 'Inspect a fixed Fin runtime request schema. Schema metadata only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: schemaShape, outputShape: { operation: z.unknown(), schema: z.unknown() },
    maxResponseBytes: 20000,
    handler: async ({ operation_id }) => {
      assertOwnRole();
      const operation = getOperation(operation_id);
      const schema = getOperationSchema(operation_id);
      if (!operation || operation.domain !== 'fin_runtime' || !schema) throw new Error('Unknown Fin runtime operation.');
      return { data: { operation: { ...projectOperationMetadata(operation), ...availability(operation, true) }, schema: projectOperationSchema({ ...schema, ...operation }) }, summary: `Returned the bounded Fin schema for ${operation_id}.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'intercom_fin_operation_invoke', category: 'write_simple',
    annotations: { title: 'Invoke an Intercom Fin runtime operation', description: 'Invoke only an exact documented Fin operation. Paid conversation effects default to dry-run and require acknowledge_warning=true for live execution. Responses are restricted to metadata.', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputShape: writeShape, outputShape: { operation_id: z.string(), executed: z.boolean(), dry_run: z.boolean(), status: z.number().nullable(), result: z.unknown() },
    maxResponseBytes: 10000,
    handler: async (input, ctx) => {
      assertOwnRole();
      const operation = getOperation(input.operation_id);
      if (!operation || operation.domain !== 'fin_runtime') throw new Error('Fin invocation accepts Fin runtime operation IDs only.');
      const request: OperationInput = { operation_id: input.operation_id, path_params: input.path_params, query: input.query, body: input.body };
      validateInput(request, operation);
      if (ctx.dryRun) return { data: { operation_id: operation.operation_id, executed: false, dry_run: true, status: null, result: null }, audit: { before: safeAuditInput(request), after: null }, summary: `DRY RUN: validated Fin runtime operation ${operation.operation_id}; no runtime request was sent.` };
      if (!ctx.acknowledgeWarning) throw new Error('Live Fin runtime writes require acknowledge_warning=true.');
      const result = await executeOperation(request);
      const projected = responseForOperation(operation, result);
      return { data: { operation_id: operation.operation_id, executed: true, dry_run: false, status: result.status, result: projected.result }, audit: { before: safeAuditInput(request), after: { status: result.status, operation_id: operation.operation_id } }, summary: `Invoked documented Fin operation ${operation.operation_id}; response content was omitted.` };
    },
    redactInputForLog: redactInput,
    shieldInputForScan: (input) => safeAuditInput(input as unknown as OperationInput),
  }, callerHash);
}
