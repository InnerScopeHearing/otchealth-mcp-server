/**
 * Tavily /extract provider for the web_extract MCP tool (Task G-3, 2026-09-03) -- fetches and
 * cleans one or more ALREADY-KNOWN public URLs (contrast web_search/web_research's "find
 * something": this is "read something specific", e.g. a URL a prior citation already returned).
 * Brings Claude Code's own built-in Tavily connector capability to every other gateway-connected
 * engine, matching this file's sibling providers' parity goal.
 *
 * POST https://api.tavily.com/extract, bearer-token auth, SYNCHRONOUS -- unlike /research, /extract
 * returns extracted content directly in one call, no polling. Full request/response shape verified
 * live against docs.tavily.com/documentation/api-reference/endpoint/extract, 2026-09-03 (see this
 * task's PR description for the exact fetched contract).
 *
 * DOMAIN GOVERNANCE (../domain-governance.ts) here is necessarily a PRE-FILTER of the
 * caller-supplied `urls`, not a Tavily request parameter: unlike /search and /research, /extract's
 * documented request shape has NO include_domains/exclude_domains field at all -- it always fetches
 * exactly the URLs it is given, nothing more. So governance instead (a) drops any denied or
 * non-allowlisted URL BEFORE it is ever sent to Tavily -- a denied domain is never even requested,
 * let alone fetched -- and (b) re-checks the URL each result actually carries on the way out (a
 * redirect could in principle land on a different host than requested), as a second, defense-in-
 * depth filter symmetric with web_search's/web_research's result-side post-filter.
 */
import { fetchWithBudget } from '../../../util/fetch-budget.js';
import { filterUrlsByDomain, type DomainGovernance } from '../domain-governance.js';

const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';

/** Tavily's own documented per-request ceiling ("Maximum 20 URLs allowed per request"). A caller
 *  request over this is truncated defensively here rather than sent as-is and left to depend on
 *  the exact shape of Tavily's own rejection -- the tool-level zod schema (web-extract.ts) also
 *  caps `urls` at 20 for the SAME reason belt-and-suspenders is this codebase's norm (see
 *  domain-governance.ts's own deny-then-allow double-check for the identical instinct). */
const MAX_URLS_PER_REQUEST = 20;

/** Per-result content cap. Extract is meant to return a page's real body text (unlike web_search's
 *  short synthesized answer), so this is far more generous than that tool's 4000-char cap, but
 *  still bounded so one enormous page cannot dominate a single tool response. */
const MAX_CONTENT_CHARS = 20_000;

export interface ExtractedPage {
  url: string;
  content: string;
  favicon?: string;
}

export interface FailedExtraction {
  url: string;
  error: string;
}

/** A URL dropped before ever reaching Tavily (governance pre-filter) or dropped from the response
 *  afterward (the SAME governance re-applied, defense in depth) -- see the module header. Kept as
 *  its own list, distinct from `failed`, so a caller can tell "we refused to even ask" apart from
 *  "Tavily tried and could not extract it". */
export interface FilteredUrl {
  url: string;
  reason: string;
}

export interface WebExtractResult {
  /**
   *   'web'             Tavily was called; `results`/`failed` reflect its real response (both
   *                      empty is a legitimate "asked for 1+ URL(s), extracted none of them, all
   *                      failed" outcome -- see `failed` for why each one did).
   *   'domain_blocked'  EVERY requested URL failed domain governance -- Tavily was NEVER called.
   *                      Deliberately distinct from mode:'web' with empty `results`: that would
   *                      misread as "Tavily tried and got nothing", which is not what happened.
   *   'unconfigured'    no TAVILY_API_KEY.
   *   'error'           a transport/HTTP failure talking to Tavily.
   */
  mode: 'web' | 'domain_blocked' | 'unconfigured' | 'error';
  results: ExtractedPage[];
  failed: FailedExtraction[];
  /** URLs domain governance dropped, pre- or post-call. Always present (possibly empty). */
  filtered: FilteredUrl[];
  error?: string;
}

