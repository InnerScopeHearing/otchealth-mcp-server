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
import { blobExistsWithTimeout, type LegalContainer } from '../legal/blob-store.js';

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
 * FORMERLY A KNOWN RESIDUAL LIMITATION, NOW LARGELY CLOSED (2026-08-04, Copilot review PR #192
 * rounds 3-12 identified this repeatedly; THE PERMANENT FIX is `agentstate/deindex-resweep.ts`):
 * this function is a point-in-time DELETE against the index, racing an INDEPENDENT, asynchronous
 * pull-indexer that can be mid-run at the same time. If a pull-indexer run already READ the old
 * path's content before the blob move, and finishes WRITING that read to the index AFTER this
 * delete runs, the stale entry is resurrected -- this function, in isolation, has no way to know
 * that happened, and `deindexed`/`truncated:false` would (correctly, at the time) report success
 * for what it could see. No amount of tightening a single SYNCHRONOUS call can close that: an MCP
 * tool call cannot block for hours waiting out the indexer's own cadence to be certain no run is
 * still in flight.
 *
 * THE FIX applied at the CALL SITES (blob-delete.ts, blob-move.ts's src_path only -- see below),
 * not in this function: every caller ALSO enqueues the path into a durable, delayed
 * re-verification queue (`enqueueDeindexResweep`), due safely past one full indexer cadence. A
 * periodic in-process reconciler drains it and re-runs this exact function -- by the time an entry
 * is due, any indexer run that was in flight when the entry was enqueued has certainly finished, so
 * that second pass is not racing anything and its result is authoritative for THAT run's timing.
 * This function's own synchronous best-effort cleanup stays as the FAST PATH for the common case
 * (no indexer run in flight, the overwhelming majority of real usage); the resweep queue is the
 * DURABLE BACKSTOP that closes the race the fast path cannot. See deindex-resweep.ts's module doc
 * comment for the full design, including the two additional safety guards it needed once a
 * DELAYED pass is in play (an existence check before deleting anything, and ETag-conditional queue
 * writes) and why it needed no new Azure infrastructure (reuses the already-provisioned Cosmos
 * `tasks` container).
 *
 * `findAllChunkIds`'s authoritative-count check (round 9: `seenRaw`, a UNION of ids across every
 * page fetched in ONE pass, is not a true single snapshot against a genuinely mutating index) is the
 * identical root cause expressed through the count check instead of through resurrection after a
 * confirmed delete -- the SAME resweep queue closes it the same way: a later, delayed pass is not
 * racing the same mutation the first pass was.
 *
 * SAME-PATH-RECREATION RACE, CLOSED ONE LAYER EARLIER TOO (2026-08-04, Copilot review PR #192
 * round 16): this function itself (not just the delayed resweep) now takes an optional `container`
 * param; when supplied, it runs a timeout-bounded existence check on `path` BEFORE doing any
 * search/delete work at all, and skips entirely (`attempted:false, truncated:true`) if a blob
 * currently exists there or existence could not be confirmed in time. This closes the race Copilot
 * described directly against this function's SYNCHRONOUS immediate-cleanup callers (blob-delete.ts,
 * blob-move.ts, both now pass `container`): "After the original blob is removed, legal_blob_put can
 * recreate the same path and an indexer can publish that replacement before this lookup completes;
 * this query then collects both old and new chunks and deletes all of them." Previously only
 * deindex-resweep.ts's DELAYED sweep had this guard; the synchronous fast path had none.
 *
 * TWO narrower edge cases remain genuinely open, NOT closed by either guard (2026-08-04, Copilot
 * review PR #192 rounds 12 and 16):
 *
 * 1. Both existence checks (this function's own, and deindex-resweep.ts's GUARD 1) are separate
 *    network round trips from the search/delete call(s) that follow them -- a TOCTOU sliver
 *    remains between "existence confirmed false" and "the delete actually executes," during which
 *    a recreation could still land. Beyond that: this lookup is path-only, not tied to a specific
 *    blob generation/ETag, so even a delete that starts immediately after a clean existence check
 *    cannot distinguish "stale chunks from the content that used to be here" from "valid chunks for
 *    content recreated microseconds later." Closing this fully needs the chunk schema to carry a
 *    source-generation marker this cleanup can correlate against the pre-delete state, which was
 *    not attempted here without first confirming that field exists in the live schema (this PR does
 *    not touch the live Azure Search index/indexer configuration blind). Practically very narrow:
 *    now requires a same-path recreation landing in the specific, short window between an
 *    already-bounded existence check and the delete that follows it, not merely a concurrent read
 *    anywhere in a multi-second window. deindex-resweep.ts's own existence-check-true branch (GUARD
 *    1) no longer silently drops the queue entry when this DOES happen -- it now routes through the
 *    same backoff/eventual-'failed' bookkeeping as any other not-confirmed-clean outcome, so a
 *    generation mismatch stays VISIBLE (a discoverable 'failed' entry) instead of vanishing.
 *
 * 2. `legal_blob_move`'s overwrite-destination path (dst_path, when it already held content) is
 *    NOT enqueued into the resweep queue at all, unlike src_path -- see blob-move.ts's own comment
 *    at the call site. dst_path is EXPECTED to exist after an overwrite (the new content lives
 *    there), so an existence-check guard can never usefully fire for it; a path-only sweep of
 *    dst_path would eventually delete the new content's own valid chunks alongside any orphaned old
 *    ones. Cleaning up dst_path's orphaned excess chunks (from the content that was just
 *    overwritten) remains a genuinely open, tracked follow-up requiring the same generation-aware
 *    chunk targeting as #1 above.
 *
 * Both are tracked as follow-ups, same as indexer coordination was tracked against the CLO brief's
 * §7 before this resweep queue existed.
 */

