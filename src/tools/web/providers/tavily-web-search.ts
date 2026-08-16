/**
 * Tavily provider for web_search (src/tools/web/web-search.ts's WEB_SEARCH_PROVIDER dispatcher) --
 * the Azure-exit replacement (Wave A item A5, runbooks/azure-full-retirement.md). Azure AI Foundry +
 * Grounding-with-Bing was Azure-only BY CONSTRUCTION (no dispatcher, no env flag, no fallback branch
 * at all before this file existed) -- Tavily is a third-party SaaS search API, reachable from
 * anywhere, that does not depend on ANY specific compute cloud. That is what actually removes the
 * Azure dependency; it is also why an AWS-native "equivalent" was never realistic:
 *
 *   - Amazon Bedrock does NOT support Anthropic's `web_search` server tool AT ALL. Confirmed live
 *     2026-08-16 against the primary source (platform.claude.com/docs/en/agents-and-tools/tool-use/
 *     web-search-tool): "Web search is not available on Amazon Bedrock." This is not a config gap --
 *     Bedrock simply has no equivalent capability to wire up.
 *   - "Claude Platform on AWS" (a DIFFERENT product from Bedrock -- Anthropic operates the inference,
 *     AWS only provides IAM auth + AWS Marketplace billing) DOES support web_search, and genuinely
 *     bills through AWS. But standing it up requires a brand-new AWS Marketplace subscription AND a
 *     fully separate Anthropic organization (API keys/workspaces from any existing Anthropic org do
 *     NOT carry over), a one-time account-level `aws iam enable-outbound-web-identity-federation`
 *     step, region-bound workspace creation, and a full rewrite of the response parser (the Anthropic
 *     Messages API's `content: [...]` block shape, not the OpenAI Responses API shape this file's
 *     sibling already speaks) -- a heavyweight new commercial + engineering commitment disproportionate
 *     to replacing one read-only research tool. Left as a documented option, not built.
 *
 * Of the remaining SaaS search APIs (none of which are "AWS spend" either -- they are independent
 * third-party vendors, exactly like Tavily), Tavily was chosen over Brave/Serper/Exa because its
 * `/search` endpoint's `include_answer` parameter returns a SYNTHESIZED ANSWER **and** a source-citation
 * list in ONE call, at the SAME per-credit price as a plain search (Tavily's documented credit table:
 * include_answer adds no extra credits) -- the closest functional match to what Grounding-with-Bing
 * did (search + LLM-synthesized answer + citations, one round trip), so this tool needs no second LLM
 * hop to reconstitute the `answer` field the existing contract requires. The alternatives, for the
 * record (all prices verified 2026-08-16):
 *   - Serper.dev is cheaper raw search ($0.30-$1.00/1,000 queries) but returns bare SERP results, no
 *     synthesized answer -- would need a SECOND call (to this gateway's own chat()/llm_azure) to
 *     produce an `answer`, adding a network hop and a cross-provider dependency for no cost benefit
 *     at this tool's realistic volume.
 *   - Exa's dedicated `/answer` endpoint ($5/1,000 requests) does the same job as Tavily's
 *     include_answer and is slightly cheaper per-call on pure pay-as-you-go, but has no documented
 *     free tier for that endpoint; Tavily's free 1,000 credits/month (no card required) covers this
 *     tool's expected volume outright.
 *   - Brave's Answers endpoint ($4/1,000 queries) adds a SEPARATE per-token charge on top of the base
 *     fee (less predictable cost) and returns an "OpenAI-compatible-ish" shape that still needs
 *     special-tag stripping per Brave's own docs -- more parsing complexity for a less transparent
 *     price than Tavily's flat per-credit rate.
 *
 * POST https://api.tavily.com/search, bearer-token auth. Full pricing + the signup step live on
 * TAVILY_API_KEY's schema comment in config/env.ts (single source of truth so the two never drift).
 */
