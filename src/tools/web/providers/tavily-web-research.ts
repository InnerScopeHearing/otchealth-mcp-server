/**
 * Tavily /research provider for the web_research MCP tool (Task G-3, 2026-09-03) -- Claude Code's
 * own built-in Tavily connector already includes a multi-step research capability; this brings the
 * SAME capability, uniformly, to every OTHER gateway-connected engine (ChatGPT, Copilot,
 * Hyperagent) instead of leaving it exclusive to one client. web_search's single search-and-answer
 * `/search` call stays the cheap default for a quick lookup; this is the deeper "plan sub-queries,
 * search several, synthesize a cited report" tool.
 *
 * ASYNC BY DESIGN: POST https://api.tavily.com/research creates a research task and returns
 * IMMEDIATELY with `{request_id, status:"pending", ...}` -- Tavily documents no synchronous
 * variant, and the create response never carries `content`/`sources` at all (only GET does). This
 * module polls GET https://api.tavily.com/research/{request_id} until the task reaches a terminal
 * state (`completed`/`failed`) or a BOUNDED wait elapses, at which point it returns a `pending`
 * result carrying the `request_id` so the caller resumes by passing it straight back in on a
 * follow-up call -- the SAME bounded-poll-then-resume shape already proven in this codebase by
 * heygen_video_wait_ingest_qa (src/tools/heygen/production-tools.ts, FND-20260829-e454): a
 * multi-step research task can genuinely run for minutes, far past a single MCP client's per-call
 * timeout (ChatGPT's is documented at ~45s), so ONE call must stay individually short regardless of
 * how long the underlying task takes end to end. The tool-level schema (web-research.ts) is what
 * actually bounds `maxWaitMs`/`pollIntervalMs`; this module trusts the values it is given rather
 * than re-clamping them, matching how tavily-web-search.ts trusts its caller-supplied `apiKey`.
 *
 * BOUNDED CREDITS: `/research` costs far more than `/search` -- Tavily's documented per-request
 * range is 4-110 credits for `model="mini"` versus a flat 1 credit for a `/search` call
 * (docs.tavily.com/documentation/api-credits, verified 2026-09-03; `model="pro"` alone can run
 * 15-250 credits). `model` is hardcoded to `"mini"` below and never exposed as a caller-controlled
 * input, so an agent can never accidentally select the far more expensive `"pro"` tier or trigger
 * `"auto"`'s own upgrade heuristic -- mirrors tavily-web-search.ts's own hardcoded 'basic'/'basic'
 * choice for the identical reason (cost control over caller convenience).
 *
 * DOMAIN GOVERNANCE (../domain-governance.ts): `include_domains`/`exclude_domains` are Tavily
 * request-creation parameters only (its docs describe them as bound to the initial POST, with no
 * equivalent parameter on the polling GET) -- so a RESUMED call (an existing `requestId` supplied)
 * does not recompute or resend them; they were already applied when the task was first created.
 * The `sources` a completed task returns are ALSO post-filtered by the SAME governance before being
 * handed back, a code-level backstop independent of how strictly Tavily enforces its own parameter
 * -- its docs explicitly call `include_domains` on THIS endpoint only a "soft preference for
 * sources", not a hard filter (unlike `exclude_domains`, documented as a "hard blocklist").
 *
 * Full request/response shapes verified live against docs.tavily.com/documentation/api-reference/
 * endpoint/{research,research-get}, 2026-09-03 -- see this task's PR description for the exact
 * fetched contract.
 */
import { fetchWithBudget } from '../../../util/fetch-budget.js';
import { filterCitationsByDomain, tavilyDomainRequestParams, type DomainGovernance } from '../domain-governance.js';

const TAVILY_RESEARCH_URL = 'https://api.tavily.com/research';

/** Bounded, cheap, deterministic -- never caller-controlled. See module header. */
const RESEARCH_MODEL = 'mini';

