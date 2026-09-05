/**
 * JIT (just-in-time) tool-payload retrieval.
 *
 * Large tool results bloat the agent's context (the serialized payload is embedded in the tool
 * response). This offloads an oversized result to the Cosmos `cache` container under a short-lived
 * result_id and replaces the inline response with a head+tail PREVIEW plus that id; the agent pulls
 * the full payload on demand via the gateway_fetch_result tool.
 *
 * FAIL-OPEN by design: if Cosmos is not configured or any storage step throws, offloadResult returns
 * null and the caller keeps the full inline result. This can never break a tool response. Small
 * results (the vast majority) are never touched, so behavior is backward-compatible.
 */
import * as cosmos from '../agentstate/store.js';

// Offload only when the serialized text exceeds this. Env-overridable. Kept well above typical
// results so only genuinely large payloads are offloaded.
const THRESHOLD_CHARS = Number(process.env.JIT_RESULT_THRESHOLD_CHARS) || 40000;
const TTL_SECONDS = Number(process.env.JIT_RESULT_TTL_SECONDS) || 3600;
const HEAD_CHARS = 4000;
const TAIL_CHARS = 1000;
// Upper bound: a Cosmos document is capped at 2MB. Above ~1.6M chars the stored doc (which also
// carries the full `data`) risks exceeding that, so we don't attempt offload and keep the result
// inline (fail-open). Env-overridable.
const MAX_OFFLOAD_CHARS = Number(process.env.JIT_RESULT_MAX_CHARS) || 1_600_000;
// Page size for gateway_fetch_result. MUST stay below THRESHOLD_CHARS so a fetched page never
// itself re-triggers offload (no recursion).
export const PAGE_CHARS = 30000;

/** True when a result is large enough to offload, within the Cosmos doc cap, AND Cosmos is available. */
export function shouldOffload(text: string): boolean {
  return (
    typeof text === 'string' &&
    text.length > THRESHOLD_CHARS &&
    text.length <= MAX_OFFLOAD_CHARS &&
    cosmos.isConfigured()
  );
}

/** Head+tail preview with a clear pointer to gateway_fetch_result. Pure/testable. */
export function buildPreview(fullText: string, resultId: string): string {
  const head = fullText.slice(0, HEAD_CHARS);
  const tail = fullText.length > HEAD_CHARS + TAIL_CHARS ? fullText.slice(-TAIL_CHARS) : '';
  const marker =
    `\n\n... [JIT: this result (${fullText.length} chars) was offloaded to keep context small. ` +
    `The full payload is stored under result_id="${resultId}". Call gateway_fetch_result with that ` +
    `result_id (and page=0,1,2,... to page through it) to retrieve the full payload. ` +
    `A head + tail preview is shown here.] ...\n\n`;
  return tail ? head + marker + tail : head + marker;
}

export function pageCount(len: number): number {
  return Math.max(1, Math.ceil(len / PAGE_CHARS));
}

/** Clamp + slice a serialized string into a page. Pure/testable. */
export function pageSlice(s: string, page: number): { page: number; pages: number; chunk: string } {
  const pages = pageCount(s.length);
  const p = Math.min(Math.max(0, Math.floor(page || 0)), pages - 1);
  return { page: p, pages, chunk: s.slice(p * PAGE_CHARS, (p + 1) * PAGE_CHARS) };
}

export interface OffloadOutcome {
  preview: string;
  resultId: string;
  totalBytes: number;
}

/**
 * Small, bounded summary of an offloaded payload so a caller can learn population size WITHOUT
 * paging gateway_fetch_result to the tail (CFO close request 2026-09-05, issue #291 part a).
 *
 * Recognised shapes (all optional, all copied by value, nothing else is inspected):
 *  - `data.body.pagination` or `data.pagination` -> {page,pageSize,pageCount,itemCount} (Xero list envelope)
 *  - `data.total_matching` / `data.page` / `data.pages`            (xero_bank_transfers client-side shim)
 *  - for `data.body` (or `data`) each top-level key whose value is an array -> its length, capped at
 *    8 keys, under `array_lengths` (e.g. {Invoices: 100})
 * Returns undefined when nothing recognisable is present. Pure; never throws.
 */
export function extractResultSummary(data: unknown): Record<string, unknown> | undefined {
  try {
    if (!data || typeof data !== 'object') return undefined;
    const d = data as Record<string, unknown>;
    const body = d.body && typeof d.body === 'object' ? (d.body as Record<string, unknown>) : undefined;
    const out: Record<string, unknown> = {};

    const pag = (body?.pagination ?? d.pagination) as Record<string, unknown> | undefined;
    if (pag && typeof pag === 'object') {
      const p: Record<string, unknown> = {};
      for (const k of ['page', 'pageSize', 'pageCount', 'itemCount']) {
        if (typeof pag[k] === 'number') p[k] = pag[k];
      }
      if (Object.keys(p).length) out.pagination = p;
    }

    for (const k of ['total_matching', 'page', 'pages']) {
      if (typeof d[k] === 'number') out[k] = d[k];
    }

    const container = body ?? d;
    const lengths: Record<string, number> = {};
    let n = 0;
    for (const [k, v] of Object.entries(container)) {
      if (Array.isArray(v)) {
        lengths[k] = v.length;
        if (++n >= 8) break;
      }
    }
    if (n) out.array_lengths = lengths;

    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Store the full result in Cosmos (cache) with TTL; return the preview + id, or null (fail-open). */
export async function offloadResult(
  fullText: string,
  data: unknown,
  correlationId: string,
): Promise<OffloadOutcome | null> {
  try {
    const resultId = cosmos.newId('jitres');
    const now = Date.now();
    // The `cache` container partitions on /cacheScope (NOT /id), so the doc MUST carry a cacheScope
    // field equal to the partition-key value we pass. We use resultId for both (cacheScope=id) so a
    // point read is readDoc('cache', resultId, resultId). Cosmos native `ttl` is the best-effort
    // backstop; explicit expiresAt is the authoritative expiry check on read.
    await cosmos.upsertDoc('cache', resultId, {
      id: resultId,
      cacheScope: resultId,
      type: 'jit_result',
      correlation_id: correlationId,
      data,
      total_bytes: fullText.length,
      created: new Date(now).toISOString(),
      expiresAt: now + TTL_SECONDS * 1000,
      ttl: TTL_SECONDS + 60,
    });
    return { preview: buildPreview(fullText, resultId), resultId, totalBytes: fullText.length };
  } catch {
    return null; // fail-open: caller keeps the full inline result
  }
}

export interface FetchOutcome {
  found: boolean;
  total_bytes?: number;
  page?: number;
  pages?: number;
  chunk?: string;
  created?: string;
  expired?: boolean;
}

/** Retrieve a stored result by id, paged. Returns {found:false} on miss/expiry. */
export async function fetchStoredResult(resultId: string, page = 0): Promise<FetchOutcome> {
  const hit = await cosmos.readDoc('cache', resultId, resultId);
  if (!hit || !hit.doc) return { found: false };
  const doc = hit.doc as Record<string, unknown>;
  if (typeof doc.expiresAt === 'number' && Date.now() > doc.expiresAt) return { found: false, expired: true };
  const serialized = JSON.stringify(doc.data ?? null, null, 2);
  const sliced = pageSlice(serialized, page);
  return {
    found: true,
    total_bytes: serialized.length,
    page: sliced.page,
    pages: sliced.pages,
    chunk: sliced.chunk,
    created: typeof doc.created === 'string' ? doc.created : undefined,
  };
}
