import type { ToolResultPayload } from '../registry.js';

export const CIO_ADMIN_DATA_LANES = ['cto', 'cro', 'exec'] as const;

export const CIO_ADMIN_READ_TOOLS = [
  'cio_admin_read_workspace_health',
  'cio_admin_read_workspace_health_view',
  'cio_admin_read_frequency_caps',
  'cio_admin_read_frequency_cap_usage',
  'cio_admin_read_message_limits',
  'cio_admin_read_preserve_unsubscribes_on_merge',
  'cio_admin_read_goals',
  'cio_admin_read_goal',
  'cio_admin_read_goal_data',
  'cio_admin_read_subscription_center_settings',
  'cio_admin_read_subscription_topics',
  'cio_admin_read_subscription_topic',
  'cio_admin_read_subscription_channels',
  'cio_admin_read_subscription_languages',
  'cio_admin_read_subscription_language',
  'cio_admin_read_subscription_pages',
  'cio_admin_read_subscription_order',
  'cio_admin_read_open_tracking_consent',
  'cio_admin_read_audit_logs',
  'cio_admin_read_design_readiness',
] as const;

export const CIO_ADMIN_WRITE_TOOLS = [
  'cio_admin_write_frequency_cap_create',
  'cio_admin_write_frequency_cap_update',
  'cio_admin_write_frequency_cap_delete',
  'cio_admin_write_message_limits_update',
  'cio_admin_write_preserve_unsubscribes_on_merge',
  'cio_admin_write_goal_create',
  'cio_admin_write_goal_update',
  'cio_admin_write_goal_delete',
  'cio_admin_write_subscription_center_settings',
  'cio_admin_write_subscription_topic_create',
  'cio_admin_write_subscription_topic_update',
  'cio_admin_write_subscription_topic_delete',
  'cio_admin_write_subscription_channel_upsert',
  'cio_admin_write_subscription_channel_delete',
  'cio_admin_write_subscription_languages_create',
  'cio_admin_write_subscription_language_update',
  'cio_admin_write_subscription_language_delete',
  'cio_admin_write_subscription_page_create',
  'cio_admin_write_subscription_page_update',
  'cio_admin_write_subscription_topic_order',
  'cio_admin_write_subscription_channel_order',
  'cio_admin_write_open_tracking_consent',
] as const;

export type CioAdminReadTool = (typeof CIO_ADMIN_READ_TOOLS)[number];
export type CioAdminWriteTool = (typeof CIO_ADMIN_WRITE_TOOLS)[number];
export type CioAdminTool = CioAdminReadTool | CioAdminWriteTool;

/**
 * Defense-in-depth authorization for the Customer.io control plane.
 * - reads: cto/cro/exec only;
 * - write previews: cto/cro/exec;
 * - live writes: cto/exec only. CRO prepares plans but cannot cross the live mutation gate.
 */
export function isCioAdminToolAllowed(
  toolName: CioAdminTool,
  caller: string | null | undefined,
  dryRun: boolean,
): boolean {
  if (!caller || !(CIO_ADMIN_DATA_LANES as readonly string[]).includes(caller)) return false;
  if ((CIO_ADMIN_READ_TOOLS as readonly string[]).includes(toolName)) return true;
  return dryRun || caller === 'cto' || caller === 'exec';
}

export function cioAdminLaneRefusal(
  toolName: CioAdminTool,
  caller: string | null | undefined,
  dryRun: boolean,
): ToolResultPayload {
  const liveWrite = (CIO_ADMIN_WRITE_TOOLS as readonly string[]).includes(toolName) && !dryRun;
  const reason = liveWrite
    ? 'Live Customer.io configuration writes are limited to cto/exec. The CRO lane may inspect and dry-run the same schema-backed change.'
    : 'Customer.io administrative control data is limited to the cto/cro/exec internal lanes.';
  return {
    data: {
      executed: false,
      error: 'forbidden_cio_admin_lane',
      tool: toolName,
      caller_agent: caller || null,
      dry_run: dryRun,
      reason,
    },
    summary: reason,
  };
}

export function hasOwnerApprovalReference(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 8;
}
