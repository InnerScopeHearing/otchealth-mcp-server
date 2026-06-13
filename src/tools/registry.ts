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
import { DepotApiError } from '../depot/api-client.js';
import { PostHogApiError } from '../posthog/api-client.js';

const env = loadEnv();

export type ToolCategory = 'read' | 'write_simple' | 'write_orchestrated';

/**
 * Process-level descriptor of every tool the gateway registers. registerTool
 * records each tool here (deduped by name) so the Capability Catalog meta-tools
 * (catalog_list_tools) can enumerate the live tool surface without depending on
 * the per-request McpServer. The server is stateless (a fresh McpServer per
 * request), so this side-table is the durable inventory.
 */
export interface RegisteredToolDescriptor {
  name: string;
  category: ToolCategory;
  title: string;
  description: string;
  destructive: boolean;
  /** Input parameter names (excludes the common dry_run/acknowledge_warning fields). */
  params: string[];
}

const TOOL_REGISTRY = new Map<string, RegisteredToolDescriptor>();

export function getRegisteredTools(): RegisteredToolDescriptor[] {
  return [...TOOL_REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Map a ToolCategory to a coarse read/write flag for catalog reporting. */
export function categoryIsWrite(category: ToolCategory): boolean {
  return category !== 'read';
}

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
}

export interface ToolResultPayload {
  /** Machine-readable result. Surfaced via structuredContent. */
  data: unknown;
  /** Optional human-readable summary. Appended after the JSON text block. */
  summary?: string;
  /** Optional before/after pair for audit log on writes. */
  audit?: { before?: unknown; after?: unknown };
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
  // Record the descriptor (deduped) for the Capability Catalog meta-tools.
  TOOL_REGISTRY.set(def.name, {
    name: def.name,
    category: def.category,
    title: def.annotations.title,
    description: def.annotations.description,
    destructive: def.annotations.destructiveHint,
    params: Object.keys(def.inputShape),
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

      const ctx: ToolContext = { correlationId, callerHash, dryRun, acknowledgeWarning: acknowledged };

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

      try {
        const payload = await def.handler(
          handlerInput as z.infer<z.ZodObject<Shape>>,
          ctx,
        );
        const { result, warning } = applyGuardrail(payload.data, acknowledged);

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

        const structured = {
          result,
          compliance_warning: warning,
          correlation_id: correlationId,
          dry_run: dryRun,
        };
        const text = buildTextContent({ ...payload, data: result }, warning);

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
        } else if (err instanceof DepotApiError) {
          errorCode = err.code;
          nextStep = err.nextStep;
          upstreamStatus = err.status;
        } else if (err instanceof PostHogApiError) {
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
