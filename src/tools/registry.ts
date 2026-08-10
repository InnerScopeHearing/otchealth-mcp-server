/**
 * Tool registration helper. Wraps the MCP SDK's registerTool with:
 *  - Zod input validation that REJECTS unexpected fields
 *  - Compliance guardrail scan over outputs
 *  - Audit logging (start/end with correlation IDs, before/after diffs for writes)
 *  - READ_ONLY_MODE / ENABLE_WRITE_TOOLS / ENABLE_HIGH_RISK_TOOLS gating
 *  - Standard MCP tool annotations
 *  - Structured-content responses with text + structured payload
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { loadEnv, type Env } from '../config/env.js';
import {
  logToolEnd,
  logToolStart,
  newCorrelationId,
  type ToolCallLogEnd,
} from '../audit/logger.js';
import { applyGuardrail, type ComplianceWarning } from '../compliance/guardrail.js';
import { recordTool, deriveService } from '../catalog/catalog.js';
import { requiredRoleFor, roleAllows } from '../catalog/governance.js';
import { currentCallerAgent, isConnectorSurface, isM365StaticAuth } from '../server/request-context.js';
import { shouldOffload, offloadResult } from './result-store.js';
import {
  inboundShield,
  outboundGroundedness,
  type GroundingHint,
} from '../safety/auto-guard.js';
import { evaluateColdStart, markWoken, COLD_START_MESSAGE } from '../safety/cold-start.js';
import { journalMutation, parseAutoJournalMode } from '../safety/journal.js';
import {
  recordMutation,
  evaluateCapturePressure,
  buildCaptureNudgeMessage,
  type CapturePressureOutcome,
} from '../safety/capture-pressure.js';
import { evaluateJitDoctrine } from '../safety/jit-doctrine.js';
import { captureGatewayEvent } from '../telemetry/gateway-ops.js';
import {
  parseToolCatalogCurationMode,
  evaluateCatalogCuration,
  recordLaneToolUsage,
} from '../safety/tool-catalog-curation.js';
import { EXEC_RING } from './kb/search-privileged.js';

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Per-lane curated connector toolsets, advertised to Claude Chat (DCR) / occ_ connector requests so
// the model gets a focused, FINDABLE set instead of the full ~850-tool catalog (which Claude
// truncates, hiding brain_search). WHICH curated set a given connector request sees depends on the
// caller's OAuth-derived agent lane (see connectorToolset() below) -- this split is a SECURITY
// BOUNDARY, not just a findability curation:
//
//   CTO_SHIP_LANE_TOOLSET       the full ship-cycle toolset (branch/commit/PR/review/CI/merge/
//                               dispatch, the PRIVILEGED kb_search_privileged + legal_blob_* +
//                               memory_write, the Azure control plane, ...). Handed ONLY to a
//                               connector lane that is cto, developer, or in the executive ring
//                               (EXEC_RING). See isShipLane().
//   EXTERNAL_READONLY_TOOLSET   a minimal, non-privileged read set. Handed to EVERY OTHER connector
//                               lane: an unrecognized/self-named connector, an empty caller lane, or
//                               any lane not in the ship set.
//
// SECURITY-CRITICAL (Phase 5/6 connector-ring closure, 2026-07-15): before this split there was ONE
// global toolset for every connector, and oauth.ts's laneFromClientName() defaulted an UNRECOGNIZED
// connector name to the 'clo' lane (a privileged EXEC_RING lane). Combined, that meant any Claude.ai
// account holder who added this gateway as a custom connector and gave it an unrecognized name got a
// bearer token whose lane ('clo') passed kb_search_privileged's / legal_blob_*'s ring check AND whose
// connector toolset already advertised those privileged tools plus memory_write -- a live external
// privileged-access hole. This split is layer 1 of the fix (the toolset itself no longer advertises
// privileged tools to a non-ship lane); oauth.ts's DCR default lane is layer 2 (an unrecognized name
// no longer resolves to a privileged lane at all); memory-write.ts's own ring gate is layer 3
// (defense-in-depth: refuses the call outright even if a future toolset override or the confidential
// occ_ client path ever lets a non-ship lane reach it). See registry.connector-lanes.test.ts.
//
// Overridable via env for BOTH lists: CONNECTOR_TOOLSET (csv) overrides the ship set (back-compat
// with the pre-split var name); EXTERNAL_READONLY_TOOLSET (csv) overrides the external set.
// Empty/unset means "use the built-in default" for that set. Only DCR/occ_ connector requests are
// curated at all -- every other caller (the startup catalog warm, client_credentials fleet lanes,
// the static connector token) sees the full ~850-tool catalog unchanged (see isConnectorSurface() in
// server/request-context.ts).
// ───────────────────────────────────────────────────────────────────────────────────────────────
export const CTO_SHIP_LANE_TOOLSET: readonly string[] = [
  'brain_search', 'web_search', 'kb_search', 'kb_search_privileged',
  // kb_get_document: whole-document retrieval from the finance/legal doc rooms (paginated, ring-gated
  // in get-document.ts). MUST be on the connector surface or the Claude Chat CFO cannot SEE it -- and
  // kb_search returns only chunk SNIPPETS, so without this the CFO can never pull a full source doc
  // (a bank statement, a filing) end to end. The 2026-07-15 lane split shipped kb_get_document (#130)
  // into the catalog but never added it here, so it stayed invisible on every exec DCR connector (the
  // CFO reported "102 tools, kb_get_document absent"). VISIBILITY only; the ring gate stays in-handler.
  'kb_get_document',
  // Phase 6: the OpenAI ChatGPT / Deep Research connector contract (search/fetch — see
  // kb/openai-search.ts). Non-privileged by construction even on this lane: the tools re-derive
  // and re-check the ring per call, they are not widened just because cto/exec can see them here.
  'search', 'fetch',
  'legal_blob_list', 'legal_blob_get', 'legal_blob_put',
  // legal_blob_move/copy/delete (2026-08-04, CLO brief §1): added in the SAME PR that registers
  // them, deliberately, to not repeat the catalog_probe/xero_attachment_upload/kb_get_document/
  // mail_archive_* omission class -- built-but-invisible-on-every-connector has bitten this ship
  // set five separate times now; a tool is not done until it is visible here too.
  'legal_blob_move', 'legal_blob_copy', 'legal_blob_delete',
  'graph_drive_list', 'graph_drive_download', 'graph_drive_upload',
  'wake', 'checkpoint', 'memory_recall', 'memory_search', 'memory_write', 'memory_remember', 'memory_pack', 'memory_team', 'memory_inbound', 'memory_reconcile',
  // Wave 7 item 7.1: opt-in feedback reporting on a brain_search/kb_search hit (see kb/search.ts,
  // kb/brain-search.ts, memory/retrieval-feedback.ts). Not added to EXTERNAL_READONLY_TOOLSET below,
  // which deliberately excludes every write tool by design; the ship lane is where this is needed.
  'retrieval_feedback',
  'llm_azure', 'catalog_list_tools', 'catalog_master', 'gateway_fetch_result',
  // catalog_probe (2026-08-03): a diagnostic tool built specifically to answer "what caller_agent/
  // connector_surface/m365_static_auth did THIS request actually resolve to" -- exactly the question
  // needed to root-cause a connector showing an unexpectedly narrow toolset -- was itself never added
  // to this allowlist, so it was invisible to every connector-surface caller including the ones it
  // exists to diagnose (the same class of omission as developer_wake_lite, 2026-08-02). Read-only, no
  // role gate (catalog/governance.ts), no secrets in its output; safe on every ship lane.
  'catalog_probe',
  'task_list', 'task_get', 'task_create', 'task_claim', 'task_update', 'task_complete', 'task_heartbeat', 'inbox_read', 'agent_dispatch',
  'posthog_query_hogql', 'posthog_insight_list',
  'github_get_file_contents', 'github_list_pull_requests', 'github_issue_list', 'sentry_list_issues',
  // ITEM #2 Azure control-plane READ lane (Phase A). MUST be on the connector surface or the
  // Claude Chat CTO cannot SEE them (execution stays cto-gated in governance.ts either way).
  'azure_jobs_list', 'azure_job_executions', 'azure_logs_query', 'azure_search_index_stats',
  'azure_containerapp_get', 'azure_resource_list',
  // ITEM #2 Phase B write tools -- MUST be on the connector surface or the Chat CTO cannot CALL
  // them (execution stays cto + high-risk gated; dry_run defaults TRUE; oauth-clients denied).
  'azure_job_execute', 'azure_job_upsert', 'azure_containerapp_set_env',
  'azure_search_index_upsert', 'azure_search_indexer_upsert',
  // CTO SHIP-LANE (2026-07-12, widened 2026-07-13): the connector surface must carry the COMPLETE
  // ship cycle -- branch, commit, PR, review, CI, MERGE, and workflow-dispatch. The 2026-07-12 pass
  // added the write tools but omitted merge/dispatch/review, so the Claude Chat CTO could open a PR
  // but not land it, and had to drive a human browser session to click Merge (slow, brittle, and a
  // hard dependency on Matt being logged in). That is the SAME engine-migration gap as before, just
  // one step further down the pipeline: Hyperagent's client_credentials lane always got the full 861
  // tools; the Claude Chat DCR surface got a curated subset that was scoped when Chat was a STANDBY
  // seat and never re-scoped when it became a PRIMARY one.
  //
  // NOT a privilege grant on its own: execution-time role gating in catalog/governance.ts still
  // refuses every non-cto/non-developer caller for the write tools below. Other exec connectors used
  // to merely SEE these entries and get refused if they called them -- as of the 2026-07-15 lane
  // split, a non-ship connector lane no longer even SEES this list at all (it gets
  // EXTERNAL_READONLY_TOOLSET instead), which is this file's actual security boundary;
  // governance.ts's execution-time gating remains a second, independent layer under it.
  // write + branch
  'github_create_branch', 'github_create_or_update_file', 'github_edit_file', 'github_push_files', 'github_create_pull_request',
  'github_pr_update', 'github_pr_update_branch', 'github_ref_delete',
  // LAND IT: merge is the tool whose absence forced the browser fallback
  'github_merge_pull_request', 'github_pr_create_review', 'github_comment_on_issue',
  // trigger + observe CI directly (no browser, no human in the loop)
  'github_dispatch_workflow', 'github_list_workflow_runs', 'github_workflow_run_get',
  'github_workflow_run_rerun', 'github_workflow_run_list_jobs',
  // read the state you need to decide whether landing is safe
  'github_pr_get', 'github_pr_list_files', 'github_pr_list_commits', 'github_branch_get_protection',
  'github_repo_list_branches', 'github_commit_get', 'github_commit_compare',
  // issues (file + close follow-ups without leaving the seat)
  'github_create_issue', 'github_issue_get', 'github_issue_update',
  'graph_send_email', 'graph_list_messages', 'graph_message_get', 'graph_mark_read', 'cio_get_customer',
  // Bounded Customer.io administrative control plane (2026-08-09): explicit names, not a generic
  // proxy. Read tools are cto/cro/exec; write tools are visible for planning but live execution is
  // re-gated in-handler to cto/exec with owner_approval_ref. The canonical cro client_credentials
  // lane sees the full registry; this ship list keeps the CTO/exec connector surface complete.
  'cio_admin_read_workspace_health', 'cio_admin_read_workspace_health_view',
  'cio_admin_read_frequency_caps', 'cio_admin_read_frequency_cap_usage',
  'cio_admin_read_message_limits', 'cio_admin_read_preserve_unsubscribes_on_merge',
  'cio_admin_read_goals', 'cio_admin_read_goal', 'cio_admin_read_goal_data',
  'cio_admin_read_subscription_center_settings', 'cio_admin_read_subscription_topics',
  'cio_admin_read_subscription_topic', 'cio_admin_read_subscription_channels',
  'cio_admin_read_subscription_languages', 'cio_admin_read_subscription_language',
  'cio_admin_read_subscription_pages', 'cio_admin_read_subscription_order',
  'cio_admin_read_open_tracking_consent', 'cio_admin_read_audit_logs',
  'cio_admin_read_design_readiness',
  'cio_admin_write_frequency_cap_create', 'cio_admin_write_frequency_cap_update',
  'cio_admin_write_frequency_cap_delete', 'cio_admin_write_message_limits_update',
  'cio_admin_write_preserve_unsubscribes_on_merge',
  'cio_admin_write_goal_create', 'cio_admin_write_goal_update', 'cio_admin_write_goal_delete',
  'cio_admin_write_subscription_center_settings',
  'cio_admin_write_subscription_topic_create', 'cio_admin_write_subscription_topic_update',
  'cio_admin_write_subscription_topic_delete', 'cio_admin_write_subscription_channel_upsert',
  'cio_admin_write_subscription_channel_delete', 'cio_admin_write_subscription_languages_create',
  'cio_admin_write_subscription_language_update', 'cio_admin_write_subscription_language_delete',
  'cio_admin_write_subscription_page_create', 'cio_admin_write_subscription_page_update',
  'cio_admin_write_subscription_topic_order', 'cio_admin_write_subscription_channel_order',
  'cio_admin_write_open_tracking_consent',
  'shield_check', 'groundedness_check',
  // mail_archive_* (2026-08-04): built for the CFO's Exchange Online Archive problem (Graph cannot
  // address an in-place archive mailbox at all; this reads it via EWS instead) and EXEC_RING-gated
  // in-handler, but never added here -- same omission class as xero_attachment_upload/catalog_probe/
  // kb_get_document, so it was globally registered yet invisible on every connector. The first four
  // are read-only; mail_archive_save_attachment_to_dataroom is a write_simple tool (writes an
  // attachment into the finance dataroom), dry_run-defaulted like every write tool here and still
  // EXEC_RING-gated -- exposing it is a deliberate, not incidental, mutating capability.
  'mail_archive_list_folders', 'mail_archive_search', 'mail_archive_get_message',
  'mail_archive_download_attachment', 'mail_archive_save_attachment_to_dataroom',
  // Xero (accounting of record). MUST be on the connector surface or the Claude Chat CFO (the whole
  // reason this service exists — no filesystem/CLI to reach the old skills/xero path) cannot SEE
  // them. Execution stays EXEC_RING-gated in each handler, so a non-exec ship lane that sees them is
  // still refused at call time; this list only controls VISIBILITY, not authorization.
  'xero_orgs', 'xero_report', 'xero_accounts', 'xero_manual_journals', 'xero_bank_transactions', 'xero_invoices',
  'xero_get', 'xero_contacts', 'xero_payments', 'xero_credit_notes', 'xero_bank_transfers', 'xero_budgets',
  'xero_settings', 'xero_attachments', 'xero_payroll', 'xero_assets', 'xero_projects', 'xero_files',
  'xero_request', // the write lane (POST/PUT/DELETE); execution stays EXEC_RING-gated in-handler
  // xero_attachment_upload (P0-1, 2026-07-30): a real production gap found by the CFO agent -- the
  // tool was fully built, registered, and reachable via a direct minted-token MCP call, but was
  // simply missing from THIS curated allowlist (its read-side sibling xero_attachments was listed;
  // the write tool never was), so the Claude Chat CFO connector never advertised it. Narrower than
  // the already-exposed xero_request (a single attachment upload vs. arbitrary POST/PUT/DELETE), so
  // adding it does not widen the security model -- it completes an omission within a model that
  // already accepts EXEC_RING in-handler gating as the real authorization boundary for Xero writes.
  'xero_attachment_upload',
  // xero_gl_assemble + xero_connections (CFO round-2 mega-prompt, 2026-07-30): a Copilot review on
  // the PR that added them caught the SAME omission class as xero_attachment_upload above -- both
  // tools were fully built, registered, and EXEC_RING-gated in-handler, but never added to this
  // curated allowlist, so the Claude Chat CFO connector could not see or call the new GL-assembly
  // feature at all. Adding them here is VISIBILITY only (the security boundary is the in-handler
  // isXeroAllowed(ctx.callerAgent) gate, unchanged); see registry.connector-lanes.test.ts.
  'xero_gl_assemble', 'xero_connections',
  // HeyGen durable subscription-OAuth broker: Phase 0 discovery/reconciliation plus bounded CTO-only
  // prompt-avatar, idempotent direct-video, and private artifact-ingestion writes. Visibility here is not
  // authorization: every handler re-checks the exact lane and every write has an exact governance rule.
  // Deliberately absent from the external-readonly set below.
  'heygen_pairing_start', 'heygen_pairing_status', 'heygen_account_get', 'heygen_diagnostics_get',
  'heygen_videos_list', 'heygen_video_get', 'heygen_video_agent_styles_list',
  'heygen_avatar_groups_list', 'heygen_avatar_group_get', 'heygen_avatar_looks_list',
  'heygen_avatar_look_get', 'heygen_voices_list', 'heygen_voice_design', 'heygen_voice_get',
  'heygen_video_statuses_get', 'heygen_video_agent_sessions_list', 'heygen_video_agent_session_get',
  'heygen_video_agent_session_videos_list', 'heygen_video_agent_resource_get', 'heygen_asset_get',
  'heygen_asset_statuses_get', 'heygen_brand_kits_list', 'heygen_brand_glossaries_list',
  'heygen_brand_glossary_get', 'heygen_translation_languages_list', 'heygen_translations_list',
  'heygen_translation_get', 'heygen_translation_statuses_get', 'heygen_proofread_get',
  'heygen_avatar_video_operation_get', 'heygen_owner_approval_status_get', 'heygen_reference_look_operation_get',
  'heygen_prompt_avatar_create', 'heygen_avatar_look_name_update', 'heygen_reference_look_create',
  'heygen_video_agent_session_create_preflight', 'heygen_video_agent_feedback_send_preflight',
  'heygen_video_agent_generation_approve_preflight', 'heygen_video_agent_session_stop_preflight',
  'heygen_asset_upload_preflight', 'heygen_translation_create_preflight', 'heygen_proofread_create_preflight',
  'heygen_proofread_generate_preflight', 'heygen_speech_preview_create_preflight',
  'heygen_avatar_video_create', 'heygen_existing_video_ingest_qa', 'heygen_video_wait_ingest_qa',
] as const;

/**
 * The minimal, non-privileged read set handed to every connector lane that is NOT a ship lane (see
 * isShipLane() below): an unrecognized/self-named connector, an empty caller lane, or any other
 * unknown lane. Deliberately excludes kb_search_privileged, legal_blob_*, every memory WRITE tool,
 * and every github/azure/graph write tool.
 */
