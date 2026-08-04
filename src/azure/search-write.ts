/**
 * WRITE-THROUGH INDEXING — make a memory searchable the INSTANT it is written.
 *
 * ===================== THE TWO GAPS THIS CLOSES (found 2026-07-13/14) =====================
 *
 * GAP 1 — THE COSMOS MEMORY-OF-RECORD WAS INVISIBLE TO THE BRAIN.
 *   skills/kb-memory/semantic.mjs -- the ONLY thing that populates the `memory-exec` index --
 *   says in its own line-8 comment that it "indexes ONLY the shared exec feed". No indexer,
 *   anywhere, reads Cosmos. So `memory_write` (-> Cosmos) produced records that were durable,
 *   byte-exact... and COMPLETELY UNSEARCHABLE by brain_search / kb_search / any semantic path.
 *   Only a deterministic substring query with exactly the right keywords could ever find them.
 *   That is dangerous precisely because memory_write's own description calls it "the verbatim
 *   SYSTEM-OF-RECORD" -- agents reasonably assume durable also means findable. It did not.
 *
 * GAP 2 — EVEN THE SHARED FEED HAD UP TO A 6-HOUR BLIND WINDOW.
 *   brain-reindex runs `0 *\/6`. A memory written at 21:04 is not searchable until 00:00. An
 *   agent that records a critical finding and hands off 20 minutes later has handed off
 *   something the next session literally cannot retrieve.
 *
 * ===================== WHY WRITE-THROUGH IS SAFE HERE =====================
 * semantic.mjs is INCREMENTAL and NEVER DELETES: it filters `!have.has(docId(...))` and uses
 * `@search.action: mergeOrUpload`. So if we push with the SAME docId format (`agent__id`), the
 * 6-hourly reindex simply sees the doc already present and skips it. Idempotent, no duplicates,
 * no wasted embedding calls, no risk of the cron pruning what we wrote.
 *
 * ===================== FAIL-OPEN, ALWAYS =====================
 * Indexing is a CONVENIENCE on top of the durable store. A memory write must NEVER fail because
 * the index was unreachable. Every failure path here returns {indexed:false, reason} and throws
 * nothing. The record is already safe in Cosmos/blob; the 6-hourly reindex remains the backstop
 * for the shared feed. We report the outcome rather than swallowing it: a silent indexing failure
 * is exactly how we lost 12 days of recall.
 */
import { loadEnv } from '../config/env.js';
import { embed } from './foundry.js';
import { searchAdminKey } from './arm-client.js';

const API_VERSION = '2024-07-01';
const MAX_TEXT = 16000; // mirrors semantic.mjs

export interface IndexResult {
  indexed: boolean;
  reason?: string;
  docId?: string;
  vector?: boolean;
}

/** Same key derivation as semantic.mjs docId() — MUST match, or the reindex would create a duplicate. */
export function memoryDocId(agent: string, id: string): string {
  return `${agent}__${id}`.replace(/[^A-Za-z0-9_\-=]/g, '_');
}

/** Derive the Search SERVICE name from the endpoint (https://<service>.search.windows.net). Pure. */
export function serviceFromEndpoint(endpoint: string): string | null {
  const m = (endpoint || '').match(/^https:\/\/([a-z0-9-]+)\.search\.windows\.net/i);
  return m ? m[1] : null;
}

/** Build the exact document shape memory-exec expects (mirrors semantic.mjs line 189). Pure. */
export function buildMemoryDoc(input: {
  agent: string;
  id: string;
  type?: string;
  ts?: string;
  tags?: string[];
  text: string;
  vector: number[] | null;
}): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    '@search.action': 'mergeOrUpload',
    id: memoryDocId(input.agent, input.id),
    agent: input.agent,
    type: input.type || '',
    ts: input.ts || '',
    tags: (input.tags || []).join(', '),
    text: (input.text || '').slice(0, MAX_TEXT),
  };
  // A doc with no vector is still fully BM25/semantic searchable -- degrade, never drop.
  if (input.vector) doc.contentVector = input.vector;
  return doc;
}