/** Cap on the synthesized report length handed back to a caller. Research reports are meant to be
 *  substantive (unlike search's short synthesized answer), so this is more generous than
 *  tavily-web-search.ts's 4000-char cap, but still bounded against one enormous report dominating a
 *  single tool response. */
const MAX_ANSWER_CHARS = 8_000;

export interface ResearchSource {
  title?: string;
  url?: string;
  favicon?: string;
}

export interface WebResearchResult {
  /**
   *   'completed'      a terminal, synthesized report -- `answer`/`citations` are real.
   *   'pending'        the bounded wait elapsed before the task finished. NOT a failure: call again
   *                     with `request_id` to keep polling the SAME task.
   *   'failed'         Tavily itself reports the task as failed.
   *   'unconfigured'   no TAVILY_API_KEY -- no Tavily task was ever created.
   *   'error'          a transport/HTTP failure talking to Tavily (creating OR polling).
   * Deliberately its own union, distinct from web_search's `WebSearchResult['mode']` ('web' has no
   * meaning here) -- see types.ts's own doc comment for why that file's shape is not reused as-is.
   */
  status: 'completed' | 'pending' | 'failed' | 'unconfigured' | 'error';
  /** The synthesized report. '' unless status:'completed'. */
  answer: string;
  /** Sources, domain-governance-filtered. [] unless status:'completed'. */
  citations: ResearchSource[];
  /** Present on 'pending'/'completed'/'failed' (a real Tavily task exists); absent on
   *  'unconfigured'/'error' from the CREATE step (no task was ever made). Always present on an
   *  'error' that occurred while POLLING an existing task. */
  request_id?: string;
  /** Present on 'failed'/'error'. Never set alongside 'completed'. */
  error?: string;
}

export function tavilyResearchConfigured(apiKey: string): boolean {
  return Boolean(apiKey);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TavilyResearchCreateResponse {
  request_id?: string;
  status?: string;
  error?: string;
  detail?: { error?: string } | string;
}

interface TavilyResearchStatusResponse {
  request_id?: string;
  status?: string;
  content?: string;
  sources?: ResearchSource[];
  error?: string;
  detail?: { error?: string } | string;
}

/** Tavily's documented error shape is inconsistent across error classes (a top-level `error`
 *  string on some, `{detail:{error}}` or bare `{detail: string}` on others) -- both handled
 *  defensively, mirroring tavily-web-search.ts's identical parsing. */
function tavilyErrorMessage(status: number, j: { error?: string; detail?: { error?: string } | string }): string {
  const detailMsg = typeof j.detail === 'string' ? j.detail : j.detail?.error;
  const msg = j.error || detailMsg || `HTTP ${status}`;
  return `tavily ${status}: ${String(msg).slice(0, 200)}`;
}

async function parseJson<T>(r: Response): Promise<T> {
  const text = await r.text();
  try {
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

export interface WebResearchOptions {
  /** Resume polling an in-progress task instead of creating a new one. When set, `query` (the
   *  first parameter to tavilyWebResearch) and `governance` are both ignored for THIS call -- the
   *  task already carries whatever it was created with. */
  requestId?: string;
  /** Total wall-clock budget for THIS call's polling, in ms. See the tool's own schema
   *  (web-research.ts) for the hard cap; this module trusts the value it is given. */
  maxWaitMs: number;
  /** Delay between polls, in ms. */
  pollIntervalMs: number;
  governance: DomainGovernance;
}

async function createResearchTask(
  query: string,
  apiKey: string,
  governance: DomainGovernance,
): Promise<{ ok: true; requestId: string } | { ok: false; result: WebResearchResult }> {
  let r: Response;
  try {
    r = await fetchWithBudget(
      TAVILY_RESEARCH_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: query, model: RESEARCH_MODEL, ...tavilyDomainRequestParams(governance) }),
      },
      { timeoutMs: 30_000, retries: 1 },
    );
  } catch {
    return { ok: false, result: { status: 'error', answer: '', citations: [], error: 'web_research timeout (create)' } };
  }
  const j = await parseJson<TavilyResearchCreateResponse>(r);
  if (!r.ok || !j.request_id) {
    return { ok: false, result: { status: 'error', answer: '', citations: [], error: tavilyErrorMessage(r.status, j) } };
  }
  return { ok: true, requestId: j.request_id };
}