export interface DeindexResult {
  /** False when cleanup could not even be ENTERED (search unconfigured, or the admin-key mint
   *  itself failed) -- true once authenticated cleanup started, even if the search/delete calls
   *  inside it then failed outright (2026-08-04, Copilot review PR #192 round 11: the earlier doc
   *  comment claimed `attempted` was false whenever no chunk lookup COMPLETED, but a search network
   *  failure or both the primary and fallback queries failing outright both return `attempted:true`
   *  per the actual implementation and this file's own tests -- `attempted` marks "did we get past
   *  auth," never "did a lookup complete." `truncated` below is the real completeness signal;
   *  callers should never infer confirmed-clean from `attempted` alone. */
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
   *  no-op (nothing was indexed at this path) or a fully confirmed delete. REQUIRED, not optional
   *  (2026-08-04, Copilot review PR #192 round 11): every caller treats an omitted `truncated` as
   *  `Boolean(undefined) === false` -- i.e. "confirmed clean" -- so an accidentally-missing field at
   *  a new return site would silently misreport an incomplete cleanup as done. Making it required
   *  forces the compiler to catch that at every return site, not just at the two call sites that
   *  happen to read it today. */
  truncated: boolean;
  /** True when a LATER retry of this exact call could plausibly turn `truncated:true` into
   *  `truncated:false` (a transient condition: a network blip, a deadline that was simply too
   *  tight this time, Search being briefly unavailable). False when the incompleteness is a
   *  DETERMINISTIC property of this call that retrying cannot fix (2026-08-04, Copilot review PR
   *  #192 round 19): the keyword-search fallback ALWAYS returns `truncated:true` by design, every
   *  single time it runs, regardless of outages -- `queryType:'simple'` can produce false negatives
   *  on paths containing search-operator characters no matter how many times it is retried. Callers
   *  that retry "not confirmed clean" results indefinitely (deindex-resweep.ts, since round 17,
   *  after transient Search/auth outages were found permanently stranding entries) MUST distinguish
   *  this case -- retrying a structurally-non-authoritative result forever wastes a queue slot every
   *  tick for no possible gain, the mirror-image mistake of terminal-ing a genuinely transient one
   *  too early. REQUIRED, not optional, for the same reason `truncated` is: an accidentally-missing
   *  field at a new return site must not silently default to "authoritative," which would make a
   *  genuinely non-retriable result retry forever by omission. */
  authoritative: boolean;
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

/** Distinguishes "the response body read itself timed out" from a genuinely empty/parsed body
 *  (2026-08-04, Copilot review PR #192 round 10): `fetch()` resolves once HEADERS arrive, not once
 *  the body is fully received, so racing `doSearch(...)` against `deadlineAtMs` only bounds time
 *  until headers land -- a connection that sends headers and then stalls the body could let the
 *  later, unguarded `await r.json()` run for up to `fetchWithBudget`'s own internal
 *  DEINDEX_CALL_TIMEOUT_MS, a SEPARATE clock unrelated to however little of the caller's
 *  `deadlineAtMs` remains. Racing the json() read too closes that gap. A plain `undefined` fallback
 *  would be indistinguishable from Azure genuinely returning no `value`/`@odata.count` fields (which
 *  the exhaustion check would misread as an empty, exhausted page); a unique Symbol cannot collide
 *  with any real parsed JSON value. */
const DEINDEX_JSON_TIMEOUT = Symbol('deindex-json-timeout');

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
      // Races the BODY read too, not just the headers-only fetch above (2026-08-04, Copilot review
      // PR #192 round 10): see DEINDEX_JSON_TIMEOUT's own doc comment for why a stalled body would
      // otherwise escape `deadlineAtMs` entirely.
      const j = await withDeadline<{ value?: Array<Record<string, unknown>>; '@odata.count'?: number } | typeof DEINDEX_JSON_TIMEOUT>(
        r.json() as Promise<{ value?: Array<Record<string, unknown>>; '@odata.count'?: number }>,
        deadlineAtMs,
        DEINDEX_JSON_TIMEOUT,
      );
      if (j === DEINDEX_JSON_TIMEOUT) {
        // ranAtAll:TRUE here, unlike the sibling early-return branches above (a thrown network
        // error or a non-ok status at page 0, which DO signal "the primary $filter approach itself
        // may be unsupported, try the fallback keyword query"). A stalled BODY read follows a
        // genuine 2xx response -- Azure accepted and is answering the query, the connection is just
        // slow to finish delivering it. That has nothing to do with whether $filter is supported,
        // and a body-stall is if anything MORE likely to recur on a differently-shaped fallback
        // query against the same slow connection, not less -- so falling back here would waste the
        // caller's remaining deadline on a near-certain repeat rather than reporting incomplete
        // promptly (caught by this file's own test suite: an earlier `page > 0` version here
        // triggered exactly that wasted fallback attempt, which then hit the outer per-page deadline
        // check instead of this reason once real elapsed time had already exceeded deadlineAtMs).
        return { ranAtAll: true, ids: [...seenIds], exhausted: false, reason: 'deadline exceeded while reading a search response body' };
      }
      // A successful HTTP response with a missing or non-array `value` is NOT the same as a
      // genuinely empty page (2026-08-04, Copilot review PR #192 round 18): `j.value || []`
      // silently coerced either shape into `[]`, which on the primary $filter path could set
      // `exhausted:true` and report `truncated:false` -- the delayed resweep would then delete its
      // queue entry as "confirmed clean" even though Search never actually supplied a valid result
      // set to confirm anything from. A well-formed Azure AI Search response always carries `value`
      // as an array (empty `[]` for zero real matches); anything else is malformed and must be
      // treated the same as the network/parse failures the catch block below already routes to
      // "not confirmed, retryable."
      if (!Array.isArray(j.value)) {
        return { ranAtAll: page > 0, ids: [...seenIds], exhausted: false, reason: 'malformed search response: "value" field missing or not an array' };
      }
      raw = j.value;
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

/** How much of the remaining deadline the pre-delete existence check (below) is allowed to spend,
 *  when `container` is supplied. Small and PROPORTIONAL, not a flat cap (2026-08-04, Copilot review
 *  round 16): this function's own `deadlineAtMs` can leave as little as
 *  MIN_ONE_SHOT_DEINDEX_BUDGET_MS (1s) total for a slow legal_blob_move, so a flat multi-second
 *  existence-check timeout (the resweep tick's own 8s, appropriate for a background job with a much
 *  larger per-item budget) could consume the ENTIRE remaining budget here and leave nothing for the
 *  actual search+delete work -- floored so it is never useless, capped so it never dominates. */
const EXISTENCE_CHECK_MAX_MS = 2000;
const EXISTENCE_CHECK_MIN_MS = 300;
const EXISTENCE_CHECK_SHARE = 0.4;

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
 *
 * `container`, when supplied (2026-08-04, Copilot review PR #192 round 16), runs a timeout-bounded
 * existence check on `path` before touching search AT ALL: "After the original blob is removed,
 * legal_blob_put can recreate the same path and an indexer can publish that replacement before this
 * lookup completes; this query then collects both old and new chunks and deletes all of them" (the
 * exact race deindex-resweep.ts's GUARD 1 already prevents for the DELAYED sweep, applied here one
 * layer earlier for the SYNCHRONOUS immediate-cleanup path, which previously had no such guard at
 * all). If a blob currently exists at `path` -- or existence could not be confirmed in time -- this
 * skips the path-only cleanup entirely rather than risk deleting live content, deferring safely to
 * the delayed resweep queue (which itself now treats "path recreated" as unresolved, not done, per
 * the same round's fix to its own generation-uncertainty gap). Optional: callers that cannot supply
 * a container (none currently) keep the pre-existing, ungated behavior.
 */
export async function deindexChunkedPathWithAuth(
  auth: DeindexAuth,
  index: string,
  path: string,
  deadlineAtMs: number = Date.now() + 8000,
  container?: LegalContainer,
): Promise<DeindexResult> {
  try {
    if (container) {
      // An ALREADY-EXPIRED deadline must short-circuit here, before starting anything, not just
      // before the search/delete work below (2026-08-04, Copilot review round 17): the previous
      // Math.max(EXISTENCE_CHECK_MIN_MS, ...) floor applied its 300ms minimum even to a NEGATIVE
      // remaining duration, so a call arriving with zero time left still issued a fresh Blob HEAD
      // and waited up to 300ms for it -- silently exceeding the caller's whole-pass deadline
      // contract by that much on every already-late call, eroding exactly the budget round after
      // round of this PR tightened elsewhere.
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        // Transient (the caller simply ran out of time this attempt) -- authoritative:true, a
        // later retry with a fresh deadline could genuinely confirm clean.
        return { attempted: false, deleted: 0, truncated: true, authoritative: true, reason: 'deadline already exceeded before the existence check could start' };
      }
      const existMs = Math.max(EXISTENCE_CHECK_MIN_MS, Math.min(EXISTENCE_CHECK_MAX_MS, Math.floor(remainingMs * EXISTENCE_CHECK_SHARE)));
      const nowExists = await blobExistsWithTimeout(container, path, existMs);
      if (nowExists !== false) {
        // Both outcomes here are transient (a timeout can clear next attempt; a live blob today
        // may be gone or the resweep's own generation-uncertainty handling applies) --
        // authoritative:true, this is not a structural dead end.
        return {
          attempted: false,
          deleted: 0,
          truncated: true,
          authoritative: true,
          reason:
            nowExists === null
              ? 'existence check timed out -- skipping path-only cleanup to avoid risking live content; the delayed resweep queue will re-verify safely'
              : 'a blob currently exists at this path -- skipping path-only cleanup to avoid deleting live content; the delayed resweep queue handles this case with its own generation-uncertainty backoff',
        };
      }
    }
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
      //
      // authoritative:false (2026-08-04, Copilot review PR #192 round 19): this fallback returns
      // truncated:true EVERY time it runs, by design, regardless of whether THIS particular attempt
      // hit an outage -- it is a deterministic property of "this room's schema does not make `path`
      // filterable," not a transient condition. A caller that retries "not confirmed clean" results
      // indefinitely (deindex-resweep.ts) must NOT retry this forever: no number of retries will
      // ever turn it into truncated:false, so doing so would waste a queue slot every tick for no
      // possible gain -- it needs the SAME visible-terminal treatment as genuine generation
      // uncertainty, not the "infra will eventually recover" treatment transient failures get.
      return {
        attempted: true,
        deleted: fb.deleted,
        truncated: true,
        authoritative: false,
        reason: fb.reason ?? 'keyword-search fallback cannot prove completeness (path field not filterable in this room; query-syntax false negatives are possible)',
      };
    }
    // The primary $filter path's completeness signal IS authoritative -- exhausted:true genuinely
    // means clean, and any incompleteness here (a deadline, a delete failure) is transient: a later
    // retry with fresh time/connectivity could confirm clean.
    return { attempted: true, deleted: primary.deleted, truncated: !primary.exhausted || primary.hadDeleteFailure, authoritative: true, reason: primary.reason };
  } catch (e) {
    // Defense in depth: findAndDeleteAll/findAllChunkIds/deleteChunkPage already catch every
    // network/parse failure they know about, but this outer guard keeps the "never throws"
    // contract airtight against anything unanticipated (2026-08-04). Transient by nature (an
    // unexpected exception, not a proven structural limitation) -- authoritative:true.
    return { attempted: false, deleted: 0, truncated: true, authoritative: true, reason: (e as Error).message };
  }
}

/** How much of a single-item caller's transport-timeout margin legal_blob_move's deindex cleanup
 *  gets, once the preceding move steps (headBlob/copyBlob/deleteBlobHard -- none of which are
 *  currently deadline-bound; copyBlob alone has a documented ~20s async-copy poll ceiling) have
 *  already taken their own bite out of the 60s MCP transport timeout (2026-08-04, Copilot review
 *  PR #192 round 9). deindexChunkedPath's own DEINDEX_ONE_SHOT_DEADLINE_MS (10s) was previously a
 *  flat cap regardless of how long those preceding steps already ran, so a slow move plus an
 *  unconditional 10s cleanup on top could approach the 60s ceiling with little margin -- the same
 *  class of issue round 7 fixed for the bulk delete loop's pre-mutation auth call. Never returns
 *  MORE than the normal one-shot cap (a fast move must not grant deindex extra time it never had),
 *  and is floored so cleanup is still ATTEMPTED (never silently skipped) even when the move ran
 *  long -- a thin deadline just makes deindex give up fast and report truncated (a correct, visible
 *  outcome), rather than never trying at all. Pure and exported for direct unit testing. */
const MOVE_TRANSPORT_SAFETY_MS = 45000;
const MIN_ONE_SHOT_DEINDEX_BUDGET_MS = 1000;
export function effectiveOneShotDeindexBudgetMs(moveElapsedMs: number): number {
  return Math.max(MIN_ONE_SHOT_DEINDEX_BUDGET_MS, Math.min(DEINDEX_ONE_SHOT_DEADLINE_MS, MOVE_TRANSPORT_SAFETY_MS - moveElapsedMs));
}

/** Convenience one-shot wrapper: resolve auth AND delete, deadline-bounded end-to-end (see
 *  DEINDEX_ONE_SHOT_DEADLINE_MS), for a single-call site (legal_blob_move, which de-indexes
 *  exactly one path per invocation). legal_blob_delete's bulk loop should instead call
 *  prepareDeindexAuth() once and reuse it via deindexChunkedPathWithAuth per item.
 *
 *  `budgetMs` defaults to DEINDEX_ONE_SHOT_DEADLINE_MS but callers with their own preceding
 *  transport-timeout exposure (legal_blob_move, via effectiveOneShotDeindexBudgetMs) can pass a
 *  smaller remaining budget instead (2026-08-04, Copilot review PR #192 round 9). */
export async function deindexChunkedPath(index: string, path: string, budgetMs: number = DEINDEX_ONE_SHOT_DEADLINE_MS, container?: LegalContainer): Promise<DeindexResult> {
  const deadlineAtMs = Date.now() + budgetMs;
  return withDeadline(
    (async (): Promise<DeindexResult> => {
      const { auth, reason } = await prepareDeindexAuth();
      // truncated:true here too -- attempted:false always means "not confirmed clean," whether
      // that's because nothing was configured or because auth's own short internal deadline
      // (DEINDEX_AUTH_DEADLINE_MS) won its race first. Every attempted:false branch in this module
      // sets truncated:true for the same reason: callers should never need to special-case which
      // layer produced the false (2026-08-04, Copilot review PR #192 round 3, caught by this
      // file's own test suite disagreeing with itself across the two attempted:false paths).
      if (!auth) return { attempted: false, deleted: 0, truncated: true, authoritative: true, reason };
      return deindexChunkedPathWithAuth(auth, index, path, deadlineAtMs, container);
    })(),
    deadlineAtMs,
    { attempted: false, deleted: 0, truncated: true, authoritative: true, reason: `deindex overall deadline (${budgetMs}ms) exceeded` },
  );
}