export const EXTERNAL_READONLY_TOOLSET: readonly string[] = [
  'brain_search', 'kb_search', 'web_search', 'catalog_list_tools', 'catalog_master',
  'wake', 'memory_recall', 'memory_search', 'gateway_fetch_result',
  // Phase 6: the OpenAI ChatGPT / Deep Research connector contract. Deliberately safe to hand to
  // EVERY external/unrecognized lane: both tools are non-privileged by construction (they reuse
  // brain-search.ts's roomsFor() and fetch independently re-derives + re-checks the ring per call
  // rather than trusting the id) — see kb/openai-search.ts + kb/openai-fetch.ts headers.
  'search', 'fetch',
] as const;

/**
 * True when `lane` is entitled to the full CTO_SHIP_LANE_TOOLSET: the cto/developer engineering
 * identities, or any executive-ring lane. EXEC_RING is IMPORTED (never re-declared) from
 * kb/search-privileged.ts -- the single source of truth for the executive ring, so this can never
 * silently drift from the privileged-index / legal-blob ring gates. Every other lane -- including an
 * empty/unknown caller and any unrecognized connector name -- is NOT a ship lane and falls through
 * to EXTERNAL_READONLY_TOOLSET in connectorToolset() below. Exported so other authorization checks
 * that want "the same set that gets the ship toolset" (e.g. memory-write.ts's ring gate) reuse this
 * EXACT predicate instead of re-declaring it.
 */
