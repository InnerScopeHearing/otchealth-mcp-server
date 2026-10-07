import type { ProviderRequestBudget } from '../azure/foundry.js';

/** In-memory cache scoped to one caller's search fan-out. Never persist or share this map. */
export type EmbeddingRequestCache = Map<string, {
  deadlineAtMs?: number;
  signal?: AbortSignal;
  promise: Promise<number[] | null>;
}>;

export function createEmbeddingRequestCache(): EmbeddingRequestCache {
  return new Map();
}

/**
 * Deduplicate a same-query embedding within one request, including concurrent room lookups, only
 * when the callers have the same deadline and cancellation signal. A different budget is an
 * independent call and must not replace or evict the owning entry. Rejections stay local to this
 * request so a second room does not start a new provider attempt after its peer already failed.
 */
export function embedWithRequestCache(
  cache: EmbeddingRequestCache,
  query: string,
  start: () => Promise<number[] | null>,
  budget?: ProviderRequestBudget,
  now: () => number = Date.now,
): Promise<number[] | null> {
  if (budget?.signal?.aborted || (budget?.deadlineAtMs !== undefined && now() >= budget.deadlineAtMs)) {
    return Promise.reject(new DOMException('Search request deadline exceeded', 'TimeoutError'));
  }
  const existing = cache.get(query);
  if (existing && existing.deadlineAtMs === budget?.deadlineAtMs && existing.signal === budget?.signal) {
    return existing.promise;
  }
  if (existing) return Promise.resolve().then(start);

  const pending = Promise.resolve().then(start);
  cache.set(query, { deadlineAtMs: budget?.deadlineAtMs, signal: budget?.signal, promise: pending });
  return pending;
}
