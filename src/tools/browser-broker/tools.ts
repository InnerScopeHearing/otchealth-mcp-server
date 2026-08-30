import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolResultPayload } from '../registry.js';
import { ProfileLeaseStore } from '../browser-agentcore/policy.js';
import { AgentCoreBrowserTransportError, AwsAgentCorePublicReadOnlyTransport, agentCoreRuntimeConfig, assertAgentCoreConfigured, type AgentCoreBrowserTransport } from '../browser-agentcore/transport.js';
import { browserEnrollmentSnapshot, enrollmentAllows, resolveBrowserEnrollment, validateEnrollmentTargets, type BrowserCapability } from './enrollment.js';

const leases = new ProfileLeaseStore();
const PROVIDER = 'aws-agentcore-browser';
const defaultTransport = new AwsAgentCorePublicReadOnlyTransport();

// FND-20260829-e454: ChatGPT's MCP client hard-times-out any single tool call at 45 seconds. This
// tool's `max_seconds` USED to bound only the per-target navigation loop inside transport.ts's
// inspect(), while several setup/teardown steps (session start, the CDP WebSocket connect,
// Target.getTargets, Target.attachToTarget, and the final session-stop cleanup) each carried their
// OWN independent 15-20s ceiling on top of it -- so the real worst case was ~95s regardless of what
// max_seconds was set to, and the schema let a caller request up to 300s (the DEFAULT was also
// 300s) on top of that. transport.ts's inspect() now treats `maxSeconds` as the deadline for the
// ENTIRE call (every setup step is bounded against the SAME remaining time), so the only budget
// left outside its control is the fixed, independent CLEANUP_TIMEOUT_MS (8s) added in its own
// `finally` block. Capping the caller-visible bound here at 25s keeps the true worst case (25s +
// 8s = 33s) comfortably under both the 40s target and ChatGPT's 45s hard cutoff, with margin for
// MCP transport/JSON overhead on top.
const MAX_INSPECT_SECONDS = 25;
const DEFAULT_INSPECT_SECONDS = 20;

function refusal(code: string, summary: string): ToolResultPayload {
  return { data: { mode: 'refused', error: code }, summary };
}

type EnrollmentDecision = { enrollment: NonNullable<ReturnType<typeof resolveBrowserEnrollment>> } | { refusal: ToolResultPayload };

function enrollmentFor(callerAgent: string | undefined | null, capability: BrowserCapability): EnrollmentDecision {
  const enrollment = resolveBrowserEnrollment(callerAgent);
  if (!enrollment) return { refusal: refusal('agent_not_enrolled', 'Refused: this agent is not enrolled in the AgentCore Browser broker. No browser session was created.') };
  if (!enrollmentAllows(enrollment, capability)) {
    return { refusal: refusal('capability_not_enrolled', `Refused: ${capability} is not enrolled for ${enrollment.callerAgent}. No browser session was created.`) };
  }
  return { enrollment };
}

/**
 * General AgentCore Browser broker. The transport is shared; authority is granted only
 * by an enrolled agent capability profile. Future authenticated and write capabilities
 * require their own transport implementation, enrollment, and approval workflow.
 */
export function registerAgentCoreBrowserBrokerTools(server: McpServer, callerHash: CallerHashProvider, transport: AgentCoreBrowserTransport = defaultTransport): void {
  registerTool(server, {
    name: 'browser_broker_preflight', category: 'read',
    annotations: { title: 'AgentCore Browser broker preflight', description: 'Checks the calling agent enrollment, capability, and target host policy. It creates no browser session.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: { capability: z.enum(['public_read', 'authenticated_read', 'draft_write', 'committed_write']), targets: z.array(z.string()).min(1).max(12) },
    outputShape: { ok: z.boolean(), mode: z.string(), enrollment: z.unknown().optional(), error: z.string().optional() },
    handler: async (input, ctx) => {
      const decision = enrollmentFor(ctx.callerAgent, input.capability);
      if ('refusal' in decision) return decision.refusal;
      const targets = validateEnrollmentTargets(decision.enrollment, input.targets);
      if (!targets.ok) return refusal('target_not_enrolled', `Refused: ${targets.reason}. No browser session was created.`);
      return { data: { ok: true, mode: 'preflight', enrollment: browserEnrollmentSnapshot(decision.enrollment) }, summary: `Browser broker preflight passed for ${decision.enrollment.callerAgent}; no browser session was created.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'browser_broker_inspect_public', category: 'read',
    annotations: { title: 'AgentCore Browser broker public inspection', description: `Runs an enrolled agent public-read browser session and returns redacted evidence receipts only. Bounded to at most ${MAX_INSPECT_SECONDS}s total (default ${DEFAULT_INSPECT_SECONDS}s) so a single call can never approach a 45-second-class MCP client timeout; if the budget is reached before every target is inspected, the response comes back with partial:true and the untouched targets listed in skipped_targets -- call again for just those targets.`, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: { targets: z.array(z.string()).min(1).max(12), max_seconds: z.number().int().min(1).max(MAX_INSPECT_SECONDS).optional() },
    outputShape: { mode: z.string(), receipts: z.array(z.unknown()).optional(), partial: z.boolean().optional(), skipped_targets: z.array(z.string()).optional(), error: z.string().optional() },
    handler: async (input, ctx) => {
      const decision = enrollmentFor(ctx.callerAgent, 'public_read');
      if ('refusal' in decision) return decision.refusal;
      const enrollment = decision.enrollment;
      const targets = validateEnrollmentTargets(enrollment, input.targets);
      if (!targets.ok) return refusal('target_not_enrolled', `Refused: ${targets.reason}. No browser session was created.`);
      const runtime = agentCoreRuntimeConfig();
      try { assertAgentCoreConfigured(runtime); } catch (error) {
        const e = error as AgentCoreBrowserTransportError;
        return { data: { mode: e.code, error: e.code }, summary: `${e.message} ${e.nextStep}` };
      }
      if (!leases.acquire(PROVIDER, enrollment.callerAgent, enrollment.profileLabel)) {
        return { data: { mode: 'busy', error: 'profile_in_use' }, summary: 'Refused: this enrolled browser identity already has an active lease.' };
      }
      try {
        const result = await transport.inspect(targets.urls, input.max_seconds ?? DEFAULT_INSPECT_SECONDS);
        const data: Record<string, unknown> = { mode: 'public_read', receipts: result.receipts };
        if (result.partial) {
          data.partial = true;
          data.skipped_targets = result.skipped_targets ?? [];
        }
        return {
          data,
          summary: result.partial
            ? `Completed ${result.receipts.length} of ${targets.urls.length} redacted public receipt(s) for ${enrollment.callerAgent} before the bounded time budget was reached; ${result.skipped_targets?.length ?? 0} target(s) were not inspected -- see skipped_targets.`
            : `Completed ${result.receipts.length} redacted public receipt(s) for ${enrollment.callerAgent}.`,
        };
      } catch (error) {
        const e = error as AgentCoreBrowserTransportError;
        return { data: { mode: e.code || 'provider_error', error: e.code || 'provider_error' }, summary: `${e.message || 'Browser provider failed.'} ${e.nextStep || 'No browser state was retained.'}` };
      } finally {
        leases.release(PROVIDER, enrollment.callerAgent, enrollment.profileLabel);
      }
    },
  }, callerHash);
}
