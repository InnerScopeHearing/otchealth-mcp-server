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
// Maximum JSON-escaped UTF-8 bytes carried by one gateway_fetch_result chunk. A raw 30K slice can
// expand past the 40K offload threshold when it contains quotes, backslashes, control characters,
// or lone surrogates. Paging by encoded size keeps the rendered fetch response bounded.
export const PAGE_CHARS = 30000;
export interface ResultStoreDeps {
  newId: (prefix: string) => string;
  upsertDoc: (
    collection: string,
    partitionKey: string,
    doc: Record<string, unknown>,
  ) => Promise<unknown>;
  readDoc: (
    collection: string,
    partitionKey: string,
    id: string,
  ) => Promise<{ doc: Record<string, unknown> } | null>;
  now: () => number;
}

const DEFAULT_RESULT_STORE_DEPS: ResultStoreDeps = {
  newId: cosmos.newId,
  upsertDoc: cosmos.upsertDoc,
  readDoc: cosmos.readDoc,
  now: Date.now,
};

function validCallerHash(callerHash: string): boolean {
  return /^[a-f0-9]{64}$/.test(callerHash);
}


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

function jsonEscapedUtf8Bytes(symbol: string): number {
  const code = symbol.charCodeAt(0);
  if (symbol === '"' || symbol === '\\') return 2;
  if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2;
  if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff)) return 6;
  return Buffer.byteLength(symbol, 'utf8');
}

/** gateway_fetch_result is the terminal retrieval transport and must never produce another id. */
export function mayOffloadToolResult(canonicalName: string): boolean {
  return canonicalName !== 'gateway_fetch_result';
}

function pageBoundaries(s: string): Array<{ start: number; end: number }> {
  const boundaries: Array<{ start: number; end: number }> = [];
  let start = 0;
  let cursor = 0;
  let escapedBytes = 0;
  for (const symbol of s) {
    const cost = jsonEscapedUtf8Bytes(symbol);
    if (escapedBytes > 0 && escapedBytes + cost > PAGE_CHARS) {
      boundaries.push({ start, end: cursor });
      start = cursor;
      escapedBytes = 0;
    }
    escapedBytes += cost;
    cursor += symbol.length;
  }
  if (cursor > start || boundaries.length === 0) boundaries.push({ start, end: cursor });
  return boundaries;
}

/** Page count for serialized text. Numeric input retains the legacy ASCII-size helper contract. */
export function pageCount(value: string | number): number {
  if (typeof value === 'number') return Math.max(1, Math.ceil(value / PAGE_CHARS));
  return pageBoundaries(value).length;
}

/** Clamp + slice serialized text without splitting a Unicode code point. Pure/testable. */
export function pageSlice(s: string, page: number): { page: number; pages: number; chunk: string } {
  const boundaries = pageBoundaries(s);
  const pages = boundaries.length;
  const p = Math.min(Math.max(0, Math.floor(page || 0)), pages - 1);
  const { start, end } = boundaries[p]!;
  return { page: p, pages, chunk: s.slice(start, end) };
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
  callerHash: string,
  deps: ResultStoreDeps = DEFAULT_RESULT_STORE_DEPS,
): Promise<OffloadOutcome | null> {
  try {
    // Never create a bearer-style result object without a verified authenticated caller binding.
    // The registry keeps the full inline response when this returns null.
    if (!validCallerHash(callerHash)) return null;
    const resultId = deps.newId('jitres');
    const now = deps.now();
    // The cache container partitions on /cacheScope. resultId remains the point-read key while
    // caller_hash is the mandatory authorization binding checked before expiry or payload parsing.
    await deps.upsertDoc('cache', resultId, {
      id: resultId,
      cacheScope: resultId,
      type: 'jit_result',
      caller_hash: callerHash,
      correlation_id: correlationId,
      data,
      total_bytes: Buffer.byteLength(fullText, 'utf8'),
      created: new Date(now).toISOString(),
      expiresAt: now + TTL_SECONDS * 1000,
      ttl: TTL_SECONDS + 60,
    });
    return {
      preview: buildPreview(fullText, resultId),
      resultId,
      totalBytes: Buffer.byteLength(fullText, 'utf8'),
    };
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
export async function fetchStoredResult(
  resultId: string,
  page: number,
  callerHash: string,
  deps: ResultStoreDeps = DEFAULT_RESULT_STORE_DEPS,
): Promise<FetchOutcome> {
  if (!validCallerHash(callerHash)) return { found: false };
  const hit = await deps.readDoc('cache', resultId, resultId);
  if (!hit || !hit.doc) return { found: false };
  const doc = hit.doc as Record<string, unknown>;
  // Mismatch and legacy unbound records are indistinguishable from a miss. Check the binding before
  // expiry or serialization so no metadata or payload leaks to another authenticated principal.
  if (doc.type !== 'jit_result' || doc.caller_hash !== callerHash) return { found: false };
  if (typeof doc.expiresAt === 'number' && deps.now() > doc.expiresAt) {
    return { found: false, expired: true };
  }
  const serialized = JSON.stringify(doc.data ?? null, null, 2);
  const sliced = pageSlice(serialized, page);
  return {
    found: true,
    total_bytes: Buffer.byteLength(serialized, 'utf8'),
    page: sliced.page,
    pages: sliced.pages,
    chunk: sliced.chunk,
    created: typeof doc.created === 'string' ? doc.created : undefined,
  };
}