async function pollOnce(
  requestId: string,
  apiKey: string,
): Promise<{ ok: true; body: TavilyResearchStatusResponse } | { ok: false; result: WebResearchResult }> {
  let r: Response;
  try {
    r = await fetchWithBudget(
      `${TAVILY_RESEARCH_URL}/${encodeURIComponent(requestId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      { timeoutMs: 15_000, retries: 1 },
    );
  } catch {
    return { ok: false, result: { status: 'error', answer: '', citations: [], request_id: requestId, error: 'web_research timeout (poll)' } };
  }
  // Tavily's documented contract for this endpoint: HTTP 202 while pending/in_progress, HTTP 200
  // once terminal (completed OR failed -- a failed task is still a 200, per its docs). 202 is
  // accepted here as a non-error response on purpose, so a still-running task is never misread as
  // an HTTP failure; the STATUS FIELD in the body, not the HTTP status code, drives the branching
  // in tavilyWebResearch() below.
  if (!r.ok && r.status !== 202) {
    const j = await parseJson<TavilyResearchStatusResponse>(r);
    return { ok: false, result: { status: 'error', answer: '', citations: [], request_id: requestId, error: tavilyErrorMessage(r.status, j) } };
  }
  const body = await parseJson<TavilyResearchStatusResponse>(r);
  return { ok: true, body };
}

/**
 * Create (or resume) one Tavily research task and poll it for up to `opts.maxWaitMs`. NEVER
 * throws; NEVER silently reports 'completed' with a fabricated empty answer. Returns 'pending'
 * (never blocking past the budget) if the task has not reached a terminal state in time -- see the
 * module header for why the caller must resume with the returned `request_id` rather than this
 * function waiting indefinitely.
 */
export async function tavilyWebResearch(
  query: string | undefined,
  apiKey: string,
  opts: WebResearchOptions,
): Promise<WebResearchResult> {
  if (!tavilyResearchConfigured(apiKey)) {
    return { status: 'unconfigured', answer: '', citations: [] };
  }
  let requestId = opts.requestId;
  if (!requestId) {
    if (!query) {
      return { status: 'error', answer: '', citations: [], error: 'tavilyWebResearch requires either "query" (new task) or opts.requestId (resume).' };
    }
    const created = await createResearchTask(query, apiKey, opts.governance);
    if (!created.ok) return created.result;
    requestId = created.requestId;
  }
  const deadline = Date.now() + opts.maxWaitMs;
  for (;;) {
    const polled = await pollOnce(requestId, apiKey);
    if (!polled.ok) return polled.result;
    const { body } = polled;
    if (body.status === 'completed') {
      const rawSources = Array.isArray(body.sources) ? body.sources : [];
      const citations = filterCitationsByDomain(rawSources, opts.governance);
      const content = typeof body.content === 'string' ? body.content : '';
      return { status: 'completed', answer: content.slice(0, MAX_ANSWER_CHARS), citations, request_id: requestId };
    }
    if (body.status === 'failed') {
      return { status: 'failed', answer: '', citations: [], request_id: requestId, error: 'Tavily reported the research task as failed.' };
    }
    // 'pending' / 'in_progress' (or an unexpected/absent status field -- treated the same: keep
    // polling until the budget elapses, never silently promoted to 'completed').
    if (Date.now() + opts.pollIntervalMs >= deadline) {
      return { status: 'pending', answer: '', citations: [], request_id: requestId };
    }
    await sleep(opts.pollIntervalMs);
  }
}