export function isShipLane(lane: string): boolean {
  return lane === 'cto' || lane === 'developer' || (EXEC_RING as readonly string[]).includes(lane);
}

/**
 * The per-lane curated connector toolset for THIS request. `lane` is the caller's OAuth-derived
 * agent identity (currentCallerAgent()) at tool-registration time -- registerTool() below always
 * runs inside requestContext.run() (see server/mcp.ts), so this is always live, never stale.
 */
export function connectorToolset(env: Env, lane: string): Set<string> {
  const csv = isShipLane(lane)
    ? env.CONNECTOR_TOOLSET || CTO_SHIP_LANE_TOOLSET.join(',')
    : env.EXTERNAL_READONLY_TOOLSET || EXTERNAL_READONLY_TOOLSET.join(',');
  return new Set<string>(csv.split(',').map((s) => s.trim()).filter(Boolean));
}

export type ToolCategory = 'read' | 'write_simple' | 'write_orchestrated';

export interface ToolAnnotations {
  title: string;
  description: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolContext {
  correlationId: string;
  callerHash: string;
  dryRun: boolean;
  acknowledgeWarning: boolean;
  callerAgent: string;
}

export interface ToolResultPayload {
  /** Machine-readable result. Surfaced via structuredContent. */
  data: unknown;
  /** Optional human-readable summary. Appended after the JSON text block. */
  summary?: string;
  /** Optional before/after pair for audit log on writes. */
  audit?: { before?: unknown; after?: unknown };
  /**
   * Optional grounding hint to opt this tool's output into an automatic outbound groundedness check
   * (Azure Content Safety). Supply the answer text + the source passages it should be grounded in.
   * Only meaningful for tools whose output is model-generated free-text over known sources
   * (e.g. a synthesized recall answer). Omit for tools where groundedness is undefined.
   */
  groundedness?: GroundingHint;
}

export type ToolHandler<Input> = (
  input: Input,
  ctx: ToolContext,
) => Promise<ToolResultPayload>;

export interface ToolDefinition<Shape extends ZodRawShape, Output extends ZodRawShape> {
  name: string;
  category: ToolCategory;
  annotations: ToolAnnotations;
  inputShape: Shape;
  outputShape: Output;
  handler: ToolHandler<z.infer<z.ZodObject<Shape>>>;
  /** Optional safe projection for structured start logs and mutation journaling when raw inputs contain sensitive text. */
  redactInputForLog?: (input: Record<string, unknown>) => unknown;
  /**
   * Optional projection for the company Prompt Shield scan. Use when an input mixes scan-worthy prose
   * with credentials/capability grants/signed URLs that must never be sent to the safety service.
   * Omit to preserve the existing behavior of scanning all handler arguments.
   */
  shieldInputForScan?: (input: Record<string, unknown>) => unknown;
  /**
   * SECURITY (2026-07-28 review fix): set ONLY on a generated M365 prefix-strip alias (see the
   * alias-generation block at the bottom of registerTool) to the REAL tool's name, e.g.
   * "azure_containerapp_get" when name="containerapp_get". Every name-PATTERN-based gate
   * (requiredRoleFor, lane curation, JIT doctrine) MUST evaluate against this canonical identity,
   * not the alias's bare `name` -- a review finding caught the alias otherwise bypassing role
   * gating entirely: "containerapp_get" doesn't match the `azure_*` governance pattern that makes
   * "azure_containerapp_get" CTO-only, so any authenticated lane could call the alias unrestricted.
   * `name` itself stays the SDK lookup key / what a caller actually invokes; only defaults to
   * itself for a primary (non-alias) registration.
   */
  canonicalName?: string;
}

function parseUpstreamToolError(err: unknown): { code: string; nextStep: string; status?: number } | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as Record<string, unknown>;
  if (typeof candidate.code !== 'string') return null;
  if (typeof candidate.nextStep !== 'string') return null;
  if (!candidate.name || (candidate.name !== 'CustomerIoApiError' && candidate.name !== 'N8nWebhookError')) {
    return null;
  }
  return {
    code: candidate.code,
    nextStep: candidate.nextStep,
    status: typeof candidate.status === 'number' ? candidate.status : undefined,
  };
}

