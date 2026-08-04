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
import { fetchWithBudget } from '../util/fetch-budget.js';

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

/** Derive the Search SERVICE name from the endpoint (https://<service>.search.windows.net). Pure.
 *  Parses via `URL` and requires an EXACT (anchored) hostname match, not a prefix match: the
 *  earlier regex (`^https://([a-z0-9-]+)\.search\.windows\.net`, no `$`/end anchor) would extract
 *  a service name from a string like `https://real.search.windows.net@attacker.example` too, since
 *  a regex with no end anchor only validates the START of the string (2026-08-04, Copilot review
 *  PR #192 round 5). This value gates which ARM service the caller mints an admin key against
 *  (`searchAdminKey`), so a loose parse here is worth hardening even though `endpoint` in this
 *  codebase's real call sites is always the deploy-configured `AZURE_SEARCH_ENDPOINT` env var, not
 *  externally-attacker-reachable input -- defense in depth, and the fix is free.
 *  ALSO requires `https:` (2026-08-04, Copilot review PR #192 round 6): every call site treats a
 *  null return as fail-closed (`if (!service) return {..., reason: 'cannot derive search service
 *  from endpoint'}` -- see `indexMemoryNow` and `prepareDeindexAuth` below) BEFORE ever fetching, so
 *  rejecting a non-https scheme here is the single choke point that stops the freshly-minted ARM
 *  admin key from ever being sent to `${endpoint}/indexes/.../docs/index` in plaintext, without
 *  needing a second check duplicated at every fetch call site. */