export function tavilyExtractConfigured(apiKey: string): boolean {
  return Boolean(apiKey);
}

interface TavilyExtractResponseItem {
  url?: string;
  raw_content?: string;
  favicon?: string;
}
interface TavilyExtractFailedItem {
  url?: string;
  error?: string;
}
interface TavilyExtractResponse {
  results?: TavilyExtractResponseItem[];
  failed_results?: TavilyExtractFailedItem[];
  error?: string;
  detail?: { error?: string } | string;
}

const PRE_FILTER_REASON = 'blocked by WEB_SEARCH_DOMAIN_DENY, or not on a configured WEB_SEARCH_DOMAIN_ALLOW -- never requested from Tavily';
const POST_FILTER_REASON = 'the returned URL failed domain governance after the call (e.g. a redirect) -- dropped from the result';

/**
 * Extract one or more URLs via Tavily. `urls` is pre-filtered by `governance` BEFORE any network
 * call (see module header); if every URL is governed out, this returns mode:'domain_blocked'
 * without ever contacting Tavily. `opts.query` is Tavily's own optional reranking hint (which
 * chunk of a long page is most relevant), unrelated to domain governance.
 */
export async function tavilyWebExtract(
  urls: string[],
  apiKey: string,
  governance: DomainGovernance,
  opts: { query?: string } = {},
): Promise<WebExtractResult> {
  if (!tavilyExtractConfigured(apiKey)) {
    return { mode: 'unconfigured', results: [], failed: [], filtered: [] };
  }
  const bounded = urls.slice(0, MAX_URLS_PER_REQUEST);
  const { kept: keptUrls, dropped: droppedUrls } = filterUrlsByDomain(
    bounded.map((url) => ({ url })),
    governance,
  );
  const filtered: FilteredUrl[] = droppedUrls.map((d) => ({ url: d.url, reason: PRE_FILTER_REASON }));
  if (keptUrls.length === 0) {
    return { mode: 'domain_blocked', results: [], failed: [], filtered };
  }
  let r: Response;
  try {
    r = await fetchWithBudget(
      TAVILY_EXTRACT_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: keptUrls.map((k) => k.url),
          ...(opts.query ? { query: opts.query } : {}),
        }),
      },
      { timeoutMs: 45_000, retries: 1 },
    );
  } catch {
    return { mode: 'error', results: [], failed: [], filtered, error: 'web_extract timeout' };
  }
  const text = await r.text();
  let j: TavilyExtractResponse;
  try {
    j = text ? (JSON.parse(text) as TavilyExtractResponse) : {};
  } catch {
    j = {};
  }
  if (!r.ok) {
    const detailMsg = typeof j.detail === 'string' ? j.detail : j.detail?.error;
    const msg = j.error || detailMsg || `HTTP ${r.status}`;
    return { mode: 'error', results: [], failed: [], filtered, error: `tavily ${r.status}: ${String(msg).slice(0, 200)}` };
  }
  const rawResults = (j.results ?? [])
    .filter((res): res is TavilyExtractResponseItem & { url: string } => Boolean(res && res.url))
    .map((res) => ({ url: res.url, content: (res.raw_content ?? '').slice(0, MAX_CONTENT_CHARS), favicon: res.favicon }));
  // Post-filter (defense in depth, module header): re-apply the SAME governance to what Tavily
  // actually returned, in case a redirect landed on a different host than requested.
  const { kept: keptResults, dropped: droppedResults } = filterUrlsByDomain(rawResults, governance);
  for (const d of droppedResults) filtered.push({ url: d.url, reason: POST_FILTER_REASON });
  const failed: FailedExtraction[] = (j.failed_results ?? [])
    .filter((f): f is TavilyExtractFailedItem & { url: string } => Boolean(f && f.url))
    .map((f) => ({ url: f.url, error: f.error || 'unknown extraction error' }));
  return { mode: 'web', results: keptResults, failed, filtered };
}
