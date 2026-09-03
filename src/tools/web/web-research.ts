/**
 * web_research — bounded, multi-step open-web research for gateway-connected agents (Task G-3,
 * 2026-09-03). Brings Claude Code's own built-in Tavily connector research capability to every
 * OTHER gateway-connected engine (ChatGPT, Copilot, Hyperagent), the same parity goal as
 * web_search itself.
 *
 * TAVILY-ONLY, UNCONDITIONALLY (unlike web_search's WEB_SEARCH_PROVIDER dispatcher): Tavily's
 * /research endpoint has no Azure (or any other provider) equivalent registered in this gateway,
 * so there is nothing to dispatch between -- this tool always attempts Tavily, and honestly
 * reports {status:'unconfigured'} when TAVILY_API_KEY is unset, independent of whatever
 * WEB_SEARCH_PROVIDER happens to be set to (that env var governs web_search's own provider
 * choice only; it has no bearing here). See providers/tavily-web-research.ts's header for the
 * full research-vs-search tradeoff and Tavily's own async task shape.
 *
 * BOUNDED + RESUMABLE: a research task can genuinely run for minutes, far past any single MCP
 * client's per-call timeout (ChatGPT's is documented at ~45s -- see FND-20260829-e454, the same
 * finding that bounded heygen_video_wait_ingest_qa's poll window). So THIS call polls for at most
 * `max_wait_seconds` and, if the task has not finished, returns status:'pending' plus the
 * `request_id` the caller passes back in on a follow-up call to keep polling the SAME task --
 * never blocks past its own bounded budget. The caps below keep a single call's worst case
 * comfortably under that ~45s ceiling (create is a fast async-task POST, not itself a wait).
 *
 * The MNPI pre-share gate (safety/mnpi-gate.ts, the SAME hard, provider-agnostic gate web_search
 * uses) runs BEFORE any Tavily call, on the free-text `query` when one is supplied. A resume call
 * (only `request_id`, no new `query`) has no new free text to gate -- the original query was
 * already gated when the task was first created.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { evaluateBroadcastMnpiGate } from '../../safety/mnpi-gate.js';
import { tavilyWebResearch } from './providers/tavily-web-research.js';
import type { WebResearchResult } from './providers/tavily-web-research.js';
import { loadDomainGovernance } from './domain-governance.js';

/** Tool-facing bounds, in SECONDS (mirrors heygen_video_wait_ingest_qa's *_seconds convention --
 *  converted to ms only at the provider boundary, matching that tool's own worked example of
 *  keeping a whole call's worst case comfortably under the ChatGPT per-call ceiling). */
const MAX_WAIT_SECONDS = 25;
const DEFAULT_WAIT_SECONDS = 15;
const MIN_POLL_INTERVAL_SECONDS = 1;
const MAX_POLL_INTERVAL_SECONDS = 8;
const DEFAULT_POLL_INTERVAL_SECONDS = 3;

export interface WebResearchToolInput {
  query?: string;
  request_id?: string;
  max_wait_seconds?: number;
  poll_interval_seconds?: number;
}

/**
 * Resolve env (TAVILY_API_KEY, domain governance) and run one bounded Tavily research call.
 * Exported (mirrors web-search.ts's runWebSearch()) so the dispatch logic -- env wiring, the
 * seconds-to-ms conversion, and default handling -- is unit-testable without a full MCP harness.
 * The MNPI gate deliberately stays in the handler below, not here, matching runWebSearch's own
 * documented split ("a provider-agnostic safety check that belongs to the handler").
 */
export async function runWebResearch(input: WebResearchToolInput): Promise<WebResearchResult> {
  const env = loadEnv();
  return tavilyWebResearch(input.query, env.TAVILY_API_KEY, {
    requestId: input.request_id,
    maxWaitMs: (input.max_wait_seconds ?? DEFAULT_WAIT_SECONDS) * 1000,
    pollIntervalMs: (input.poll_interval_seconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
    governance: loadDomainGovernance(env),
  });
}

function summarize(result: WebResearchResult): string {
  switch (result.status) {
    case 'unconfigured':
      return 'Web research not configured (TAVILY_API_KEY unset).';
    case 'error':
      return `Web research (tavily) failed: ${result.error || 'unknown error'}`;
    case 'failed':
      return `Web research task failed: ${result.error || 'unknown error'}`;
    case 'pending':
      return `Web research still running (request_id=${result.request_id}); call web_research again with this request_id to resume.`;
    case 'completed':
      return `Web research (tavily): ${result.citations.length} source(s).`;
    default:
      return `Web research: status=${result.status}.`;
  }
}

export function registerWebResearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'web_research',
      category: 'read',
      annotations: {
        title: 'Open-web multi-step research (read-only)',
        description:
          'Run a deeper, multi-step web research task (plans sub-queries, searches several sources, synthesizes a cited report) for external/public-world topics only — news, market/competitor data, regulations, general research. Costlier and slower than web_search; use web_search first for a quick lookup and reach for this only when a single search-and-answer is not enough. NEVER pass company-confidential, personal, legal, customer, or PHI content here — use brain_search/kb_search for those. Read-only. ASYNC + BOUNDED: a task can take longer than one call\'s wait budget; a "pending" response includes a request_id — call this tool again with that request_id (no need to repeat "query") to keep polling the SAME task. MNPI GATE (hard, code-level): a new query is scanned for an EXEC_RING-gated room reference or an explicit MNPI marker BEFORE it leaves the gateway; a match is refused for every caller, no exception. Domain governance (WEB_SEARCH_DOMAIN_ALLOW/_DENY) applies the same as web_search. Tavily-only (TAVILY_API_KEY) — independent of WEB_SEARCH_PROVIDER.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        query: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe('Public-world research question. Required to START a new task; omit when resuming with request_id (ignored if both are given).'),
        request_id: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Resume a previously started, still-pending research task instead of starting a new one. Comes from a prior "pending" response.'),
        max_wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(`How long THIS call may poll before returning "pending" if the task is not yet done. 0-${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}.`),
        poll_interval_seconds: z
          .number()
          .int()
          .min(MIN_POLL_INTERVAL_SECONDS)
          .max(MAX_POLL_INTERVAL_SECONDS)
          .optional()
          .describe(`Delay between polls while waiting. ${MIN_POLL_INTERVAL_SECONDS}-${MAX_POLL_INTERVAL_SECONDS}, default ${DEFAULT_POLL_INTERVAL_SECONDS}.`),
      },
      outputShape: {
        status: z.string(),
        answer: z.string(),
        citations: z.array(z.unknown()),
        request_id: z.string().optional(),
        error: z.string().optional(),
      },
      handler: async (input) => {
        // MNPI DETERMINISTIC PRE-SHARE GATE (safety/mnpi-gate.ts) -- the SAME gate web_search uses,
        // run BEFORE any Tavily call. Only a NEW query carries free text worth scanning; a resume
        // call (request_id only) sends no new text (see tavilyWebResearch's own contract: query is
        // ignored once requestId is set) so there is nothing here to gate.
        if (input.query) {
          const mnpiGate = evaluateBroadcastMnpiGate({ query: input.query });
          if (mnpiGate.blocked) {
            return {
              data: { status: 'blocked', answer: '', citations: [], error: mnpiGate.reason },
              summary: `Refused: ${mnpiGate.reason}`,
            };
          }
        }
        const result = await runWebResearch(input);
        return { data: result, summary: summarize(result) };
      },
    },
    callerHash,
  );
}
