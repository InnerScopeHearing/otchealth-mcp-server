import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { currentCallerAgent, isM365StaticAuth } from '../../server/request-context.js';

/**
 * developer_wake_lite — a dedicated, unconditionally-tiny wake alternative for M365 Copilot
 * (2026-07-26). Built after wake()'s own M365-lite branch (buildM365LiteWake / isM365StaticAuth(),
 * see wake.ts) STILL returned "NO CONTENT AVAILABLE" live in the M365 Developer agent, even when
 * called with recent_limit=1/memory_limit=1/task_limit=1 -- ruling out "the normal wake payload is
 * just too big" as a sufficient explanation on its own (live evidence from the M365 Developer
 * agent's own self-directed investigation, 2026-07-26).
 *
 * This tool takes NO auth-branch dependency, NO parallel subsystem fan-out (no shared-feed, no
 * Cosmos, no task ledger, no inbox, no inbound reads), and NO JIT offload path -- just a static,
 * guaranteed-small (well under 1KB) response. This exists to definitively separate two remaining
 * hypotheses: "wake()'s own logic/branch has a live bug" vs. "Copilot suppresses ANY tool result
 * for this agent/session regardless of what the gateway actually sends." If this tool ALSO comes
 * back as "no content available", the second hypothesis wins and the fix has to be Copilot-side
 * (a fresh canary app, a different auth pattern, or a Microsoft support escalation) -- no further
 * gateway-side payload-shaping will help. If this tool renders fine while wake() still doesn't,
 * the bug is isolated to wake()'s own M365-lite branch and is worth debugging further there.
 */
export function registerDeveloperWakeLite(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'developer_wake_lite',
      category: 'read',
      annotations: {
        title: 'Diagnostic: minimal guaranteed-small wake response for M365',
        description:
          'A deliberately tiny, unconditional alternative to wake() for diagnosing M365 Copilot tool-result rendering. Returns a short static-shape summary -- no large arrays, no branching logic, no subsystem fan-out -- so it can never itself be "too big". If this ALSO returns no content in a given client, the problem is that client suppressing/ingesting tool output in general, not wake()\'s response size or its isM365StaticAuth() detection branch.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        agent: z.string().optional().describe('Agent lane; defaults to your token identity.'),
      },
      outputShape: {
        summary: z.string(),
        agent: z.string(),
        caller_agent: z.string(),
        is_m365_static_auth: z.boolean(),
        note: z.string(),
      },
      handler: async (input, ctx) => {
        const agent = input.agent || ctx.callerAgent || '(unknown)';
        const data = {
          summary: 'developer_wake_lite: minimal diagnostic response, always tiny.',
          agent,
          caller_agent: currentCallerAgent(),
          is_m365_static_auth: isM365StaticAuth(),
          note: 'If you can read this, tool-result rendering works for this session. Use wake() for real session state; use catalog_probe() for build/registry diagnostics.',
        };
        return { data, summary: data.summary };
      },
    },
    callerHash,
  );
}
