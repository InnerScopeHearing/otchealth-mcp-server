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
import { loadEnv } from '../config/env.js';
import {
  logToolEnd,
  logToolStart,
  newCorrelationId,
  type ToolCallLogEnd,
} from '../audit/logger.js';
import { applyGuardrail, type ComplianceWarning } from '../compliance/guardrail.js';
import { CustomerIoApiError } from '../customerio/app-api-client.js';
import { N8nWebhookError } from '../n8n/webhook-client.js';
import { recordTool, deriveService } from '../catalog/catalog.js';
import { requiredRoleFor } from '../catalog/governance.js';
import { currentCallerAgent, isConnectorSurface } from '../server/request-context.js';
import { checkGovernance } from '../governance/charter-enforcer.js';
import { shouldOffload, offloadResult } from './result-store.js';
import {
  inboundShield,
  outboundGroundedness,
  type GroundingHint,
} from '../safety/auto-guard.js';

const env = loadEnv();

// Curated toolset advertised to Claude Chat (DCR) connectors so the model gets a focused, FINDABLE set
// instead of the full ~850-tool catalog (which Claude truncates, hiding brain_search). Override via
// env CONNECTOR_TOOLSET (csv). catalog_list_tools is included so a connector can still discover the
// full catalog on demand. Only DCR connector requests are curated; all other callers (startup catalog
// warm, client_credentials lanes, static token) get the full set unchanged.
const CONNECTOR_TOOLSET = new Set<string>(
  (env.CONNECTOR_TOOLSET ||
    [
      'brain_search','web_search','kb_search','kb_search_privileged',
      'memory_recall','memory_search','memory_write','memory_remember','memory_pack','memory_team',
      'llm_azure','catalog_list_tools','catalog_master','gateway_fetch_result',
      'task_list','task_get','task_create','task_update','task_complete','inbox_read','agent_dispatch',
      'posthog_query_hogql','posthog_insight_list',
      'github_get_file_contents','github_list_pull_requests','github_issue_list','sentry_list_issues',
      'graph_send_email','graph_list_messages','cio_get_customer','shield_check','groundedness_check',
    ].join(',')
  ).split(',').map((s) => s.trim()).filter(Boolean),
);

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

function buildTextContent(payload: ToolResultPayload, warning: ComplianceWarning | null): string {
  const lines: string[] = [];
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
  // Claude Chat (DCR) connector requests get a CURATED, findable toolset (not the full ~850). All other
  // callers see everything, and the startup catalog-warm runs with no request context so /health
  // tool_count (deploy gate) is unaffected.
  if (isConnectorSurface() && !CONNECTOR_TOOLSET.has(def.name)) return;
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

  server.registerTool(
    def.name,
    {
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
    },
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

      // Charter enforcement (Phase 5, report-mode by default; see governance/charter-enforcer.ts).
      // GOVERNANCE_MODE is read fresh from process.env inside checkGovernance, so this is a pure
      // no-op (handler always runs, nothing logged) unless GOVERNANCE_MODE is explicitly set to
      // 'report' or 'enforce'. This is a coarser, per-agent-lane/category layer ADDITIONAL to the
      // existing per-tool role gate above; neither replaces the other.
      const charterCheck = checkGovernance(callerAgent, def.name, def.category);
      if (!charterCheck.proceed && charterCheck.denial) {
        const cmsg =
          `Tool "${def.name}" denied by charter enforcement (GOVERNANCE_MODE=enforce). ` +
          charterCheck.denial.reason;
        logToolEnd({
          correlation_id: correlationId,
          tool: def.name,
          caller_hash: callerHash,
          outcome: 'rejected',
          latency_ms: Date.now() - started,
          error_code: 'charter_denied',
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
            error: { code: 'charter_denied', message: cmsg },
          },
        };
      }

      // Write-tool gating.
      const gate = gatedReject(def.category, def.name);
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
        let text = buildTextContent({ ...payload, data: result }, warning);

        // JIT tool-payload retrieval: offload an oversized result to Cosmos and return a preview +
        // result_id instead of the full payload (agent pulls it on demand via gateway_fetch_result).
        // Fail-open: offloadResult returns null on any error, so we keep the full inline result.
        // Small results are untouched (backward-compatible).
        if (shouldOffload(text)) {
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
        if (err instanceof CustomerIoApiError) {
          errorCode = err.code;
          nextStep = err.nextStep;
          upstreamStatus = err.status;
        } else if (err instanceof N8nWebhookError) {
          errorCode = err.code;
          nextStep = err.nextStep;
          upstreamStatus = err.status;
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
