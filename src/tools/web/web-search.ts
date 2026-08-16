/**
 * web_search — open-web research for gateway-connected agents. Additive; each provider module it
 * dispatches to is self-contained and reads only its own env.
 *
 * PROVIDER DISPATCHER (WEB_SEARCH_PROVIDER, src/config/env.ts; mirrors SEARCH_BACKEND / BLOB_BACKEND
 * / EMBEDDINGS_PROVIDER's shape exactly -- see that schema entry for the full write-up). This tool
 * was Azure-only BY CONSTRUCTION until 2026-08-16 (Wave A item A5, runbooks/azure-full-retirement.md)
 * -- no dispatcher, no env flag, no fallback branch of any kind, unlike every other Azure dependency
 * in this gateway. Default `'azure'` still resolves to providers/azure-web-search.ts, byte-identical
 * (for the search behavior itself) to every deploy before this dispatcher existed. `'tavily'`
 * resolves to providers/tavily-web-search.ts, the chosen non-Azure replacement -- see that file's
 * header for why Tavily over Brave/Serper/Exa/Bedrock, with real per-query pricing for each.
 *
 * The MNPI pre-share gate below runs BEFORE either provider is even selected -- it is a hard,
 * provider-agnostic safety boundary (safety/mnpi-gate.ts), not part of any provider's own contract.
 * Company/PHI queries must stay on brain_search (web search leaves the compliance boundary), on
 * EVERY provider equally, present or future.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { evaluateBroadcastMnpiGate } from '../../safety/mnpi-gate.js';
import { azureWebSearch } from './providers/azure-web-search.js';
import { tavilyWebSearch } from './providers/tavily-web-search.js';
import type { WebSearchResult } from './providers/types.js';

type Provider = 'azure' | 'tavily';

/** Which provider serves THIS call. Resolved fresh per call (not cached at module scope) -- matches
 *  every other *_PROVIDER/*_BACKEND dispatcher in this codebase (e.g. src/search/index.ts's
 *  activeBackend(), src/azure/foundry.ts's chatTarget()), all of which re-read loadEnv() per call
 *  rather than pin the provider at import time. loadEnv() itself is cached after its first parse, so
 *  this is not a repeated env-parse cost, just consistent style. */
function activeProvider(): Provider {
  return loadEnv().WEB_SEARCH_PROVIDER;
}

/** Dispatch to the resolved provider's implementation. Both providers return the SAME
 *  WebSearchResult shape (providers/types.ts) with no reshaping needed here -- that shared contract
 *  is what makes this a genuine drop-in switch rather than a per-provider special case. */
async function runProviderSearch(provider: Provider, query: string): Promise<WebSearchResult> {
  return provider === 'tavily' ? tavilyWebSearch(query, loadEnv().TAVILY_API_KEY) : azureWebSearch(query);
}

/** Build the tool's free-text `summary` generically from the normalized result, so adding a THIRD
 *  provider later needs no changes here -- only a new branch in runProviderSearch above. Names the
 *  active provider in every branch (a small observability upgrade over the pre-dispatcher tool,
 *  which had exactly one provider so never needed to say which one answered). */
function summarize(provider: Provider, result: WebSearchResult): string {
  if (result.mode === 'unconfigured') return `Web search not configured (WEB_SEARCH_PROVIDER=${provider}).`;
  if (result.mode === 'error') return `Web search (${provider}) failed: ${result.error || 'unknown error'}`;
  return `Web search (${provider}): ${result.citations.length} source(s).`;
}

export function registerWebSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'web_search',
      category: 'read',
      annotations: {
        title: 'Open-web research (read-only)',
        description:
          'Search the public web and return a grounded answer with source citations. Use for external/public-world topics only (news, market/competitor data, regulations, general research). NEVER pass company-confidential, personal, legal, customer, or PHI content here — use brain_search for those. Read-only. MNPI GATE (hard, code-level): the query is scanned for an EXEC_RING-gated room reference or an explicit MNPI marker BEFORE the request leaves the gateway; a match is refused for every caller, no exception (the public web is never a legitimate destination for that content). The underlying search provider is operator-selected (WEB_SEARCH_PROVIDER) and may change; the query always leaves the gateway to a third-party search API regardless of which one is active.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: { query: z.string().min(1).describe('Public-world research query.') },
      outputShape: { answer: z.string(), citations: z.array(z.unknown()), mode: z.string(), error: z.string().optional() },
      handler: async (input) => {
        // MNPI DETERMINISTIC PRE-SHARE GATE (Wave 3 item 3.5, safety/mnpi-gate.ts). Runs BEFORE the
        // query ever leaves the gateway, and BEFORE a provider is even selected. The public web is,
        // by construction, always external/non-privileged: a match is a HARD BLOCK for every caller,
        // no EXEC_RING exception, regardless of which provider WEB_SEARCH_PROVIDER points at.
        const mnpiGate = evaluateBroadcastMnpiGate({ query: input.query });
        if (mnpiGate.blocked) {
          return { data: { answer: '', citations: [], mode: 'blocked', error: mnpiGate.reason }, summary: `Refused: ${mnpiGate.reason}` };
        }
        const provider = activeProvider();
        const result = await runProviderSearch(provider, input.query);
        return { data: result, summary: summarize(provider, result) };
      },
    },
    callerHash,
  );
}
