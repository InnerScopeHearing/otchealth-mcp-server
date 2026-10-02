import { currentCallerAgent, isConnectorSurface } from '../../server/request-context.js';

const SAFE_COO_OPERATIONAL_TAGS = new Set([
  'b2b-partnership',
  'channel:email',
  'channel:sms',
  'channel:voice',
  'complaint-file-required',
  'feature request',
  'misrouted-not-otchealth',
  'order-status',
  'product-support',
  'qa',
  'refund-request',
  'return-request',
  'returns',
  'safety-escalation',
  'shipping',
  'synthetic',
  'synthetic-qa',
  'synthetic-test',
  'technical-support',
  'troubleshooting',
  'warranty-request',
]);

const SAFE_COO_SEARCH_FIELDS = new Set([
  'state',
  'created_at',
  'updated_at',
  'admin_assignee_id',
  'team_assignee_id',
]);

function isCooChatConnector(): boolean {
  return currentCallerAgent() === 'coo' && isConnectorSurface();
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function idOrNull(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function operationalTags(conversation: Record<string, unknown>): string[] {
  const container = recordOrNull(conversation.tags);
  const raw = Array.isArray(conversation.tags)
    ? conversation.tags
    : Array.isArray(container?.tags)
      ? container.tags
      : [];
  const names = raw.flatMap((tag) => {
    if (typeof tag === 'string') return [tag];
    const tagRecord = recordOrNull(tag);
    return typeof tagRecord?.name === 'string' ? [tagRecord.name] : [];
  });
  return [...new Set(names
    .map((name) => name.trim().toLowerCase())
    .filter((name) => SAFE_COO_OPERATIONAL_TAGS.has(name)))]
    .sort();
}

function isSynthetic(conversation: Record<string, unknown>): boolean {
  const source = recordOrNull(conversation.source);
  const candidate = [
    conversation.title,
    source?.subject,
  ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
  return candidate.includes('synthetic qa') ||
    candidate.includes('cs-qa-') ||
    candidate.includes('coo cloud acceptance') ||
    operationalTags(conversation).some((tag) => tag.startsWith('synthetic'));
}

export function projectIntercomConversationForCooChat(conversation: unknown): unknown {
  if (!isCooChatConnector()) return conversation;
  const record = recordOrNull(conversation);
  if (!record) throw new Error('Intercom did not return the expected conversation object.');

  const statistics = recordOrNull(record.statistics);
  const state = stringOrNull(record.state);
  const createdAt = numberOrNull(record.created_at);
  const lastCustomerReplyAt = numberOrNull(statistics?.last_contact_reply_at);
  const lastAdminReplyAt = numberOrNull(statistics?.last_admin_reply_at);
  const needsResponse = state === 'open' &&
    (lastAdminReplyAt === null ||
      (lastCustomerReplyAt !== null && lastCustomerReplyAt > lastAdminReplyAt));

  return {
    id: idOrNull(record.id),
    state,
    created_at: createdAt,
    updated_at: numberOrNull(record.updated_at),
    admin_assignee_id: idOrNull(record.admin_assignee_id),
    team_assignee_id: idOrNull(record.team_assignee_id),
    needs_response: needsResponse,
    waiting_since: needsResponse ? (lastCustomerReplyAt ?? createdAt) : null,
    last_customer_reply_at: lastCustomerReplyAt,
    last_admin_reply_at: lastAdminReplyAt,
    last_close_at: numberOrNull(statistics?.last_close_at),
    count_conversation_parts: numberOrNull(statistics?.count_conversation_parts),
    ai_agent_participated: typeof record.ai_agent_participated === 'boolean'
      ? record.ai_agent_participated
      : null,
    synthetic_test: isSynthetic(record),
    operational_tags: operationalTags(record),
  };
}

export function projectIntercomConversationsForCooChat(conversations: unknown[]): unknown[] {
  return conversations.map(projectIntercomConversationForCooChat);
}

export function assertCooChatConversationSearchInput(input: {
  field?: unknown;
  conditions?: Array<{ field?: unknown }>;
}): void {
  if (!isCooChatConnector()) return;
  const fields = [
    input.field,
    ...(Array.isArray(input.conditions) ? input.conditions.map((condition) => condition.field) : []),
  ].filter((field): field is string => typeof field === 'string');

  for (const field of fields) {
    if (!SAFE_COO_SEARCH_FIELDS.has(field)) {
      throw new Error('COO Chat Intercom conversation search is restricted to operational queue metadata fields.');
    }
  }
}
