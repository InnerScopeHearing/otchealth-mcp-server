/**
 * Bounded fetch for the gateway's hot path.
 *
 * Every hot-path Azure client (Cosmos, AI Search, Foundry, semantic recall) previously issued a
 * bare fetch/undici request with NO timeout and NO retry. On a 1-3 replica Container App with no
 * Log Analytics wired up, one half-open socket (a stalled TLS handshake, a dropped connection, a
 * transient 429/5xx) hangs a request slot forever and is untraceable after the fact. This module
 * gives every such call:
 *   - a hard timeout (AbortSignal.timeout), so a hang fails fast instead of hanging forever;
 *   - ONE retry on a network error, HTTP 429, or HTTP 5xx, with jittered backoff, honoring the
 *     upstream Retry-After header (seconds or an HTTP-date) when present.
 *
 * This wraps the standard `fetch` (not undici's `request`), so callers get a normal `Response`
 * object back. It is only safe to retry idempotent / read-only calls (GET reads, single-document
 * PUT-by-etag, or POST-as-query like Cosmos's query-by-POST and Azure AI Search's search-by-POST);
 * do not point this at a genuinely non-idempotent write without checking the operation is safe to
 * repeat.
 */

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1;
/** Base delay for the jittered backoff between attempts, when Retry-After is absent. */
const BASE_BACKOFF_MS = 300;
/** Cap the parsed/derived backoff so a huge Retry-After value cannot stall a request slot for ages. */
const MAX_BACKOFF_MS = 5000;

export interface FetchBudgetOptions {
  /** Abort the attempt after this many ms. Default 8000. */
  timeoutMs?: number;
  /** How many additional attempts after the first. Default 1 (i.e. up to 2 attempts total). */
  retries?: number;
  /** Optional absolute wall-clock deadline shared by every attempt and the response body read. */
  deadlineAtMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('fetch aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(signal?.reason ?? new Error('fetch aborted'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** True for a response status this helper considers retryable (rate limit or server error). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parse a Retry-After header value (either delay-seconds or an HTTP-date) into a millisecond
 * delay. Returns null when absent or unparseable, so the caller falls back to jittered backoff.
 */
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, MAX_BACKOFF_MS) : 0;
  }
  return null;
}

/** Jittered exponential-ish backoff for attempt N (0-indexed), used when Retry-After is absent. */
function jitteredBackoffMs(attempt: number): number {
  const base = BASE_BACKOFF_MS * (attempt + 1);
  const jitter = Math.random() * base;
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}

/**
 * fetch() with a hard timeout and one bounded retry on a network error / 429 / 5xx.
 *
 * Non-retryable outcomes (2xx, 3xx, and 4xx other than 429) are returned immediately on the
 * first attempt exactly as a bare `fetch` would return them; this helper never changes the
 * caller-visible error/response shape for those cases, only adds a time bound + a safety-net
 * retry for the transient failure modes.
 */
export async function fetchWithBudget(
  url: string | URL,
  init: RequestInit = {},
  opts: FetchBudgetOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.retries ?? DEFAULT_RETRIES;
  const deadlineAtMs = opts.deadlineAtMs;
  const deadlineSignal = deadlineAtMs === undefined
    ? undefined
    : AbortSignal.timeout(Math.max(0, Math.floor(deadlineAtMs - Date.now())));
  const callSignal = init.signal && deadlineSignal
    ? AbortSignal.any([init.signal, deadlineSignal])
    : init.signal ?? deadlineSignal;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (callSignal?.aborted) throw callSignal.reason ?? new Error('fetch aborted');
      const remainingMs = deadlineAtMs === undefined ? timeoutMs : deadlineAtMs - Date.now();
      if (remainingMs <= 0) throw new DOMException('Request deadline exceeded', 'TimeoutError');
      const attemptTimeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(timeoutMs, remainingMs))));
      const attemptSignal = callSignal
        ? AbortSignal.any([callSignal, attemptTimeoutSignal])
        : attemptTimeoutSignal;
      const res = await fetch(url, { ...init, signal: attemptSignal });
      if (attempt < maxRetries && isRetryableStatus(res.status)) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
        const backoffMs = retryAfterMs ?? jitteredBackoffMs(attempt);
        // A retryable response is discarded; cancel its body before sleeping so sockets and
        // unread response data do not outlive the caller's request budget.
        void res.body?.cancel().catch(() => undefined);
        if (deadlineAtMs !== undefined && backoffMs >= deadlineAtMs - Date.now()) {
          await sleep(Math.max(0, deadlineAtMs - Date.now()), callSignal);
          throw new DOMException('Request deadline exceeded before retry', 'TimeoutError');
        }
        await sleep(backoffMs, callSignal);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (callSignal?.aborted) throw err;
      if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) throw err;
      if (attempt < maxRetries) {
        const backoffMs = jitteredBackoffMs(attempt);
        if (deadlineAtMs !== undefined && backoffMs >= deadlineAtMs - Date.now()) {
          await sleep(Math.max(0, deadlineAtMs - Date.now()), callSignal);
          throw err;
        }
        await sleep(backoffMs, callSignal);
        continue;
      }
      throw err;
    }
  }
  // Unreachable in practice (the loop always returns or throws), but keeps TypeScript's control
  // flow analysis happy and gives a clear signal if the loop bounds are ever changed incorrectly.
  throw lastError instanceof Error ? lastError : new Error('fetchWithBudget: exhausted retries');
}
