/**
 * Tool registration helper. Wraps the MCP SDK's registerTool with:
 *  - Zod input validation that REJECTS unexpected fields
 *  - Compliance guardrail scan over outputs
 *  - Audit logging (start/end with correlation IDs, before/after diffs for writes)
 *  - READ_ONLY_MODE / ENABLE_WRITE_TOOLS / ENABLE_HIGH_RISK_TOOLS gating
 *  - Standard MCP tool annotations
 *  - Structured-content responses with text + structured payload
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { requiredRoleFor } from '../catalog/governance.js';
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
  'graph_drive_list', 'graph_drive_download', 'graph_drive_upload',
  'wake', 'checkpoint', 'memory_recall', 'memory_search', 'memory_write', 'memory_remember', 'memory_pack', 'memory_team', 'memory_inbound', 'memory_reconcile',
  // Wave 7 item 7.1: opt-in feedback reporting on a brain_search/kb_search hit (see kb/search.ts,
  // kb/brain-search.ts, memory/retrieval-feedback.ts). Not added to EXTERNAL_READONLY_TOOLSET below,
  // which deliberately excludes every write tool by design; the ship lane is where this is needed.
  'retrieval_feedback',
  'llm_azure', 'catalog_list_tools', 'catalog_master', 'gateway_fetch_result',
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
  // refuses every non-cto caller for the write tools below. Other exec connectors used to merely SEE
  // these entries and get refused if they called them -- as of the 2026-07-15 lane split, a non-ship
  // connector lane no longer even SEES this list at all (it gets EXTERNAL_READONLY_TOOLSET instead),
  // which is this file's actual security boundary; governance.ts's execution-time gating remains a
  // second, independent layer under it.
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
  'graph_send_email', 'graph_list_messages', 'cio_get_customer', 'shield_check', 'groundedness_check',
  // Xero (read-only accounting of record). MUST be on the connector surface or the Claude Chat CFO
  // (the whole reason this service exists — no filesystem/CLI to reach the old skills/xero path)
  // cannot SEE them. Execution stays EXEC_RING-gated in each handler, so a non-exec ship lane that
  // sees them is still refused at call time; this list only controls VISIBILITY, not authorization.
  'xero_orgs', 'xero_report', 'xero_accounts', 'xero_manual_journals', 'xero_bank_transactions', 'xero_invoices',
  'xero_get', 'xero_contacts', 'xero_payments', 'xero_credit_notes', 'xero_bank_transfers', 'xero_budgets',
  'xero_settings', 'xero_attachments', 'xero_payroll', 'xero_assets', 'xero_projects', 'xero_files',
  'xero_request', // the write lane (POST/PUT/DELETE); execution stays EXEC_RING-gated in-handler
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

export function registerTool<Shape extends ZodRawShape, Output extends ZodRawShape>(
  server: McpServer,
  def: ToolDefinition<Shape, Output>,
  callerHashProvider: () => string,
): void {
  const env = loadEnv();
  const CONNECTOR_TOOLSET = connectorToolset(env, currentCallerAgent());
  // Claude Chat (DCR) connector requests get a CURATED, findable toolset (not the full ~850) --
  // WHICH curated set depends on the caller's OAuth lane (ship vs external-readonly); see
  // connectorToolset() above, this file's actual security boundary. All other callers see
  // everything, and the startup catalog-warm runs with no request context (currentCallerAgent() ===
  // '', isConnectorSurface() === false) so /health tool_count (deploy gate) is unaffected.
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
    : evaluateCatalogCuration(catalogCurationMode, laneForThisTool, def.name);
  if (catalogCuration && !catalogCuration.advertise) return;
  // Record into the Capability Catalog so catalog_* tools stay truthful automatically.
  recordTool({
    name: def.name,
    service: deriveService(def.name),
    category: def.category,
    title: def.annotations.title,
    description: def.annotations.description,
    readOnly: def.annotations.readOnlyHint,
  });
  const inputShape: ZodRawShape = { ...def.inputShape, ...COMMON_INPUT };
  // outputSchema is wrapped: every tool reports compliance_warning + result.
  const outputShape: ZodRawShape = {
    result: z.unknown(),
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
  server.registerTool(
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
            def.name,
          ),
          callerAgent,
          def.name,
          callerHash,
        );
      }

      let gov = requiredRoleFor(def.name);
      // High-risk default: any write_orchestrated tool (money / SMS / voice / DNS / build /
      // deploy / irreversible delete) is CTO-only unless an explicit rule already covers it.
      if (!gov && def.category === 'write_orchestrated') {
        gov = { role: 'cto', reason: 'High-risk (write_orchestrated) action — CTO-only by default.' };
      }
      if (gov && callerAgent !== gov.role) {
        const gmsg = `Tool "${def.name}" is restricted to the ${gov.role} agent. ${gov.reason}` +
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
        input: args,
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
      const shield = await inboundShield(def.name, handlerInput);
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
        const { result, warning } = applyGuardrail(payload.data, acknowledged);

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
              args: handlerInput,
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
        const jitDoctrine = evaluateJitDoctrine(callerHash, def.name);
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
}

export type CallerHashProvider = () => string;
