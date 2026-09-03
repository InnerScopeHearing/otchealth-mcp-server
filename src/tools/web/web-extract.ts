/**
 * web_extract — fetch and clean one or more ALREADY-KNOWN public URLs (Task G-3, 2026-09-03).
 * Contrast web_search/web_research's "find something": this is "read something specific", e.g. a
 * URL a prior web_search/web_research citation already returned, or one the caller was otherwise
 * given. Brings Claude Code's own built-in Tavily connector extract capability to every OTHER
 * gateway-connected engine, the same parity goal as web_search/web_research.
 *
 * TAVILY-ONLY, UNCONDITIONALLY (unlike web_search's WEB_SEARCH_PROVIDER dispatcher): same
 * reasoning as web_research -- there is no Azure (or any other provider) /extract equivalent
 * registered in this gateway, so this tool always attempts Tavily and honestly reports
 * {mode:'unconfigured'} when TAVILY_API_KEY is unset, independent of WEB_SEARCH_PROVIDER.
 *
 * SYNCHRONOUS: unlike /research, Tavily's /extract returns extracted content directly in one
 * call -- no polling, no request_id, no "pending" outcome.
 *
 * The MNPI pre-share gate (safety/mnpi-gate.ts, the SAME hard, provider-agnostic gate web_search
 * uses) runs BEFORE any Tavily call, over BOTH the optional free-text `query` reranking hint and
 * the `urls` list itself (the actual content leaving the gateway this call) -- a defensive extra
 * beyond web_search's single-field scan, since here the caller-supplied URLs are the primary
 * outbound payload, not an afterthought.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { evaluateBroadcastMnpiGate } from '../../safety/mnpi-gate.js';
import { tavilyWebExtract } from './providers/tavily-web-extract.js';
import type { WebExtractResult } from './providers/tavily-web-extract.js';
import { loadDomainGovernance } from './domain-governance.js';

/** Tavily's own documented per-request ceiling; mirrored here so the tool schema rejects an
 *  oversized request before it ever reaches the provider (which also bounds it defensively --
 *  see tavily-web-extract.ts's own MAX_URLS_PER_REQUEST doc comment for why both layers check). */
const MAX_URLS = 20;

export interface WebExtractToolInput {
  urls: string[];
  query?: string;
}

/**
 * Resolve env (TAVILY_API_KEY, domain governance) and run one Tavily extract call. Exported
 * (mirrors web-search.ts's runWebSearch() / web-research.ts's runWebResearch()) so the dispatch
 * logic -- env wiring and governance plumbing -- is unit-testable without a full MCP harness. The
 * MNPI gate deliberately stays in the handler below, not here, matching that same documented split.
 */
export async function runWebExtract(input: WebExtractToolInput): Promise<WebExtractResult> {
  const env = loadEnv();
  return tavilyWebExtract(input.urls, env.TAVILY_API_KEY, loadDomainGovernance(env), { query: input.query });
}

function summarize(result: WebExtractResult): string {
  switch (result.mode) {
    case 'unconfigured':
      return 'Web extract not configured (TAVILY_API_KEY unset).';
    case 'error':
      return `Web extract (tavily) failed: ${result.error || 'unknown error'}`;
    case 'domain_blocked':
      return `Web extract: every requested URL was blocked by domain governance (${result.filtered.length} filtered); Tavily was never called.`;
    case 'web': {
      const parts = [`Web extract (tavily): ${result.results.length} page(s) extracted`];
      if (result.failed.length) parts.push(`${result.failed.length} failed`);
      if (result.filtered.length) parts.push(`${result.filtered.length} filtered by domain governance`);
      return `${parts.join(', ')}.`;
    }
    default:
      return `Web extract: mode=${result.mode}.`;
  }
}

export function registerWebExtract(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'web_extract',
      category: 'read',
      annotations: {
        title: 'Open-web page extraction (read-only)',
        description:
          'Fetch one or more already-known public URLs (e.g. from a prior web_search/web_research citation) and return their cleaned page text. This is NOT a search — it reads a specific URL you already have; use web_search or web_research to find URLs first. NEVER pass company-confidential, personal, legal, customer, or PHI content here (as a URL, a query-string value, or the optional reranking hint) — use brain_search/kb_search for those. Read-only. MNPI GATE (hard, code-level): the requested URLs and the optional reranking hint are scanned for an EXEC_RING-gated room reference or an explicit MNPI marker BEFORE anything leaves the gateway; a match is refused for every caller, no exception. Domain governance (WEB_SEARCH_DOMAIN_ALLOW/_DENY) applies: a denied URL is never even requested. Tavily-only (TAVILY_API_KEY) — independent of WEB_SEARCH_PROVIDER; max 20 URLs per call.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        urls: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_URLS)
          .describe(`One or more public URLs to fetch and extract clean text from (max ${MAX_URLS} per call, Tavily's own per-request ceiling).`),
        query: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe('Optional reranking hint: which part of a long page is most relevant. Does not affect which URLs are fetched, only chunk ordering within each result.'),
      },
      outputShape: {
        mode: z.string(),
        results: z.array(z.unknown()),
        failed: z.array(z.unknown()),
        filtered: z.array(z.unknown()),
        error: z.string().optional(),
      },
      handler: async (input) => {
        // MNPI DETERMINISTIC PRE-SHARE GATE (safety/mnpi-gate.ts) -- the SAME gate web_search uses,
        // run BEFORE any Tavily call. Scans both the optional query hint and the URL list itself
        // (joined into one string; scanFieldsForMnpi's substring/regex checks need no delimiter
        // awareness), since the URLs ARE the outbound payload here, not incidental to it.
        const mnpiGate = evaluateBroadcastMnpiGate({ query: input.query, urls: input.urls.join(' ') });
        if (mnpiGate.blocked) {
          return {
            data: { mode: 'blocked', results: [], failed: [], filtered: [], error: mnpiGate.reason },
            summary: `Refused: ${mnpiGate.reason}`,
          };
        }
        const result = await runWebExtract(input);
        return { data: result, summary: summarize(result) };
      },
    },
    callerHash,
  );
}