import { fetchWithBudget } from '../../../util/fetch-budget.js';
import type { WebSearchResult } from './types.js';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/** How many source results to request. Tavily's credit cost is flat per search regardless of
 *  max_results (unlike some competitors, e.g. Serper, which double the per-call cost above 10
 *  results) -- this is a relevance/response-size choice, not a cost one. */
const MAX_RESULTS = 5;

interface TavilySearchResultItem {
  title?: string;
  url?: string;
}

interface TavilySearchResponse {
  answer?: string;
  results?: TavilySearchResultItem[];
  // Tavily's documented error shape is inconsistent across error classes: a top-level `error` string
  // on some 4xx responses, a `{detail: {error: string}}` or bare `{detail: string}` on others. Both
  // are handled defensively below rather than assumed.
  error?: string;
  detail?: { error?: string } | string;
}

export function tavilyWebSearchConfigured(apiKey: string): boolean {
  return Boolean(apiKey);
}

/**
 * Run one Tavily search-and-synthesize call. `apiKey` is passed in explicitly (rather than this
 * module reading TAVILY_API_KEY off loadEnv() itself) so the caller (web-search.ts's dispatcher) is
 * the ONLY place that resolves configuration -- this module stays a pure function of its arguments,
 * matching how azure-web-search.ts's sibling functions take `query` alone (it resolves its OWN env
 * directly rather than through a caller-supplied argument only because it predates this dispatcher
 * and must stay byte-identical; a genuinely new provider has no such constraint, so it takes the key
 * as a parameter -- the more testable shape, and the one this file's own test suite relies on).
 */
export async function tavilyWebSearch(query: string, apiKey: string): Promise<WebSearchResult> {
  if (!tavilyWebSearchConfigured(apiKey)) {
    return { answer: '', citations: [], mode: 'unconfigured' };
  }
  let r: Response;
  try {
    r = await fetchWithBudget(
      TAVILY_SEARCH_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          // 'basic' on both dials: a concise synthesized answer (mirrors the Azure provider's
          // "answer concisely" instruction) at the cheapest credit tier (1 credit; 'advanced' search
          // costs 2). include_answer itself never costs extra regardless of this setting.
          include_answer: 'basic',
          search_depth: 'basic',
          max_results: MAX_RESULTS,
        }),
      },
      // Tavily's own searches are typically fast, but this mirrors the Azure provider's generous 60s
      // ceiling rather than risk a flaky timeout under load -- fetchWithBudget's timeout is a hard
      // CAP, not a fixed wait, so a fast response still returns immediately. Retries:1 is safe here:
      // /search is a read-only, side-effect-free POST-as-query (fetch-budget.ts's own retry contract).
      { timeoutMs: 60_000, retries: 1 },
    );
  } catch {
    // Network error or the AbortSignal.timeout firing -- fetchWithBudget throws in both cases.
    return { answer: '', citations: [], mode: 'error', error: 'web_search timeout' };
  }
  const text = await r.text();
  let j: TavilySearchResponse;
  try {
    j = text ? (JSON.parse(text) as TavilySearchResponse) : {};
  } catch {
    j = {};
  }
  if (!r.ok) {
    const detailMsg = typeof j.detail === 'string' ? j.detail : j.detail?.error;
    const msg = j.error || detailMsg || `HTTP ${r.status}`;
    return { answer: '', citations: [], mode: 'error', error: `tavily ${r.status}: ${String(msg).slice(0, 200)}` };
  }
  const answer = typeof j.answer === 'string' ? j.answer : '';
  const citations = (j.results ?? [])
    .filter((res) => res && (res.url || res.title))
    .map((res) => ({ title: res.title, url: res.url }));
  // Same 4000-char cap as the Azure provider, so a caller reading `answer` sees a consistent bound
  // regardless of which provider actually served the request.
  return { answer: answer.slice(0, 4000), citations, mode: 'web' };
}
