/**
 * Owner-delegated COO customer-operations access, approved by Matthew 2026-09-30.
 * Exact names, never a wildcard or another seat's credential. The operator-owned
 * environment switch is off by default and provides a one-switch rollback.
 * Existing write approvals, high-risk gates, ring checks and audit controls remain.
 * This is not authorization to place protected health data in a non-BAA runtime.
 */
export const COO_FULL_INTERCOM_TOOLSET: readonly string[] = [
  'intercom_add_note', 'intercom_admin_get', 'intercom_admin_list', 'intercom_admin_set_away',
  'intercom_article_delete', 'intercom_article_search',
  'intercom_collection_create', 'intercom_collection_delete', 'intercom_collection_get', 'intercom_collection_list', 'intercom_collection_update',
  'intercom_company_attach_contact', 'intercom_company_create', 'intercom_company_delete', 'intercom_company_detach_contact', 'intercom_company_get', 'intercom_company_list', 'intercom_company_list_contacts', 'intercom_company_update',
  'intercom_contact_archive', 'intercom_contact_delete', 'intercom_contact_get', 'intercom_contact_list', 'intercom_contact_list_companies', 'intercom_contact_list_tags', 'intercom_contact_search', 'intercom_contact_unarchive', 'intercom_contact_update',
  'intercom_conversation_assign', 'intercom_conversation_close', 'intercom_conversation_get', 'intercom_conversation_list', 'intercom_conversation_open', 'intercom_conversation_run_assignment_rules', 'intercom_conversation_search', 'intercom_conversation_snooze', 'intercom_conversation_tag_attach', 'intercom_conversation_tag_detach',
  'intercom_create_article', 'intercom_create_contact', 'intercom_create_conversation',
  'intercom_data_attribute_create', 'intercom_data_attribute_list', 'intercom_data_attribute_update',
  'intercom_event_list', 'intercom_event_submit', 'intercom_get_article', 'intercom_list_articles', 'intercom_note_get', 'intercom_note_list', 'intercom_reply_conversation',
  'intercom_segment_get', 'intercom_segment_list', 'intercom_tag_company', 'intercom_tag_contact', 'intercom_tag_create', 'intercom_tag_delete', 'intercom_tag_list', 'intercom_tag_update',
  'intercom_team_get', 'intercom_team_list', 'intercom_ticket_create', 'intercom_ticket_get', 'intercom_ticket_search', 'intercom_ticket_type_create', 'intercom_ticket_type_get', 'intercom_ticket_type_list', 'intercom_ticket_type_update', 'intercom_ticket_update',
  'intercom_untag_company', 'intercom_untag_contact', 'intercom_update_article',
] as const;

const intercomOperations = new Set(COO_FULL_INTERCOM_TOOLSET);

export function cooCustomerOperationsEnabled(lane: string): boolean {
  return lane === 'coo' && process.env.COO_CUSTOMER_OPERATIONS_ENABLED === 'true';
}

export function cooIntercomOperationAllowed(lane: string, tool: string): boolean {
  return cooCustomerOperationsEnabled(lane) && intercomOperations.has(tool);
}