export function serviceFromEndpoint(endpoint: string): string | null {
  let u: URL;
  try {
    u = new URL(endpoint || '');
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const m = u.hostname.match(/^([a-z0-9-]+)\.search\.windows\.net$/i);
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
 * legal-company, ...) are fed by native Azure Blob PULL-indexers with NO deletion-detection policy
 * configured, running every `cadence_min: 360` (6h) per setup/expected-indexes.json in
 * otchealth-claude-tools (`max_age_h: 168`/7d there is the CANARY's freshness-alert tolerance, not
 * the run cadence -- corrected 2026-08-04, Copilot review PR #192 round 4, this comment previously
 * conflated the two and overstated the real gap by ~28x). A pull-indexer only ADDS/UPDATES on each
 * run; it never removes an index entry just
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
 *
 * KNOWN RESIDUAL LIMITATION, not fixed by this mechanism (2026-08-04, Copilot review PR #192 round
 * 3): this is a point-in-time DELETE against the index, racing an INDEPENDENT, asynchronous
 * pull-indexer that can be mid-run at the same time. If a pull-indexer run already READ the old
 * path's content before the blob move, and finishes WRITING that read to the index AFTER this
 * delete runs, the stale entry is resurrected -- this code has no way to know that happened, and
 * `deindexed`/`truncated:false` would (correctly, at the time) report success. This is an inherent
 * property of pairing an active-delete with a passive periodic indexer, not a regression introduced
 * here: before this fix there was NO cleanup at all, and -- since these pull-indexers have no
 * deletion-detection policy (see the module doc comment above) -- a stale entry was never
 * self-healing on any cadence; it stayed stale INDEFINITELY until a full reindex. So the exposure
 * window only shrinks (from "stale indefinitely" to "stale only if a resurrection race is lost"),
 * it does not fully close (2026-08-04, Copilot review PR #192 round 7: the earlier "up to ~6h"
 * framing here wrongly implied the pull-indexer's own cadence would eventually self-heal a missed
 * cleanup, contradicting the no-deletion-detection fact documented above). A real fix needs either
 * indexer coordination (a lock/generation
 * check the pull-indexer respects) or a delayed/recurring re-check sweep that re-deindexes any path
 * that reappears after a confirmed delete -- both genuinely new mechanisms, not yet built (tracked
 * against the CLO brief's pending §7 index_status probe work). Not attempted in this PR: the common
 * case (no indexer run in flight at the exact moment of the move) is correctly handled and is the
 * overwhelming majority of real usage, and building indexer coordination is a separate, larger
 * design task.
 */

export interface DeindexResult {
  /** False only when this could not even be attempted (search unconfigured, or a hard failure
   *  before any chunk lookup completed -- e.g. the admin-key mint itself failed). */
  attempted: boolean;
  /** Number of chunk documents CONFIRMED deleted (Azure AI Search's per-document `status:true`),
   *  not merely "found and included in the delete batch" (0 is normal: the room may not have
   *  indexed this path yet, or already reflects a newer state). */
  deleted: number;
  /** True when the path is NOT confirmed fully clean in the index -- a deadline, the page-count
   *  backstop, a mid-pagination failure, or a delete that didn't confirm every chunk (2026-08-04,
   *  Copilot review PR #192 round 2: silently reporting success after a partial/capped cleanup hid
   *  exactly this). ALWAYS true when `attempted` is false (round 3: every attempted:false branch in
   *  this module sets it, so callers never need to special-case which layer produced the false --
   *  "not attempted" is definitionally "not confirmed clean"). False only on a genuine confirmed
   *  no-op (nothing was indexed at this path) or a fully confirmed delete. */
  truncated?: boolean;
  reason?: string;
}

/** Resolved endpoint + an ADMIN key, good for the life of one blob-store call (legal_blob_move) or
 *  one bulk batch (legal_blob_delete's loop, resolved ONCE and reused -- see prepareDeindexAuth). */
export interface DeindexAuth {
  endpoint: string;
  key: string;
}

const DEINDEX_PAGE_SIZE = 200;
/** Backstop against a genuinely runaway loop (a misbehaving search response), NOT the correctness
 *  bound on how much cleanup happens -- that is `deadlineAtMs` below. Deliberately generous
 *  (10,000 chunks) since the real limit that stops a huge document's cleanup should be time, not
 *  an arbitrary chunk count (2026-08-04, Copilot review PR #192 round 2: a fixed low page cap
 *  silently truncated cleanup on any document that legitimately exceeded it). */
const DEINDEX_MAX_PAGES = 50;
/** Short per-call timeout with NO retry (fetchWithBudget's `retries:0`): this is best-effort
 *  cleanup that can run inside legal_blob_delete's bulk hot loop (one call per moved item), so a
 *  stalled or overloaded search service must fail fast rather than eat the item's share of the
 *  60s MCP transport budget the way a bare, unbounded `fetch` could. A retry would double the
 *  worst case for no correctness benefit here -- a miss just means the deadline check below
 *  catches it and reports `truncated` instead of silently losing time to a retry. */
const DEINDEX_CALL_TIMEOUT_MS = 3000;
/** Overall wall-clock budget for the one-shot convenience wrapper (deindexChunkedPath, used by
 *  legal_blob_move, which awaits this AFTER its own blob copy+delete has already durably
 *  succeeded). Bounds auth + every page's lookup + every page's delete TOGETHER, regardless of
 *  how many internal retries/pages happen, so a slow or erroring Azure control plane can never
 *  itself push legal_blob_move's response past the 60s MCP transport timeout (2026-08-04, Copilot
 *  review PR #192 round 2: auth alone could take up to ~32s worst case with no cap at all). */
const DEINDEX_ONE_SHOT_DEADLINE_MS = 10000;

/** Race `promise` against a timer that fires at `deadlineAtMs`, resolving to `onTimeout` if the
 *  deadline wins. The raced-away promise is NOT cancelled (JS has no such primitive) -- it keeps
 *  running in the background and its eventual result is simply discarded, the same fire-and-forget
 *  shape used elsewhere in this codebase (auto-journal writes). That is safe here specifically
 *  because deindex is idempotent best-effort cleanup: a straggling call that finishes late either
 *  does nothing (the caller already returned) or does a real, harmless bonus cleanup. */
function withDeadline<T>(promise: Promise<T>, deadlineAtMs: number, onTimeout: T): Promise<T> {
  const ms = Math.max(0, deadlineAtMs - Date.now());
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  // clearTimeout as soon as EITHER side settles: when `promise` wins (the common, fast case),
  // this cancels the pending timer immediately instead of leaving it to fire uselessly up to
  // DEINDEX_ONE_SHOT_DEADLINE_MS later -- a dangling timer per call would otherwise churn memory
  // on a long-lived server process and, in tests, hold the event loop open for the full timeout
  // even after the real result is already known (caught by this file's own test run, which took
  // 10s+ per case before this fix even though the underlying work resolved in milliseconds).
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A synthetic, clearly-non-Azure Response (status 599) used as the `withDeadline` timeout value
 *  for an in-flight search call -- lets the existing `!r.ok` handling recognize and report an
 *  in-flight deadline timeout without a second parallel code path. */
function DEINDEX_TIMEOUT_RESPONSE(): Response {
  return new Response('deadline exceeded while a request was in flight', { status: 599 });
}

/** Delete one page of chunk ids. Never throws -- returns `{deleted, reason}` on any failure. */
async function deleteChunkPage(auth: DeindexAuth, index: string, chunkIds: string[]): Promise<{ deleted: number; reason?: string }> {
  if (chunkIds.length === 0) return { deleted: 0 };
  try {
    const r = await fetchWithBudget(
      `${auth.endpoint}/indexes/${index}/docs/index?api-version=${API_VERSION}`,
      {
        method: 'POST',
        headers: { 'api-key': auth.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: chunkIds.map((chunk_id) => ({ '@search.action': 'delete', chunk_id })) }),
      },
      { timeoutMs: DEINDEX_CALL_TIMEOUT_MS, retries: 0 },
    );
    if (!r.ok) return { deleted: 0, reason: `delete ${r.status}: ${(await r.text()).slice(0, 160)}` };
    // Azure AI Search returns 207 Multi-Status (still `r.ok`, since 200-299) when SOME per-document
    // actions in the batch failed -- `r.ok` alone cannot distinguish "all N deleted" from "some of
    // N deleted". Parse the per-document IndexingResult status and count only confirmed successes
    // (2026-08-04, Copilot review PR #192: the prior code returned chunkIds.length unconditionally
    // on any 2xx, over-reporting cleanup and hiding chunks that silently survived).
    const j = (await r.json()) as { value?: Array<{ key?: string; status?: boolean; errorMessage?: string; statusCode?: number }> };
    const results = j.value || [];
    // A 2xx response whose `value` array is missing entries for some (or ALL) requested chunk_ids
    // must NOT be read as "those chunks are fine" -- an empty `value` on a 2xx previously produced
    // `failed.length === 0` (nothing to iterate) and reported a clean {deleted:0} with no reason,
    // masking a batch that confirmed NOTHING (2026-08-04, Copilot review PR #192 round 5). Every
    // requested id must appear in the response with `status:true` to count as confirmed; anything
    // else (missing, duplicated, or status!=true) is a failure to report.
    const byKey = new Map<string, { status?: boolean; errorMessage?: string; statusCode?: number }>();
    for (const r2 of results) if (r2.key) byKey.set(r2.key, r2);
    const succeeded = chunkIds.filter((id) => byKey.get(id)?.status === true).length;
    const missingOrFailed = chunkIds.filter((id) => byKey.get(id)?.status !== true);
    if (missingOrFailed.length > 0) {
      const firstId = missingOrFailed[0];
      const first = byKey.get(firstId);
      const reasonDetail = first
        ? `key=${firstId} status=${first.statusCode ?? '?'} ${first.errorMessage ?? ''}`
        : `key=${firstId} missing from the response entirely (requested ${chunkIds.length}, got ${results.length} results)`;
      return {
        deleted: succeeded,
        reason: `${missingOrFailed.length}/${chunkIds.length} chunk delete(s) not confirmed (e.g. ${reasonDetail})`.trim(),
      };
    }
    return { deleted: succeeded };
  } catch (e) {
    return { deleted: 0, reason: (e as Error).message };
  }
}

/**
 * Find every matching chunk id (either the primary $filter query or the fallback keyword query),
 * paginated with `skip` over a STABLE, UN-MUTATED result set -- nothing is deleted during this
 * phase. This is deliberate: `skip`-based offset pagination and in-loop deletion do not mix. If
 * page 0's 200 matches were deleted before requesting page 1 with `skip:200`, the index would have
 * shrunk to fewer than 200 remaining matches, so `skip:200` would return EMPTY and pagination would
 * stop, reporting `exhausted:true` while up to DEINDEX_PAGE_SIZE-1 real matches beyond what was
 * already found remain silently un-deleted (2026-08-04, Copilot review PR #192 round 3 -- an
 * earlier version of this function deleted each page as it was found, which had exactly this bug;
 * caught by review, not by this file's own test suite, because the test's stub served a fixed
 * page-1 response regardless of what page 0 had already "deleted"). Checks `deadlineAtMs` before
 * every network call so a slow room can never blow past the caller's time budget.
 */
async function findAllChunkIds(
  auth: DeindexAuth,
  index: string,
  path: string,
  deadlineAtMs: number,
  buildBody: (skip: number) => Record<string, unknown>,
  filterExact: boolean,
): Promise<{ ranAtAll: boolean; ids: string[]; exhausted: boolean; reason?: string }> {
  const doSearch = (body: Record<string, unknown>) =>
    fetchWithBudget(
      `${auth.endpoint}/indexes/${index}/docs/search?api-version=${API_VERSION}`,
      { method: 'POST', headers: { 'api-key': auth.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { timeoutMs: DEINDEX_CALL_TIMEOUT_MS, retries: 0 },
    );
  // Deduped by id, NOT accumulated as a plain array: without an explicit $orderby, Azure AI Search
  // does not guarantee stable ordering across successive $skip/$top requests (documented Azure
  // behavior, not an implementation quirk -- and MORE likely here specifically because an
  // independent pull-indexer can be writing to this same index concurrently). A naive
  // "raw.length < PAGE_SIZE means exhausted" check can therefore both double-count a chunk that
  // reappeared on a later page AND, more dangerously, terminate early while chunks that shifted
  // "behind" the current offset were never seen at all (2026-08-04, Copilot review PR #192 round
  // 4). Rather than depend on an unverified schema-level sortable field to add $orderby, both
  // callers set `count: true` on the query body, and `expectedRawCount` (Azure's own authoritative
  // `@odata.count` for this filter/search AS ISSUED, captured once from the first page) is the
  // PRIMARY exhaustion signal: pagination is only trusted as complete once every RAW result the
  // server says exists has been seen, not merely once a page comes back short.
  //
  // TWO separate sets, not one: `seenRaw` tracks every raw id returned (matches AND, on the
  // fallback pass, near-misses) and is what gets compared against `expectedRawCount` -- comparing
  // the exhaustion check against the SMALLER post-filter set instead would be wrong on the
  // fallback pass, where `@odata.count` counts raw keyword hits (e.g. "foo/bar.pdf.bak" also
  // matches a keyword search for "foo/bar.pdf") and the exact-path-filtered subset can legitimately
  // never reach that raw total, which would make this loop needlessly burn every page every time.
  // `seenIds` accumulates only the exact matches -- the real deletion candidate set this function
  // returns.
  const seenRaw = new Set<string>();
  const seenIds = new Set<string>();
  let expectedRawCount: number | null = null;
  for (let page = 0; page < DEINDEX_MAX_PAGES; page++) {
    if (Date.now() >= deadlineAtMs) return { ranAtAll: page > 0, ids: [...seenIds], exhausted: false, reason: 'deadline exceeded before the path was confirmed exhausted' };
    let r: Response;
    try {
      // The deadline check above only gates whether a NEW call STARTS; once fetchWithBudget's own
      // request is in flight it can still take up to its own DEINDEX_CALL_TIMEOUT_MS regardless of
      // how little of `deadlineAtMs` remains -- racing the call itself (not just gating entry into
      // it) is what actually bounds this pass to the caller's promised deadline, matching the same
      // pattern the one-shot wrapper (deindexChunkedPath) already applies at its own outer layer
      // (2026-08-04, Copilot review PR #192 round 5). DEINDEX_TIMEOUT_RESPONSE is a synthetic,
      // clearly-marked non-2xx Response (status 599, never a real Azure status) so the existing
      // !r.ok handling below need not be duplicated for this path.
      r = await withDeadline(doSearch(buildBody(page * DEINDEX_PAGE_SIZE)), deadlineAtMs, DEINDEX_TIMEOUT_RESPONSE());
    } catch (e) {
      return { ranAtAll: page > 0, ids: [...seenIds], exhausted: false, reason: (e as Error).message };
    }
    if (!r.ok) {
      const reason = r.status === 599 ? 'deadline exceeded while a search call was in flight' : page > 0 ? `search ${r.status} mid-pagination` : undefined;
      return { ranAtAll: page > 0, ids: [...seenIds], exhausted: false, reason };
    }
    let raw: Array<Record<string, unknown>>;
    let odataCount: number | null = null;
    try {
      const j = (await r.json()) as { value?: Array<Record<string, unknown>>; '@odata.count'?: number };
      raw = j.value || [];
      odataCount = typeof j['@odata.count'] === 'number' ? j['@odata.count'] : null;
    } catch (e) {
      return { ranAtAll: page > 0, ids: [...seenIds], exhausted: false, reason: `malformed search response: ${(e as Error).message}` };
    }
    // Track the MAXIMUM count ever observed, not just page 0's: this loop explicitly tolerates the
    // independent pull-indexer writing concurrently (see the module doc comment above), so the
    // server's own count can legitimately GROW mid-pagination as a new chunk is inserted. Freezing
    // the target at page 0 let `seenRaw` satisfy a now-stale (too-low) count while a pre-existing
    // chunk that got shifted behind the offset by the concurrent write was never actually seen,
    // reporting a fully clean deindex with one old chunk still stale (2026-08-04, Copilot review
    // PR #192 round 8). A count that only ever grows during a single pass is still a safe target:
    // it can never go DOWN mid-pagination from something we've already counted as seen.
    if (odataCount !== null) expectedRawCount = expectedRawCount === null ? odataCount : Math.max(expectedRawCount, odataCount);
    for (const d of raw) {
      const id = String((d as { chunk_id?: unknown }).chunk_id ?? '');
      if (!id) continue;
      seenRaw.add(id);
      if (!filterExact || (d as { path?: unknown }).path === path) seenIds.add(id);
    }
    if (expectedRawCount !== null) {
      // Authoritative: trust the server's own RAW count over any page-size heuristic. Keep paging
      // even past a short/empty raw page if the deduped raw total hasn't reached it yet -- exactly
      // the case an unordered result set can produce (a "missing" result is really just sitting on
      // an offset we haven't visited due to reordering, not genuinely absent).
      if (seenRaw.size >= expectedRawCount) return { ranAtAll: true, ids: [...seenIds], exhausted: true };
    } else if (raw.length < DEINDEX_PAGE_SIZE) {
      // No count available (should not happen on API_VERSION 2024-07-01, but fail safe rather
      // than loop forever if some future response shape omits it): fall back to the page-size
      // heuristic, same as before count-tracking existed.
      return { ranAtAll: true, ids: [...seenIds], exhausted: true };
    }
  }
  const countNote = expectedRawCount !== null ? ` (found ${seenRaw.size}/${expectedRawCount} raw results, ${seenIds.size} exact matches)` : '';
  return { ranAtAll: true, ids: [...seenIds], exhausted: false, reason: `stopped at the ${DEINDEX_MAX_PAGES}-page safety backstop${countNote}` };
}

/** Find every matching chunk id (a stable-snapshot pagination pass, see findAllChunkIds), THEN
 *  delete them in bounded batches -- separating find from delete is what makes the pagination
 *  correct (see findAllChunkIds's doc comment). Checks `deadlineAtMs` before every delete batch
 *  too, so a slow delete phase still cannot blow past the caller's time budget. */
async function findAndDeleteAll(
  auth: DeindexAuth,
  index: string,
  path: string,
  deadlineAtMs: number,
  buildBody: (skip: number) => Record<string, unknown>,
  filterExact: boolean,
): Promise<{ ranAtAll: boolean; deleted: number; exhausted: boolean; hadDeleteFailure: boolean; reason?: string }> {
  const found = await findAllChunkIds(auth, index, path, deadlineAtMs, buildBody, filterExact);
  if (!found.ranAtAll) return { ranAtAll: false, deleted: 0, exhausted: false, hadDeleteFailure: false, reason: found.reason };

  let deleted = 0;
  let hadDeleteFailure = false;
  let deleteReason: string | undefined;
  for (let i = 0; i < found.ids.length; i += DEINDEX_PAGE_SIZE) {
    if (Date.now() >= deadlineAtMs) {
      return {
        ranAtAll: true, deleted, exhausted: false, hadDeleteFailure: hadDeleteFailure || i < found.ids.length,
        reason: deleteReason ?? 'deadline exceeded before every found chunk could be deleted',
      };
    }
    // Same in-flight-deadline race as the search calls above (2026-08-04, Copilot review PR #192
    // round 5): the check just above only gates whether this batch STARTS, not how long the
    // network call itself can run once started.
    const del = await withDeadline(
      deleteChunkPage(auth, index, found.ids.slice(i, i + DEINDEX_PAGE_SIZE)),
      deadlineAtMs,
      { deleted: 0, reason: 'deadline exceeded while a delete call was in flight' },
    );
    deleted += del.deleted;
    if (del.reason) {
      // A delete failure means some found chunks were NOT confirmed removed -- keep going through
      // the REMAINING batches (they are independent id sets) rather than abandoning the rest of a
      // large document's cleanup over one batch's failure, but remember that the overall result is
      // not clean. `exhausted` (search pagination completed) and `hadDeleteFailure` (at least one
      // delete did not confirm) are tracked separately so a delete failure never gets silently
      // absorbed into "found.exhausted was true, so we must be done."
      hadDeleteFailure = true;
      deleteReason ??= del.reason;
    }
  }
  return { ranAtAll: true, deleted, exhausted: found.exhausted, hadDeleteFailure, reason: deleteReason ?? found.reason };
}

/** Default deadline for prepareDeindexAuth: managed-identity + ARM listAdminKeys can each retry
 *  internally (fetchWithBudget's default timeout+retries), so left unbounded this could take up
 *  to ~30s+ in a genuine Azure control-plane outage. That is fine for legal_blob_move's one-shot
 *  path (already wrapped in an outer 10s deadline by deindexChunkedPath), but legal_blob_delete's
 *  bulk loop calls this BEFORE any blob has moved -- an unbounded auth resolution there would
 *  consume the batch's own move-time budget before the first item even starts, turning best-effort
 *  cleanup into a blocker on the tool's PRIMARY function (2026-08-04, Copilot review PR #192 round
 *  3). Kept short relative to LEGAL_DELETE_TIME_BUDGET_MS's own floor (1000ms) so it can never
 *  itself dominate even a minimally-configured batch. */
const DEINDEX_AUTH_DEADLINE_MS = 3000;

/**
 * Resolve the search endpoint + an ADMIN key ONCE. Call this before a loop of many
 * deindexChunkedPathWithAuth calls (legal_blob_delete's bulk mode) instead of letting each item
 * mint its own admin key via a fresh ARM listAdminKeys round trip (2026-08-04, Copilot review PR
 * #192: N items previously meant N identical ARM calls). FAIL-OPEN: never throws.
 *
 * DEADLINE-BOUNDED (default DEINDEX_AUTH_DEADLINE_MS from now): a caller on a pre-mutation
 * critical path (legal_blob_delete's bulk loop) should pass a deadline no later than a small
 * fraction of its own move-time budget so a slow/erroring Azure control plane can only ever
 * degrade this to `{auth:null}` (cleanup skipped, reported via deindex_incomplete), never delay or
 * starve the actual blob operation (2026-08-04, Copilot review PR #192 round 3).
 */
export async function prepareDeindexAuth(deadlineAtMs: number = Date.now() + DEINDEX_AUTH_DEADLINE_MS): Promise<{ auth: DeindexAuth | null; reason?: string }> {
  return withDeadline(
    (async (): Promise<{ auth: DeindexAuth | null; reason?: string }> => {
      try {
        const env = loadEnv();
        const endpoint = (env.AZURE_SEARCH_ENDPOINT || '').replace(/\/+$/, '');
        if (!endpoint) return { auth: null, reason: 'AZURE_SEARCH_ENDPOINT not configured' };
        const service = serviceFromEndpoint(endpoint);
        if (!service) return { auth: null, reason: 'cannot derive search service from endpoint' };
        const key = await searchAdminKey(service);
        return { auth: { endpoint, key } };
      } catch (e) {
        return { auth: null, reason: (e as Error).message };
      }
    })(),
    deadlineAtMs,
    { auth: null, reason: 'prepareDeindexAuth: deadline exceeded before auth could be resolved' },
  );
}

/**
 * Delete every chunk document at `path` from `index` (a chunked doc room), given an ALREADY
 * resolved DeindexAuth (see prepareDeindexAuth). See the section header above for the full
 * rationale. FAIL-OPEN: never throws; every failure mode returns `{attempted, deleted, reason}`.
 * Callers should call this AFTER their own blob mutation has already succeeded, and must not let
 * its outcome affect the response to the blob operation beyond an informational note.
 *
 * `deadlineAtMs` (default: 8s from now) bounds the WHOLE lookup+delete pass -- paginating past it
 * stops and reports `truncated:true` rather than silently reporting success on a partial cleanup
 * (2026-08-04, Copilot review PR #192 round 2). legal_blob_delete's bulk loop should pass the
 * batch's own remaining time budget (bounded to a sane per-item cap) here; when there is
 * essentially no time left, the very first deadline check below degrades this to a fast, VISIBLE
 * no-op (`truncated:true`) instead of the caller having to guess-and-skip beforehand.
 */
export async function deindexChunkedPathWithAuth(
  auth: DeindexAuth,
  index: string,
  path: string,
  deadlineAtMs: number = Date.now() + 8000,
): Promise<DeindexResult> {
  try {
    const escaped = path.replace(/'/g, "''");
    const primary = await findAndDeleteAll(
      auth, index, path, deadlineAtMs,
      // `count: true` is required for findAllChunkIds's authoritative-exhaustion check (2026-08-04,
      // Copilot review PR #192 round 4) -- see its doc comment for why an unordered result set
      // makes the plain "short page = done" heuristic unsafe.
      (skip) => ({ search: '*', filter: `path eq '${escaped}'`, select: 'chunk_id,path', top: DEINDEX_PAGE_SIZE, skip, count: true }),
      false,
    );
    if (!primary.ranAtAll) {
      // The very first $filter call failed outright -- likely this room's schema does not allow
      // filtering on `path`. Fall back to a keyword search restricted to the path field, still
      // deadline-bounded and still paginated.
      const fb = await findAndDeleteAll(
        auth, index, path, deadlineAtMs,
        (skip) => ({ search: path, searchFields: 'path', queryType: 'simple', select: 'chunk_id,path', top: DEINDEX_PAGE_SIZE, skip, count: true }),
        true,
      );
      // ALWAYS truncated, even when fb.exhausted is true (2026-08-04, Copilot review PR #192 round
      // 8): `queryType: 'simple'` treats characters that commonly appear in real blob paths (`+`,
      // `-`, `*`, quotes) as query OPERATORS, not literal text, so a raw path fed straight into
      // `search` can be parsed in a way that fails to match an exact-path document that is still
      // genuinely indexed -- a false NEGATIVE the client-side equality check (filterExact) cannot
      // rescue, since that check only narrows candidates the search already returned; it cannot
      // invent ones the search silently missed. So `fb.exhausted` proves only "we paginated through
      // everything Azure's text analyzer decided to return for this query," never "nothing more
      // exists at this path." Until the room's schema makes `path` filterable (closing this
      // fallback entirely) or this scans exhaustively instead of via a keyword search, the fallback
      // can never claim confirmed-clean the way the primary $filter path can.
      return {
        attempted: true,
        deleted: fb.deleted,
        truncated: true,
        reason: fb.reason ?? 'keyword-search fallback cannot prove completeness (path field not filterable in this room; query-syntax false negatives are possible)',
      };
    }
    return { attempted: true, deleted: primary.deleted, truncated: !primary.exhausted || primary.hadDeleteFailure, reason: primary.reason };
  } catch (e) {
    // Defense in depth: findAndDeleteAll/findAllChunkIds/deleteChunkPage already catch every
    // network/parse failure they know about, but this outer guard keeps the "never throws"
    // contract airtight against anything unanticipated (2026-08-04).
    return { attempted: false, deleted: 0, truncated: true, reason: (e as Error).message };
  }
}

/** Convenience one-shot wrapper: resolve auth AND delete, deadline-bounded end-to-end (see
 *  DEINDEX_ONE_SHOT_DEADLINE_MS), for a single-call site (legal_blob_move, which de-indexes
 *  exactly one path per invocation). legal_blob_delete's bulk loop should instead call
 *  prepareDeindexAuth() once and reuse it via deindexChunkedPathWithAuth per item. */
export async function deindexChunkedPath(index: string, path: string): Promise<DeindexResult> {
  const deadlineAtMs = Date.now() + DEINDEX_ONE_SHOT_DEADLINE_MS;
  return withDeadline(
    (async (): Promise<DeindexResult> => {
      const { auth, reason } = await prepareDeindexAuth();
      // truncated:true here too -- attempted:false always means "not confirmed clean," whether
      // that's because nothing was configured or because auth's own short internal deadline
      // (DEINDEX_AUTH_DEADLINE_MS) won its race first. Every attempted:false branch in this module
      // sets truncated:true for the same reason: callers should never need to special-case which
      // layer produced the false (2026-08-04, Copilot review PR #192 round 3, caught by this
      // file's own test suite disagreeing with itself across the two attempted:false paths).
      if (!auth) return { attempted: false, deleted: 0, truncated: true, reason };
      return deindexChunkedPathWithAuth(auth, index, path, deadlineAtMs);
    })(),
    deadlineAtMs,
    { attempted: false, deleted: 0, truncated: true, reason: `deindex overall deadline (${DEINDEX_ONE_SHOT_DEADLINE_MS}ms) exceeded` },
  );
}