const COMMON_INPUT: ZodRawShape = {
  dry_run: z
    .boolean()
    .optional()
    .describe(
      'If true, the tool returns the planned action without executing it. Defaults to DRY_RUN_DEFAULT (true on first deploy) for write tools.',
    ),
  acknowledge_warning: z
    .boolean()
    .optional()
    .describe(
      'If true, the caller accepts that the response may contain regulated or investor-sensitive content (see compliance_warning). Required to render flagged payloads.',
    ),
};

function buildTextContent(
  payload: ToolResultPayload,
  warning: ComplianceWarning | null,
  coldStartWarning?: string,
): string {
  const lines: string[] = [];
  if (coldStartWarning) {
    lines.push(coldStartWarning);
  }
  if (warning) {
    lines.push('COMPLIANCE_WARNING: Pass acknowledge_warning=true to render the underlying data.');
    lines.push(JSON.stringify(warning, null, 2));
  }
  if (payload.data !== null && payload.data !== undefined) {
    lines.push(JSON.stringify(payload.data, null, 2));
  }
  if (payload.summary) {
    lines.push('');
    lines.push(payload.summary);
  }
  return lines.join('\n');
}

function gatedReject(
  env: Env,
  category: ToolCategory,
  toolName: string,
): { rejected: true; reason: string } | { rejected: false } {
  if (category === 'read') return { rejected: false };
  if (env.READ_ONLY_MODE) {
    return {
      rejected: true,
      reason: `Write tool "${toolName}" is disabled because READ_ONLY_MODE=true. Flip READ_ONLY_MODE to false and ENABLE_WRITE_TOOLS to true to enable.`,
    };
  }
  if (!env.ENABLE_WRITE_TOOLS) {
    return {
      rejected: true,
      reason: `Write tool "${toolName}" is disabled because ENABLE_WRITE_TOOLS=false.`,
    };
  }
  if (category === 'write_orchestrated' && !env.ENABLE_HIGH_RISK_TOOLS) {
    return {
      rejected: true,
      reason: `Orchestrated write tool "${toolName}" is disabled because ENABLE_HIGH_RISK_TOOLS=false.`,
    };
  }
  return { rejected: false };
}

/**
 * M365 PREFIX-STRIP COMPAT SHIM (2026-07-26, restructured to TWO-PASS 2026-07-28): every PRIMARY
 * (non-alias) tool name actually registered on a given McpServer instance, tracked UNCONDITIONALLY
 * (not just for M365 requests) so a candidate alias can be checked against it during finalization.
 * Scoped per McpServer instance (WeakMap) rather than module-global so multiple server instances in
 * the same process (e.g. tests, or the stateless per-request servers in server/mcp.ts) never share
 * state.
 */
const primaryNamesByServer = new WeakMap<McpServer, Set<string>>();

/**
 * DEDUP FIX (2026-08-02, "curate-m365-only doesn't shrink the M365 catalog" root cause, part 2 of
 * 2): the primary (long, canonical-named) `RegisteredTool` handle for every M365 static-auth
 * request, keyed by canonical name, ONLY populated when isM365StaticAuth() (see the collection
 * site below) -- so this is a genuine no-op for every other caller. WHY THIS EXISTS: every tool
 * that gets an unambiguous M365 prefix-strip alias (finalizeM365Aliases below) was ALSO still
 * advertised under its full canonical name, so the M365-visible tools/list carried BOTH forms of
 * essentially every tool -- roughly DOUBLING the advertised catalog size for the exact audience
 * TOOL_CATALOG_CURATION_MODE=curate-m365-only exists to shrink (live-measured 2026-08-02: cto
 * 905 canonical tools admitted by curation -> 1655 advertised once aliases were added; clo 48 ->
 * 83). Since M365 Copilot's own tool-calling orchestrator has been repeatedly confirmed (see this
 * shim's header above) to ALWAYS strip and call the SHORT alias form, never the long canonical
 * one, the long form is dead weight for an M365 caller whenever an unambiguous alias exists --
 * finalizeM365Aliases() now `.remove()`s the primary registration in that case (see its body),
 * using the handle captured here, leaving exactly ONE advertised name per tool. A tool whose alias
 * is AMBIGUOUS (2+ canonical tools collide on the same stripped name) keeps its primary
 * registration untouched, exactly as before -- unaffected by this change.
 */
const primaryHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredTool>>();

function primaryHandlesFor(server: McpServer): Map<string, RegisteredTool> {
  let handles = primaryHandlesByServer.get(server);
  if (!handles) {
    handles = new Map<string, RegisteredTool>();
    primaryHandlesByServer.set(server, handles);
  }
  return handles;
}

function primaryNamesFor(server: McpServer): Set<string> {
  let names = primaryNamesByServer.get(server);
  if (!names) {
    names = new Set<string>();
    primaryNamesByServer.set(server, names);
  }
  return names;
}

/**
 * TWO-PASS REDESIGN (2026-07-28 review fix, "first wins can silently mis-route a call"): the
 * original single-pass version registered whichever tool's alias arrived FIRST (import order in
 * tools/index.ts) and left the loser reachable only by its full name. A review finding caught that
 * this is worse than merely "the loser is unreachable by alias" -- since M365's own behavior is to
 * strip and call the SHORT name regardless of which tool the caller meant, a THREE-way collision
 * like n8n_workflow_get / github_workflow_get / depot_workflow_get all stripping to "workflow_get"
 * means whichever registers first SILENTLY ANSWERS A CALL MEANT FOR ONE OF THE OTHER TWO -- wrong
 * data, wrong side effects, or a schema mismatch, not just an inconvenience.
 *
 * Fix: collect every alias CANDIDATE (aliasName -> every {canonicalName, def} that would strip to
 * it) during the normal registration pass, but do not register any of them yet. A NEW
 * finalizeM365Aliases() runs ONCE at the very end of registerAllTools() (after every real tool has
 * registered, so the full candidate set is finally known) and registers an alias ONLY for a name
 * that is genuinely unambiguous: exactly one canonical tool wants it, AND no real primary tool is
 * already registered under that exact name. Any name with 2+ distinct canonical tools competing for
 * it gets NO alias at all -- callers hitting that ambiguity must use a tool's full, unambiguous
 * name (which was always correct), not have a coin-flip winner silently answer for all of them.
 */
interface AliasCandidate {
  canonicalName: string;
  def: ToolDefinition<ZodRawShape, ZodRawShape>;
}
const aliasCandidatesByServer = new WeakMap<McpServer, Map<string, AliasCandidate[]>>();

function aliasCandidatesFor(server: McpServer): Map<string, AliasCandidate[]> {
  let candidates = aliasCandidatesByServer.get(server);
  if (!candidates) {
    candidates = new Map<string, AliasCandidate[]>();
    aliasCandidatesByServer.set(server, candidates);
  }
  return candidates;
}

/**
 * Registers exactly the UNAMBIGUOUS M365 prefix-strip aliases collected during this server
 * instance's registration pass -- call ONCE, after every other registerXxx() call in
 * registerAllTools() has run, so the full candidate set (and the full set of real primary tool
 * names) is known before any alias decision is made. A no-op if no M365 request ever collected any
 * candidates (the collection step itself is gated on isM365StaticAuth() at the call site below).
 */