/**
 * Push one memory into the semantic index immediately. FAIL-OPEN: never throws.
 * `index` defaults to memory-exec (the room brain_search federates over).
 */
export async function indexMemoryNow(input: {
  agent: string;
  id: string;
  type?: string;
  ts?: string;
  tags?: string[];
  text: string;
  index?: string;
  /**
   * Precomputed embedding, REUSED instead of re-embedding. The write path (memory_write /
   * memory_remember) now embeds the text once for auto-supersession detection and hands the same
   * vector here, so we do not embed the identical text twice. Semantics: `undefined` (the default,
   * every pre-existing caller) => embed here as before; a real array => index with it; `null` => an
   * upstream embed already FAILED, so index without a vector and do NOT retry (still fully
   * keyword+semantic searchable — degrade, never drop).
   */
  vector?: number[] | null;
}): Promise<IndexResult> {
  const index = input.index || 'memory-exec';
  const docId = memoryDocId(input.agent, input.id);
  try {
    const env = loadEnv();
    const endpoint = (env.AZURE_SEARCH_ENDPOINT || '').replace(/\/+$/, '');
    if (!endpoint) return { indexed: false, reason: 'AZURE_SEARCH_ENDPOINT not configured', docId };

    const service = serviceFromEndpoint(endpoint);
    if (!service) return { indexed: false, reason: `cannot derive search service from endpoint`, docId };

    // Writes need an ADMIN key; the query key the gateway normally uses cannot index documents.
    const key = await searchAdminKey(service);

    // Embed for vector recall. If embedding is unavailable, still index -- keyword+semantic beats nothing.
    // Reuse a caller-supplied vector when present (the write path already embedded this exact text);
    // only embed here when the caller did not pass the field at all (undefined).
    let vector: number[] | null;
    if (input.vector !== undefined) {
      vector = input.vector;
    } else {
      try {
        vector = await embed(input.text);
      } catch {
        vector = null;
      }
    }

    const doc = buildMemoryDoc({ ...input, vector });
    const r = await fetch(`${endpoint}/indexes/${index}/docs/index?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: [doc] }),
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      return { indexed: false, reason: `search index ${r.status}: ${body}`, docId, vector: Boolean(vector) };
    }
    return { indexed: true, docId, vector: Boolean(vector) };
  } catch (e) {
    return { indexed: false, reason: (e as Error).message, docId };
  }
}

/**
 * ===================== DE-INDEXING A MOVED/DELETED BLOB PATH (2026-08-04) =====================
 *
 * THE GAP THIS CLOSES (CLO field report, PR #191 acceptance test, Finding 3): legal_blob_delete's
 * soft-delete MOVES a blob to `_TRASH/<original-path>`. The CHUNKED doc rooms (legal-personal,
 * legal-company, ...) are fed by native Azure Blob PULL-indexers on a slow cadence (up to 168h,
 * see setup/expected-indexes.json in otchealth-claude-tools) with NO deletion-detection policy
 * configured. A pull-indexer only ADDS/UPDATES on each run; it never removes an index entry just
 * because the source blob is gone from the path it last saw. So a soft-deleted (or moved) blob's
 * search-index entry survives INDEFINITELY, still citing the OLD path -- and PR #191's own
 * `_TRASH/`-prefix filter in search.ts cannot catch this, because the filter checks the INDEXED
 * path (still the pre-move value), never the blob's CURRENT location. Confirmed live: a search hit
 * for a path soft-deleted an hour earlier, with `legal_blob_get` on that exact path returning
 * `found:false` -- a false "document does not exist" on evidence that is one path away.
 *
 * THE FIX: legal_blob_delete (and legal_blob_move, which has the identical stale-path problem)
 * call `deindexChunkedPath` on the ORIGINAL path immediately after a successful blob move, so the
 * index never carries a dangling reference to a path that no longer resolves. This is a genuine
 * DELETE from the search index (not a soft-delete convention of its own) -- the index is a
 * derived, rebuildable view; the blob move to `_TRASH/` remains the durable, recoverable record.
 *
 * FAIL-OPEN, ALWAYS (mirrors indexMemoryNow's contract exactly): the blob move has ALREADY
 * happened by the time this runs. A failure here (auth, network, the room not yet cut over, an
 * unfilterable field) must never surface as a failure of the blob operation itself -- it is
 * best-effort cleanup on top of an already-durable change, not a precondition for it.
 */

export interface DeindexResult {
  /** False only when this could not even be attempted (search unconfigured). */
  attempted: boolean;
  /** Number of chunk documents actually deleted from the index (0 is normal: the room may not
   *  have indexed this path yet, or already reflects a newer state). */
  deleted: number;
  reason?: string;
}

/** Locate every chunk document in `index` whose `path` field exactly equals `path`. Tries a
 *  server-side $filter first (cheap, precise); on a 400 (path not filterable on this room's
 *  schema) falls back ONCE to a keyword search restricted to the `path` field with a client-side
 *  EXACT-match check -- the identical shape azure/search.ts's getChunkedDocument already uses for
 *  the same "look up a chunked room by a path-like key" problem, so this is a proven pattern, not
 *  a new one. Bounded to 200 chunks (a single source document never legitimately has anywhere near
 *  that many; this is a backstop, not an expected ceiling). Returns [] on any failure -- the caller
 *  (deindexChunkedPath) treats an empty result as "nothing to delete", which is fail-open by
 *  construction (a lookup failure and a genuine zero-match look identical, and both correctly do
 *  nothing rather than guess).
 */
export async function findChunkIdsByPath(endpoint: string, key: string, index: string, path: string): Promise<string[]> {
  const doSearch = (body: Record<string, unknown>) =>
    fetch(`${endpoint}/indexes/${index}/docs/search?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const escaped = path.replace(/'/g, "''");
  try {
    const primary = { search: '*', filter: `path eq '${escaped}'`, select: 'chunk_id,path', top: 200 };
    let r = await doSearch(primary);
    if (!r.ok) {
      const fallback = { search: path, searchFields: 'path', queryType: 'simple', select: 'chunk_id,path', top: 200 };
      r = await doSearch(fallback);
      if (!r.ok) return [];
      const j = (await r.json()) as { value?: Array<Record<string, unknown>> };
      return (j.value || []).filter((d) => d.path === path).map((d) => String(d.chunk_id)).filter(Boolean);
    }
    const j = (await r.json()) as { value?: Array<Record<string, unknown>> };
    return (j.value || []).map((d) => String(d.chunk_id)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Delete every chunk document at `path` from `index` (a chunked doc room). See the section header
 * above for the full rationale. FAIL-OPEN: never throws; every failure mode returns
 * `{attempted, deleted:0, reason}`. Callers (legal_blob_delete, legal_blob_move) should call this
 * AFTER their own blob mutation has already succeeded, and must not let its outcome affect the
 * response to the blob operation beyond an informational note.
 */
export async function deindexChunkedPath(index: string, path: string): Promise<DeindexResult> {
  try {
    const env = loadEnv();
    const endpoint = (env.AZURE_SEARCH_ENDPOINT || '').replace(/\/+$/, '');
    if (!endpoint) return { attempted: false, deleted: 0, reason: 'AZURE_SEARCH_ENDPOINT not configured' };
    const service = serviceFromEndpoint(endpoint);
    if (!service) return { attempted: false, deleted: 0, reason: 'cannot derive search service from endpoint' };
    const key = await searchAdminKey(service);

    const chunkIds = await findChunkIdsByPath(endpoint, key, index, path);
    if (chunkIds.length === 0) return { attempted: true, deleted: 0 };

    const r = await fetch(`${endpoint}/indexes/${index}/docs/index?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: chunkIds.map((chunk_id) => ({ '@search.action': 'delete', chunk_id })) }),
    });
    if (!r.ok) {
      return { attempted: true, deleted: 0, reason: `delete ${r.status}: ${(await r.text()).slice(0, 160)}` };
    }
    return { attempted: true, deleted: chunkIds.length };
  } catch (e) {
    return { attempted: false, deleted: 0, reason: (e as Error).message };
  }
}