export function finalizeM365Aliases(server: McpServer, callerHashProvider: () => string): void {
  const candidates = aliasCandidatesByServer.get(server);
  if (!candidates || candidates.size === 0) return;
  const primaryNames = primaryNamesByServer.get(server) ?? new Set<string>();
  for (const [aliasName, entries] of candidates) {
    if (primaryNames.has(aliasName)) {
      // A REAL tool (e.g. "search"/"fetch"/"recall") already owns this exact name -- never eligible
      // to be auto-claimed by an alias, regardless of order. No warning: this is an expected,
      // permanent exclusion, not an ad hoc collision.
      continue;
    }
    const distinctCanonical = new Set(entries.map((e) => e.canonicalName));
    if (distinctCanonical.size > 1) {
      // eslint-disable-next-line no-console
      console.warn(
        `[registry] M365 alias AMBIGUOUS: "${aliasName}" would match ${distinctCanonical.size} different ` +
          `tools (${[...distinctCanonical].join(', ')}) -- registering NONE of them under this name rather ` +
          `than risk silently routing a mis-stripped call to the wrong handler. Callers must use the full name.`,
      );
      continue;
    }
    const { canonicalName, def } = entries[0]!;
    registerTool(server, { ...def, name: aliasName, canonicalName }, callerHashProvider, true);
    // DEDUP FIX (2026-08-02): the alias is unambiguous and just got registered under `aliasName` --
    // M365 Copilot will call it there, never under `canonicalName` (see this shim's header + the
    // primaryHandlesByServer comment above for the evidence). Drop the now-redundant long-form
    // primary registration so the tool is advertised to this M365 caller exactly ONCE instead of
    // twice. `.remove()` is the MCP SDK's own RegisteredTool API (server/mcp.d.ts); it only detaches
    // the tool from THIS McpServer instance (stateless, one per request -- server/mcp.ts), so it
    // cannot affect any other in-flight request or caller.
    const primaryHandle = primaryHandlesByServer.get(server)?.get(canonicalName);
    primaryHandle?.remove();
  }
}

export function registerTool<Shape extends ZodRawShape, Output extends ZodRawShape>(
  server: McpServer,
  def: ToolDefinition<Shape, Output>,
  callerHashProvider: () => string,
  isAlias = false,
): void {
  const env = loadEnv();
  const CONNECTOR_TOOLSET = connectorToolset(env, currentCallerAgent());
  // Claude Chat (DCR) connector requests get a CURATED, findable toolset (not the full ~850) --
  // WHICH curated set depends on the caller's OAuth lane (ship vs external-readonly); see
  // connectorToolset() above, this file's actual security boundary. All other callers see
  // everything, and the startup catalog-warm runs with no request context (currentCallerAgent() ===
  // '', isConnectorSurface() === false) so /health tool_count (deploy gate) is unaffected.
  // SECURITY (2026-07-28 review fix): every name-PATTERN gate below evaluates against the
  // CANONICAL name (see ToolDefinition.canonicalName's doc comment) -- for a primary registration
  // this is just def.name; for a generated alias it's the real tool the alias stands in for.
  const canonicalName = def.canonicalName ?? def.name;
  const connectorSurfaceForThisTool = isConnectorSurface();
  if (connectorSurfaceForThisTool && !CONNECTOR_TOOLSET.has(def.name)) return;
  // PER-LANE TOOL-CATALOG CURATION (Wave 6 item 6.2): extends the SAME idea above to INTERNAL
  // client_credentials lanes (cto/cfo/clo/clo-personal/coo/cro/cpo/cco/developer/exec), which today
  // always see the full catalog because isConnectorSurface() is only ever true for a dcr_/occ_ client
  // (auth/bearer.ts). DEFAULT (TOOL_CATALOG_CURATION_MODE unset, or 'report', or 'off') NEVER filters
  // here -- evaluateCatalogCuration()'s advertise is only ever false when the mode is explicitly
  // 'curate' AND the lane is a KNOWN internal lane AND the tool is outside that lane's seed allowlist
  // (config/lane-toolsets.ts). See safety/tool-catalog-curation.ts for the full mode contract.
  const catalogCurationMode = parseToolCatalogCurationMode(process.env.TOOL_CATALOG_CURATION_MODE);
  const laneForThisTool = currentCallerAgent();
  const catalogCuration = connectorSurfaceForThisTool
    ? null
    : evaluateCatalogCuration(catalogCurationMode, laneForThisTool, canonicalName, isM365StaticAuth());
  if (catalogCuration && !catalogCuration.advertise) return;
  // Record into the Capability Catalog under the CANONICAL name -- recordTool is idempotent by
  // name, so an alias's second call is a harmless no-op rather than polluting the catalog with a
  // fake "service" derived from the alias's stripped bare name (e.g. "containerapp" instead of
  // "azure" for the "containerapp_get" alias of azure_containerapp_get).
  recordTool({
    name: canonicalName,
    service: deriveService(canonicalName),
    category: def.category,
    title: def.annotations.title,
    description: def.annotations.description,
    readOnly: def.annotations.readOnlyHint,
  });
  const inputShape: ZodRawShape = { ...def.inputShape, ...COMMON_INPUT };
  // outputSchema is wrapped: every tool reports compliance_warning + result. HeyGen's production
  // control surface opts into strict result schemas so provider-shape drift cannot bypass redaction.
  const enforceStrictOutput = canonicalName.startsWith('heygen_');
  const strictResultSchema = z.object(def.outputShape).strict();
  const jitStubSchema = z.object({
    _jit_offloaded: z.literal(true),
    result_id: z.string(),
    total_bytes: z.number().int().nonnegative(),
    note: z.string(),
  }).strict();
  const outputShape: ZodRawShape = {
    result: enforceStrictOutput ? z.union([strictResultSchema, jitStubSchema]) : z.unknown(),
    compliance_warning: z
      .object({
        triggers: z.array(z.string()),
        reason: z.string(),
        requires_acknowledge: z.literal(true),
        details: z.array(
          z.object({
            trigger_id: z.string(),
            matched_excerpt: z.string(),
            explanation: z.string(),
          }),
        ),
      })
      .nullable(),
    correlation_id: z.string(),
    dry_run: z.boolean(),
  };

  const toolConfig = connectorSurfaceForThisTool
    ? { description: def.annotations.description, inputSchema: inputShape }
    : {
        title: def.annotations.title,
        description: def.annotations.description,
        inputSchema: inputShape,
        outputSchema: outputShape,
        annotations: {
          title: def.annotations.title,
          readOnlyHint: def.annotations.readOnlyHint,
          destructiveHint: def.annotations.destructiveHint,
          idempotentHint: def.annotations.idempotentHint,
          openWorldHint: def.annotations.openWorldHint,
        },
      };
  const registeredHandle = server.registerTool(
    def.name,
    toolConfig,
    async (rawArgs) => {
      const correlationId = newCorrelationId();
      const callerHash = callerHashProvider();
      const started = Date.now();

      // Strict input validation: reject unexpected fields.
      const inputZ = z.object(inputShape).strict();
      const parsed = inputZ.safeParse(rawArgs);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('\n');
        const errorMsg = `Invalid input for ${def.name}:\n${issues}`;
        logToolEnd({
          correlation_id: correlationId,
          tool: def.name,
          caller_hash: callerHash,
          outcome: 'error',
          latency_ms: Date.now() - started,
          error_code: 'invalid_input',
          error_message: errorMsg,
        });
        return {
          isError: true,
          content: [{ type: 'text', text: errorMsg }],
          structuredContent: {
            result: null,
            compliance_warning: null,
            correlation_id: correlationId,
            dry_run: false,
            error: { code: 'invalid_input', message: errorMsg },
          },
        };
      }

      const args = parsed.data as z.infer<typeof inputZ> & {
        dry_run?: boolean;
        acknowledge_warning?: boolean;
      };
      const dryRun = args.dry_run ?? (def.category === 'read' ? false : env.DRY_RUN_DEFAULT);
      const acknowledged = args.acknowledge_warning === true;

      // Governance: every agent SEES every tool, but some actions are role-gated for EXECUTION.
      const callerAgent = currentCallerAgent();

      // PER-LANE TOOL-CATALOG CURATION (Wave 6 item 6.2), REPORT-MODE telemetry: fire-and-forget,
      // never blocks, never affects the outcome below. Re-reads TOOL_CATALOG_CURATION_MODE fresh from
      // process.env here (rather than reusing the registration-time value above) so this stays
      // flippable without a redeploy, mirroring COLD_START_MODE / JIT_DOCTRINE_MODE's convention of
      // re-parsing the env var at the point of use rather than trusting a value captured earlier.
      // Fires for every actual call attempt from a known internal lane (report or curate mode; 'off'
      // and the connector-surface path are inert here, see recordLaneToolUsage / evaluateCatalogCuration).
      // This is the usage-data mechanism the module header describes -- it never restricts anything
      // by itself; only the registration-time gate above (mode='curate' only) ever does that.
      if (!connectorSurfaceForThisTool) {
        recordLaneToolUsage(
          evaluateCatalogCuration(
            parseToolCatalogCurationMode(process.env.TOOL_CATALOG_CURATION_MODE),
            callerAgent,
            canonicalName,
            isM365StaticAuth(),
          ),
          callerAgent,
          canonicalName,
          callerHash,
        );
      }

      // SECURITY (2026-07-28 review fix): canonicalName, not def.name -- see ToolDefinition's doc
      // comment. Evaluating against an alias's stripped bare name here was a real, live governance
      // bypass (e.g. "containerapp_get" wouldn't match the azure_* CTO-only pattern that
      // "azure_containerapp_get" itself is gated by).
      let gov = requiredRoleFor(canonicalName);
      // High-risk default: any write_orchestrated tool (money / SMS / voice / DNS / build /
      // deploy / irreversible delete) is CTO-only unless an explicit rule already covers it.
      if (!gov && def.category === 'write_orchestrated') {
        gov = { role: 'cto', reason: 'High-risk (write_orchestrated) action — CTO-only by default.' };
      }
      if (gov && !roleAllows(gov.role, callerAgent)) {
        const roleLabel = Array.isArray(gov.role) ? gov.role.join('/') : gov.role;
        const gmsg = `Tool "${def.name}" is restricted to the ${roleLabel} agent(s). ${gov.reason}` +
          (callerAgent ? ` Your identity: ${callerAgent}.` : ' No agent identity on your token.');
        logToolEnd({
          correlation_id: correlationId,
          tool: def.name,
          caller_hash: callerHash,
          outcome: 'rejected',
          latency_ms: Date.now() - started,
          error_code: 'forbidden_role',
          error_message: gmsg,
        });
        return {
          isError: true,
          content: [{ type: 'text', text: gmsg }],
          structuredContent: {
            result: null,
            compliance_warning: null,
            correlation_id: correlationId,
            dry_run: dryRun,
            error: { code: 'forbidden_role', message: gmsg },
          },
        };
      }

      // Write-tool gating.
      const gate = gatedReject(env, def.category, def.name);
      if (gate.rejected) {
        logToolEnd({
          correlation_id: correlationId,
          tool: def.name,
          caller_hash: callerHash,
          outcome: 'rejected',
          latency_ms: Date.now() - started,
          error_code: 'write_disabled',
          error_message: gate.reason,
        });
        return {
          isError: true,
          content: [{ type: 'text', text: gate.reason }],
          structuredContent: {
            result: null,
            compliance_warning: null,
            correlation_id: correlationId,
            dry_run: dryRun,
            error: { code: 'write_disabled', message: gate.reason },
          },
        };
      }

      // COLD-START GATE: a MUTATING tool (any non-'read' category) called by a session that has not
      // called wake() recently gets a non-fatal warning (mode=warn, the default) or is refused
      // outright (mode=enforce). Reads are NEVER gated -- evaluateColdStart isn't even called for
      // them. Fail-open by construction (evaluateColdStart never throws; see safety/cold-start.ts).
      const coldStart = def.category === 'read'
        ? { cold: false, block: false, mode: 'off' as const }
        : evaluateColdStart(callerHash);
      if (coldStart.block) {
        const cmsg = `${COLD_START_MESSAGE} (COLD_START_MODE=enforce; tool "${def.name}" was refused.)`;
        logToolEnd({
          correlation_id: correlationId,
          tool: def.name,
          caller_hash: callerHash,
          outcome: 'rejected',
          latency_ms: Date.now() - started,
          error_code: 'cold_start_enforced',
          error_message: cmsg,
        });
        return {
          isError: true,
          content: [{ type: 'text', text: cmsg }],
          structuredContent: {
            result: null,
            compliance_warning: null,
            correlation_id: correlationId,
            dry_run: dryRun,
            cold_start: { cold: true, blocked: true, mode: coldStart.mode },
            error: { code: 'cold_start_enforced', message: cmsg },
          },
        };
      }

      const ctx: ToolContext = { correlationId, callerHash, dryRun, acknowledgeWarning: acknowledged, callerAgent };

      logToolStart({
        correlation_id: correlationId,
        tool: def.name,
        caller_hash: callerHash,
        input: def.redactInputForLog
          ? def.redactInputForLog(args as Record<string, unknown>)
          : args,
        dry_run: dryRun,
        read_only_mode: env.READ_ONLY_MODE,
      });

      // Strip common fields before passing to handler.
      const handlerInput = { ...args } as Record<string, unknown>;
      delete handlerInput.dry_run;
      delete handlerInput.acknowledge_warning;

      // AUTO-GUARD (inbound): Prompt Shields on the tool-call args, BEFORE the handler runs (no side
      // effect yet, so enforce-blocking here is safe for any category). Fail-open + mode-gated (SHIELD_MODE
      // off|report|enforce, default report) + inert until CONTENT_SAFETY_* is set. report annotates only.
      // canonicalName, not def.name (2026-07-28 review fix): inboundShield's SELF_TOOLS exemption is
      // keyed by canonical names (shield_check/groundedness_check/claims_check) so those tools don't
      // recursively shield-scan their own attack-shaped test input. Passing the alias's stripped
      // name (e.g. "check") would miss that exemption and block a legitimate self-test call.
      const shieldInput = def.shieldInputForScan
        ? def.shieldInputForScan(handlerInput)
        : handlerInput;
      const shield = await inboundShield(canonicalName, shieldInput);
      if (shield.blocked) {
        const smsg =
          `Tool "${def.name}" blocked by Prompt Shields (SHIELD_MODE=enforce): a prompt-injection / ` +
          `jailbreak pattern was detected in the request arguments.`;
        logToolEnd({
          correlation_id: correlationId,
          tool: def.name,
          caller_hash: callerHash,
          outcome: 'rejected',
          latency_ms: Date.now() - started,
          error_code: 'prompt_injection_blocked',
          error_message: smsg,
        });
        return {
          isError: true,
          content: [{ type: 'text', text: smsg }],
          structuredContent: {
            result: null,
            compliance_warning: null,
            correlation_id: correlationId,
            dry_run: dryRun,
            prompt_shield: { attackDetected: true, mode: shield.mode, detail: shield.detail },
            error: { code: 'prompt_injection_blocked', message: smsg },
          },
        };
      }

      try {
        const payload = await def.handler(
          handlerInput as z.infer<z.ZodObject<Shape>>,
          ctx,
        );
        // COLD-START GATE bookkeeping: a successful wake() call marks this bearer identity "awake"
        // for the TTL, clearing the cold-start warning for its subsequent mutating calls. Best-effort
        // (markWoken never throws), so it can never turn a good wake() call into a failure.
        if (def.name === 'wake') {
          markWoken(callerHash);
        }
        const validatedData = enforceStrictOutput
          ? strictResultSchema.parse(payload.data)
          : payload.data;
        const { result, warning } = applyGuardrail(validatedData, acknowledged);

        // AUTO-GUARD (outbound): groundedness on the result, only when the tool surfaced a grounding hint
        // (query + text + sources). enforce-blocking is limited to READ tools — a write already ran, so
        // blocking its output is pointless. Fail-open + mode-gated (GROUNDEDNESS_MODE off|report|enforce).
        const ground = await outboundGroundedness(payload.groundedness, def.category === 'read');
        if (ground.blocked) {
          const gmsg =
            `Tool "${def.name}" output withheld by groundedness detection (GROUNDEDNESS_MODE=enforce): ` +
            `${(ground.ungroundedPercentage * 100).toFixed(0)}% of the answer is unsupported by its cited sources.`;
          logToolEnd({
            correlation_id: correlationId,
            tool: def.name,
            caller_hash: callerHash,
            outcome: 'rejected',
            latency_ms: Date.now() - started,
            error_code: 'ungrounded_blocked',
            error_message: gmsg,
          });
          return {
            isError: true,
            content: [{ type: 'text', text: gmsg }],
            structuredContent: {
              result: null,
              compliance_warning: null,
              correlation_id: correlationId,
              dry_run: dryRun,
              groundedness: { ungroundedDetected: true, ungroundedPercentage: ground.ungroundedPercentage, mode: ground.mode },
              error: { code: 'ungrounded_blocked', message: gmsg },
            },
          };
        }

        const endLog: ToolCallLogEnd = {
          correlation_id: correlationId,
          tool: def.name,
          caller_hash: callerHash,
          outcome: 'success',
          latency_ms: Date.now() - started,
        };
        if (payload.audit?.before !== undefined) endLog.before = payload.audit.before;
        if (payload.audit?.after !== undefined) endLog.after = payload.audit.after;
        logToolEnd(endLog);

        // CAPTURE PLANE (Phase 2): a successful MUTATING, non-dry-run call -- the SAME gate the
        // cold-start block above already computed (coldStart is only evaluated for
        // def.category !== 'read'; dryRun is checked here explicitly since cold-start doesn't
        // gate on it). Two independent, fail-open-by-construction effects:
        //  (1) recordMutation bumps this caller's capture-pressure counter (safety/capture-pressure.ts).
        //      Never throws. SKIPPED for the checkpoint tool itself: checkpoint's own handler
        //      already called recordCheckpoint (which resets mutations to 0) before returning, so
        //      counting the checkpoint call as "one more mutation" here would immediately re-inflate
        //      the counter it just reset, contradicting checkpoint's own "capture pressure reset"
        //      response in the SAME round trip. Mirrors the def.name === 'wake' special-case above
        //      for markWoken (a tool whose success has a side effect on this same safety plane).
        //  (2) journalMutation fires a best-effort "episode" memory of this call (safety/journal.ts),
        //      including for checkpoint itself (a "cto called checkpoint" episode is still useful
        //      signal, unlike the mutation count above). It is NOT awaited -- fired with void +
        //      .catch() so a Cosmos/Search outage can never add latency to, or fail, this response.
        //      Reads and dry-runs are never journaled or counted. AUTO_JOURNAL_MODE=off skips only
        //      the episode write (capture-pressure counting still runs -- a separate, lighter signal).
        if (def.category !== 'read' && !dryRun) {
          if (def.name !== 'checkpoint') recordMutation(callerHash);
          const journaled = parseAutoJournalMode(process.env.AUTO_JOURNAL_MODE) === 'on';
          if (journaled) {
            void journalMutation({
              tool: def.name,
              actor: callerAgent,
              correlationId,
              args: def.redactInputForLog
                ? def.redactInputForLog(handlerInput)
                : handlerInput,
              result,
            }).catch(() => undefined);
          }
          // PHASE 2 SLO TELEMETRY (observe-only): the denominator for the capture-rate SLO
          // (gw_checkpoint / gw_mutation, computed downstream in PostHog). Fires on the SAME gate as
          // the auto-journal above -- every successful mutating, non-dry-run call, including
          // checkpoint itself (checkpoint is excluded only from recordMutation's capture-pressure
          // counter above, not from this gate). captureGatewayEvent is fire-and-forget, inert unless
          // POSTHOG_GATEWAYOPS_KEY is set, and never throws -- it cannot add latency or a new failure
          // mode here.
          captureGatewayEvent('gw_mutation', { tool: def.name, journaled }, callerHash);
        }

        const structured: Record<string, unknown> = {
          result,
          compliance_warning: warning,
          correlation_id: correlationId,
          dry_run: dryRun,
        };
        // Surface auto-guard outcomes when they actually ran (report mode, or enforce-but-clean), so the
        // signal is visible to the caller + audit without changing the result. Absent when not run/inert.
        if (shield.ran) {
          structured.prompt_shield = { attackDetected: shield.attackDetected, mode: shield.mode, detail: shield.detail };
        }
        if (ground.ran) {
          structured.groundedness = { ungroundedDetected: ground.ungroundedDetected, ungroundedPercentage: ground.ungroundedPercentage, mode: ground.mode };
        }

        // JIT DOCTRINE (Phase 2): bind a known, ledgered pitfall to the tool at the exact moment of
        // use, riding along on THIS call's response instead of relying on the agent to remember what
        // wake() told it at session start. Evaluated for EVERY tool category (read AND write) --
        // unlike cold_start/capture_pressure below, a pitfall bound to a READ tool (e.g. a posthog_
        // read defaulting to the PHI project, or legal_blob_get reaching into the privileged personal
        // room) is exactly the moment the agent needs the warning, so this is deliberately NOT gated
        // on `def.category !== 'read'`. Advisory only in v1 (no enforce mode, never blocks); fail-open
        // by construction and never throws (safety/jit-doctrine.ts). Throttled once per (caller, tool)
        // per process so the same pitfall does not nag on every subsequent call.
        // canonicalName, not def.name -- a pitfall bound to e.g. "posthog_" or "azure_containerapp_set_env"
        // should still fire when reached via an M365 alias, not silently go dark under the stripped name.
        const jitDoctrine = evaluateJitDoctrine(callerHash, canonicalName);
        if (jitDoctrine.pitfalls.length) {
          structured.doctrine = { pitfalls: jitDoctrine.pitfalls, mode: jitDoctrine.mode };
          // PHASE 2 SLO TELEMETRY (observe-only): feeds the doctrine-coverage SLO -- how often a
          // bound pitfall actually reached the caller at the point of use. Same fire-and-forget,
          // never-throws guarantee as the gw_mutation emit above; fires for read AND write tools,
          // mirroring evaluateJitDoctrine's own unconditional (not category-gated) evaluation.
          captureGatewayEvent('gw_doctrine_surfaced', { tool: def.name, pitfalls: jitDoctrine.pitfalls.length }, callerHash);
        }

        // coldStart.cold here can only mean mode='warn' (enforce+cold already returned above), so this
        // is always the non-fatal nudge, never a refusal. Surfaced in BOTH the structured content and
        // the text block (mirrors how compliance_warning is prepended) so it is maximally visible.
        let capturePressure: CapturePressureOutcome | null = null;
        if (def.category !== 'read') {
          structured.cold_start = { cold: coldStart.cold, blocked: false, mode: coldStart.mode };
          // CAPTURE-PRESSURE (Phase 2): always surfaced for a mutating call (informational, mirrors
          // cold_start above) regardless of whether THIS call was journaled -- the counter tracks
          // mutation VOLUME since the last checkpoint(), not per-call journaling success. Never
          // touches the mutations/checkpoints counters themselves (only an internal lastNudgeAt
          // timestamp on a live nudge), so it is safe to call even on a dry_run preview. Fail-open
          // by construction; never throws (safety/capture-pressure.ts).
          capturePressure = evaluateCapturePressure(callerHash);
          structured.capture_pressure = {
            mutations: capturePressure.mutations,
            threshold: capturePressure.threshold,
            mode: capturePressure.mode,
          };
        }
        const capturePlanePrelude: string[] = [];
        if (coldStart.cold) capturePlanePrelude.push(COLD_START_MESSAGE);
        if (capturePressure?.nudge) capturePlanePrelude.push(buildCaptureNudgeMessage(capturePressure.mutations));
        // Composes with (does not replace) the cold_start/capture_pressure prelude lines above --
        // all three channel into the SAME capturePlanePrelude array/text block.
        if (jitDoctrine.pitfalls.length) {
          capturePlanePrelude.push(`DOCTRINE: ${jitDoctrine.pitfalls.join(' | ')}`);
        }
        let text = buildTextContent(
          { ...payload, data: result },
          warning,
          capturePlanePrelude.length ? capturePlanePrelude.join('\n') : undefined,
        );

        // JIT tool-payload retrieval: offload an oversized result to Cosmos and return a preview +
        // result_id instead of the full payload (agent pulls it on demand via gateway_fetch_result).
        // Fail-open: offloadResult returns null on any error, so we keep the full inline result.
        // Small results are untouched (backward-compatible).
        //
        // M365 EXCEPTION (2026-07-25): skip offloading entirely for M365 declarative-agent static-
        // token callers (isM365StaticAuth()). Confirmed via direct reproduction that M365 Copilot's
        // own tool-calling orchestrator does NOT reliably chain into gateway_fetch_result when it
        // sees the offload stub -- it reports "no content available" instead, even when
        // gateway_fetch_result is a declared, callable tool on that same agent (Matt hit this live on
        // wake(), whose payload is routinely >40KB). Other engines (Claude Code, Hyperagent) are
        // UNCHANGED -- they reliably use the two-hop pattern today, so this is scoped narrowly to the
        // one consumer confirmed not to support it, not a global behavior change.
        if (shouldOffload(text) && !isM365StaticAuth()) {
          const off = await offloadResult(text, result, correlationId);
          if (off) {
            text = off.preview;
            structured.result = {
              _jit_offloaded: true,
              result_id: off.resultId,
              total_bytes: off.totalBytes,
              note: 'Full payload offloaded to keep context small; call gateway_fetch_result(result_id).',
            };
          }
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent: structured,
        };
      } catch (err) {
        const e = err as Error;
        let errorCode = 'tool_error';
        let nextStep = 'Check server logs for the correlation_id.';
        let upstreamStatus: number | undefined;
        const upstreamErr = parseUpstreamToolError(err);
        if (upstreamErr) {
          errorCode = upstreamErr.code;
          nextStep = upstreamErr.nextStep;
          upstreamStatus = upstreamErr.status;
        }
        const errPayload: Record<string, unknown> = {
          code: errorCode,
          message: e.message,
          next_step: nextStep,
        };
        if (upstreamStatus !== undefined) errPayload.upstream_status = upstreamStatus;
        logToolEnd({
          correlation_id: correlationId,
          tool: def.name,
          caller_hash: callerHash,
          outcome: 'error',
          latency_ms: Date.now() - started,
          error_code: errorCode,
          error_message: e.message,
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Tool ${def.name} failed: ${e.message}\nNext step: ${nextStep}\ncorrelation_id: ${correlationId}`,
            },
          ],
          structuredContent: {
            result: null,
            compliance_warning: null,
            correlation_id: correlationId,
            dry_run: dryRun,
            error: errPayload,
          },
        };
      }
    },
  );

  // M365 PREFIX-STRIP COMPAT SHIM (2026-07-26, WIDENED + HARDENED 2026-07-28): M365 Copilot's own
  // tool-calling orchestrator has been observed splitting a registered tool name on its first
  // underscore and calling only the remainder -- confirmed precedent in memory/recall-alias.ts
  // (2026-07-25: "memory_recall" -> "recall"), then "github_repo_get" -> "repo_get" and
  // "depot_run_list" -> "run_list" (2026-07-26). Originally scoped to just the github_/depot_
  // prefixes. WIDENED 2026-07-28 after a live Developer-agent diagnostic run (Matt, in production
  // M365 Copilot) hit the SAME failure on "catalog_probe" -> "probe" and "developer_wake_lite" ->
  // "wake_lite" -- proving the behavior is generic to ANY underscored tool name.
  //
  // THIS BLOCK ONLY COLLECTS CANDIDATES -- it never registers an alias directly. See
  // finalizeM365Aliases() above for why (a single-pass "first tool through wins" policy was found,
  // in review, to be able to SILENTLY MIS-ROUTE a call to the wrong tool's handler when 3+ tools
  // collide on the same stripped name, e.g. n8n_workflow_get / github_workflow_get /
  // depot_workflow_get all -> "workflow_get" -- not merely leave the loser unreachable). Every
  // primary (non-alias) registration is also tracked in primaryNamesFor() UNCONDITIONALLY (not just
  // for M365 requests) so finalizeM365Aliases() can exclude any candidate name a REAL tool already
  // owns (e.g. "search"/"fetch"/"recall") regardless of registration order.
  //
  // SCOPE (review finding): candidate collection itself is gated behind isM365StaticAuth() -- an
  // unconditional version would collect (and eventually finalize) a compatibility alias for nearly
  // the whole ~850-tool catalog on EVERY request (Claude Code, Hyperagent, connector clients too),
  // materially inflating tools/list size and prompt-token cost for callers that never needed M365
  // compatibility. Each per-request McpServer instance is stateless (server/mcp.ts), so this
  // correctly scopes the extra registrations to only the M365 static-auth request that needs them.
  //
  // GOVERNANCE BYPASS (review finding, the security one): an alias is a recursive registerTool()
  // call with `{...def, name: aliasName}`, so EVERY name-pattern-based gate inside the handler
  // (requiredRoleFor, lane curation, JIT doctrine) was evaluating against the STRIPPED name, not the
  // real tool -- e.g. "containerapp_get" (alias of the CTO-only azure_containerapp_get) doesn't
  // match the `azure_*` governance pattern, so ANY authenticated lane could call it unrestricted.
  // Fixed by passing `canonicalName: def.name` into the alias's def (see ToolDefinition's doc
  // comment) so those gates evaluate the real tool's identity while `name` stays only the SDK
  // lookup key / what the caller actually invokes.
  if (!isAlias) {
    primaryNamesFor(server).add(def.name);
    if (isM365StaticAuth()) {
      const stripped = /^[^_]+_(.+)$/.exec(def.name);
      if (stripped) {
        const aliasName = stripped[1];
        const bucket = aliasCandidatesFor(server);
        const list = bucket.get(aliasName) ?? [];
        // Type erasure to the WeakMap's fixed shape is safe here: def is only ever forwarded
        // opaquely into a later registerTool() call (finalizeM365Aliases), never inspected by
        // field-specific generic logic.
        list.push({ canonicalName: def.name, def: def as unknown as ToolDefinition<ZodRawShape, ZodRawShape> });
        bucket.set(aliasName, list);
        // DEDUP FIX (2026-08-02): remember this primary's RegisteredTool handle so
        // finalizeM365Aliases() can `.remove()` it once it knows whether `aliasName` actually
        // ended up unambiguous (only known after every tool in this request has registered). See
        // primaryHandlesByServer's header comment above for why this matters.
        primaryHandlesFor(server).set(def.name, registeredHandle);
      }
    }
  }
}

export type CallerHashProvider = () => string;
