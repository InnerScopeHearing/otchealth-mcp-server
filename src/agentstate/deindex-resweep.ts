/**
 * THE PERMANENT FIX for the concurrent-pull-indexer resurrection race that every round of PR #192's
 * Copilot review correctly flagged as a KNOWN RESIDUAL LIMITATION of search-write.ts's synchronous
 * best-effort cleanup (tracked against the CLO brief's pending §7 index_status probe work): a
 * point-in-time delete against the search index cannot, by construction, protect against an
 * INDEPENDENT, asynchronous pull-indexer that read the old blob content before the delete/move ran
 * and finishes WRITING that stale content to the index AFTER the synchronous cleanup already
 * returned. No amount of tightening a single synchronous MCP tool call can close that: an MCP call
 * cannot block for hours waiting out the indexer's own cadence.
 *
 * THE FIX: a durable, DELAYED re-verification queue. `enqueueDeindexResweep` is called from
 * blob-delete.ts / blob-move.ts right after their existing synchronous cleanup, for every path that
 * lost content (a soft-deleted or moved-from path) -- via `enqueueDeindexResweepAwaited` (a small
 * BOUNDED await, NOT fire-and-forget: 2026-08-04, Copilot review round 16 -- a bare fire-and-forget
 * call gave callers no way to know whether the durable obligation actually reached Cosmos before
 * their response returned; both real callers now await it and surface the confirmed-persisted
 * result). Each entry sits with a `due_at` set safely PAST one full pull-indexer cadence (see
 * DEINDEX_RESWEEP_DELAY_MS below). A periodic in-process reconciler (`startDeindexResweepReloader`,
 * wired at server boot exactly like `startRevocationReloader` in revocation-store.ts) drains due
 * entries and re-runs the SAME, heavily-hardened deindex mechanism this whole PR built.
 *
 * TWO SAFETY GUARDS a path-only re-verification needs that the first version of this file did NOT
 * have, both added after Copilot's review of the initial commit caught them (2026-08-04):
 *
 * 1. EXISTENCE CHECK before any delete. A path-only lookup cannot tell "stale chunks from content
 *    that used to be here" apart from "valid chunks for content that is here NOW" -- if a blob was
 *    legitimately RECREATED at the exact same path (a concurrent legal_blob_put) sometime before
 *    this entry became due, blindly deleting by path would destroy that new content's search
 *    visibility, not just clean up the old one. So every sweep first checks whether a blob now
 *    exists at the queued path (blobExists); if it does, the index is never touched -- but
 *    (2026-08-04, Copilot review round 16, correcting an earlier version of this paragraph that is
 *    now WRONG) the entry is NOT simply removed as "job done." If the recreated content has
 *    fewer/different chunks than the version that was here before, the pull-indexer's own re-index
 *    only adds/updates chunks for the CURRENT content -- it has no reason to remove excess chunk IDs
 *    left over from the PRIOR generation (the exact deletion-detection gap this whole PR exists to
 *    work around), so those orphaned prior-generation chunks could persist forever with nothing left
 *    tracking them if this entry just vanished. So a recreated path instead backs off the same way
 *    any other not-confirmed-clean outcome does, and after DEINDEX_RESWEEP_MAX_ATTEMPTS becomes a
 *    visible 'failed' entry (discoverable for a future generation-aware sweep) rather than
 *    disappearing without a trace. THIS IS WHY `legal_blob_move`'s overwrite-destination case is
 *    deliberately NOT enqueued here (see blob-move.ts): dst_path is EXPECTED to exist after an
 *    overwrite (the new content lives there), so the existence check would never usefully fire for
 *    it and a path-only sweep would eventually delete the new content's own chunks alongside any
 *    orphaned old ones -- there is no existence-based guard that helps that specific case. Cleaning
 *    dst_path's orphaned excess chunks on an overwrite remains a genuinely open, tracked follow-up
 *    (needs a chunk-schema generation/ETag marker so cleanup can target only chunks belonging to the
 *    PRIOR blob version, not the current one) -- see search-write.ts's module doc comment.
 *
 * 2. ETAG-CONDITIONAL queue writes, closing a queue-STATE race distinct from the index race above:
 *    a worker can query an entry, and WHILE it is off running the (network-bound) re-verification,
 *    a fresh delete/move on the SAME path can re-enqueue that SAME deterministic queue entry (a
 *    legitimate NEW obligation, since the path was just touched again). If the first worker then
 *    unconditionally deleted or overwrote the queue doc based on its now-stale in-memory copy, it
 *    would silently erase that newer obligation. Every write-back here is conditional on the `_etag`
 *    the entry was queried with (Cosmos's own optimistic-concurrency primitive); a 412 mismatch means
 *    someone else changed the doc first, and this reconciler simply leaves it alone rather than
 *    clobbering it -- the newer writer's state wins.
 *
 * ZERO NEW AZURE INFRASTRUCTURE beyond those two guards: reuses the ALREADY-PROVISIONED Cosmos
 * `tasks` container (the same one the fleet work-ledger uses) under a dedicated board
 * (`DEINDEX_RESWEEP_BOARD`) and a distinct `type` (`'deindex_resweep'`, never `'task'`), so these
 * entries are invisible to every existing task_list/ledger query and never pollute the human-facing
 * work ledger. Runs as a `setInterval` inside the SAME long-lived gateway Container App process the
 * tool calls already run in -- no new scheduled job, no new deploy target. The gateway runs multiple
 * replicas; this reconciler runs independently on EACH one, same as revocation-store.ts's reloader --
 * safe because (a) the index cleanup itself is idempotent (two replicas racing to re-sweep the same
 * entry either both find nothing or one deletes real stale chunks while the other's identical attempt
 * is a no-op) and (b) the ETag-conditional queue writes above make the QUEUE state itself race-safe
 * too, not just the index side.
 *
 * AUTH IS RESOLVED ONCE PER TICK, not once per queued item (2026-08-04, Copilot review): the earlier
 * version called the one-shot `deindexChunkedPath` per entry, which internally minted its own admin
 * key every time -- up to DEINDEX_RESWEEP_BATCH_SIZE identical ARM `listAdminKeys` round trips per
 * tick per replica. Mirrors the exact fix round 3 already applied to blob-delete.ts's bulk loop:
 * `prepareDeindexAuth()` once, then `deindexChunkedPathWithAuth` per item.
 *
 * Fully fail-open at every layer: Cosmos being unconfigured or erroring never blocks a blob
 * operation (enqueue) and never crashes the reconciler (sweep) -- it just means this permanent
 * backstop is temporarily inert, exactly like every other agent-state feature degrades when Cosmos
 * is not configured for a given deployment.
 */

import { createHash } from 'node:crypto';
import { createDoc, deleteDoc, queryDocs, readDoc, replaceDoc, isConfigured as cosmosConfigured } from './cosmos.js';
import { prepareDeindexAuth, deindexChunkedPathWithAuth } from '../azure/search-write.js';
import { blobExistsWithTimeout, type LegalContainer } from '../legal/blob-store.js';

const TASKS = 'tasks';

/** Dedicated Cosmos partition (board) for resweep entries -- isolated from the real 'fleet' work
 *  ledger board, so a query scoped to this board only ever sees resweep queue entries. */
export const DEINDEX_RESWEEP_BOARD = 'deindex-resweep';
const DOC_TYPE = 'deindex_resweep';

/** How far past "now" a fresh entry's due_at is set: safely past the documented pull-indexer
 *  cadence (legal-personal/legal-company: cadence_min 360 = 6h, see
 *  otchealth-claude-tools/setup/expected-indexes.json) so that by the time this entry is due, any
 *  indexer run that was in flight at enqueue time has certainly completed -- the whole point of the
 *  delay is to stop racing that run instead of trying to out-time it. */
export const DEINDEX_RESWEEP_DELAY_MS = 7 * 60 * 60 * 1000; // 7h

/** Retry delay when a sweep attempt could not confirm clean (Cosmos/Search hiccup, deadline hit,
 *  search still unconfigured) -- short relative to the initial delay since these are transient
 *  infrastructure conditions, not another indexer-cadence wait. */
export const DEINDEX_RESWEEP_RETRY_DELAY_MS = 30 * 60 * 1000; // 30m

/** After this many failed attempts, a NON-RETRIABLE entry (generation uncertainty -- a recreated
 *  path this mechanism cannot safely characterize; see retryOrFail's own doc comment) stops
 *  retrying and is marked 'failed' (visible for manual/future generation-aware follow-up), instead
 *  of retrying forever for no gain. Does NOT apply to transient infrastructure conditions (Search/
 *  auth unavailable, an existence-check timeout, a Cosmos write hiccup) -- those retry INDEFINITELY
 *  on DEINDEX_RESWEEP_RETRY_DELAY_MS, since a longer-but-eventually-recoverable outage should not
 *  permanently strand the entry (2026-08-04, Copilot review round 17: the sweep query only selects
 *  status='pending', so a 'failed' entry is never automatically revisited -- terminal-ing a
 *  transient outage after a fixed attempt count silently broke the "self-heals within hours" promise
 *  this queue exists to keep). */
export const DEINDEX_RESWEEP_MAX_ATTEMPTS = 5;

/** Entries processed per reconciler tick -- bounds Cosmos RU + Azure Search load per tick even if
 *  a large backlog accumulates (e.g. after a bulk legal_blob_delete of hundreds of items). */
export const DEINDEX_RESWEEP_BATCH_SIZE = 20;

/** Per-item deindex deadline within a tick. Generous relative to the synchronous MCP-call budgets
 *  elsewhere in this codebase: this runs in the background with no external caller waiting on a
 *  transport timeout, so the only goal is "never hang the tick indefinitely," not "stay under 60s."
 *  MUST be added to a fresh `Date.now()` taken at the moment each item is dispatched, never to the
 *  tick-level `nowMs` (an adversarial review of an earlier version of this file caught exactly that
 *  mistake: `nowMs` is fixed once at tick entry, so reusing it as every item's deadline anchor meant
 *  later items in a busy batch could receive an already-expired deadline before they even started,
 *  silently defeating the budget and causing spurious `truncated:true` misses under load). */
const DEINDEX_RESWEEP_PER_ITEM_MS = 15_000;

/** How long the existence-check (blobExists) is allowed to run before this tick gives up on it and
 *  fails SAFE -- treating "could not confirm" the same as "assume it might still exist," i.e.
 *  skipping the delete and retrying later, never deleting on an unconfirmed existence check. Unlike
 *  every Cosmos/Search call in this pipeline, blob-store.ts's headBlob (which blobExists calls) has
 *  no timeout of its own (a real gap an adversarial review flagged, outside this file's own scope to
 *  fix at the source) -- this bounds it locally so a single hung Azure Blob HEAD request cannot stall
 *  an entire reconciler tick indefinitely. Uses the shared `blobExistsWithTimeout` (blob-store.ts,
 *  2026-08-04, Copilot review round 16) rather than a locally-duplicated race, since search-write.ts's
 *  synchronous immediate-cleanup path grew the identical need for the identical guard. */
const DEINDEX_RESWEEP_EXISTENCE_CHECK_TIMEOUT_MS = 8_000;

export interface DeindexResweepDoc {
  id: string;
  board: string;
  type: 'deindex_resweep';
  index: string;
  path: string;
  container: LegalContainer;
  due_at: string;
  status: 'pending' | 'failed';
  attempts: number;
  created_at: string;
  last_reason?: string;
}

/** Deterministic id from (index, path): a re-enqueue of the SAME path (e.g. a second move/delete
 *  touching it before the first entry's sweep runs) refreshes the existing entry's due_at/attempts
 *  via upsert instead of piling up duplicate entries for the same path. A cryptographic digest, NOT
 *  a 32-bit polynomial hash (2026-08-04, Copilot review round 15): the original version used the
 *  same lightweight technique ledger.ts's idFromIdempotencyKey does, but for THIS queue a collision
 *  is silent data loss, not just an id-reuse curiosity -- enqueue is an upsert-by-id, so two
 *  genuinely distinct paths that happen to alias to the same 32-bit hash would have the second
 *  path's enqueue silently overwrite the first path's queue entry (wrong index/path/due_at),
 *  dropping its cleanup obligation entirely with no error anywhere. A 32-bit space is also just
 *  too small (bounded collision odds) for a queue meant to run indefinitely and see effectively
 *  unbounded paths over the site's lifetime. SHA-256 over `JSON.stringify([index, path])` (rather
 *  than a delimited string) also closes a second aliasing source: an unescaped separator lets
 *  `index="A", path="a b"` and `index="A a", path="b"` collide on the same joined string; JSON's
 *  quoting/escaping makes the two encode differently. Still charset-safe for cosmos.ts's ID_RE (hex
 *  digits only) and well under its 255-char cap. */
function resweepId(index: string, path: string): string {
  const digest = createHash('sha256').update(JSON.stringify([index, path])).digest('hex');
  return `rs_${digest}`;
}

/** Bounded CAS-retry attempts for enqueueDeindexResweep's monotonic-due_at loop below. Small: real
 *  contention on the exact SAME (index, path) within milliseconds is rare, and this is a best-
 *  effort, fail-open backstop write -- exhausting retries degrades to "not confirmed persisted"
 *  (the existing, already-handled contract), never an unbounded loop. */
const DEINDEX_RESWEEP_ENQUEUE_CAS_ATTEMPTS = 3;

/** Enqueue a path for delayed re-verification. Fail-open: never throws, so a Cosmos hiccup here
 *  never affects the blob-delete/blob-move response that already durably happened by the time this
 *  is called. Call this in ADDITION to (not instead of) the existing synchronous
 *  deindexChunkedPath/deindexChunkedPathWithAuth cleanup -- this is the durable backstop for the
 *  race that synchronous cleanup cannot close, not a replacement for the fast common-case path.
 *  `container` is required so the sweep can run its existence-check guard (see module doc comment)
 *  without having to reverse-derive a container from the index name. Returns whether the write was
 *  CONFIRMED persisted -- callers that advertise this obligation as durable (blob-delete.ts,
 *  blob-move.ts's tool descriptions) should await this (bounded -- see enqueueDeindexResweepAwaited
 *  below) and surface the result, rather than firing-and-forgetting it (2026-08-04, Copilot review
 *  round 16: a fire-and-forget `void enqueueDeindexResweep(...)` call can still be in flight when
 *  the replica is terminated -- a replica shutdown between blob-delete/move returning and the
 *  underlying Cosmos upsert actually landing silently drops the only backstop for an indexer
 *  resurrection, while the response already claimed the path was durably enqueued).
 *
 *  DUE_AT IS MONOTONIC, NEVER REGRESSED, via a real CAS loop (2026-08-04, Copilot review rounds 17
 *  and 18): the deterministic id (resweepId) means two enqueues for the SAME path race, and a plain
 *  unconditional upsert is last-COMPLETION-wins, not last-CALLED-wins. Round 17's first fix (read
 *  the existing entry, then write) was CORRECTLY flagged as still unsafe under genuine concurrency:
 *  two enqueue calls can both read the same old/missing state BEFORE either writes, so the older
 *  call's later write can still regress due_at even though it "checked first" -- a plain read-then-
 *  write is not atomic. The actual fix: optimistically CREATE fresh via `createDoc` (a plain POST
 *  with no upsert flag, which Cosmos 409s if the id already exists -- exactly the concurrency
 *  signal this loop needs, no separate existence probe required). On any create failure (409 or
 *  otherwise -- a non-409 failure would likely also fail the read/replace below, degrading this
 *  attempt to a harmless no-op rather than a false "success"), read the existing entry and its ETag,
 *  merge due_at to the MAX of the existing and proposed values, and write back via an ETag-
 *  conditional `replaceDoc` (GUARD 2's same primitive). A 412 there means a concurrent writer landed
 *  first; the whole loop retries from the top. Bounded by DEINDEX_RESWEEP_ENQUEUE_CAS_ATTEMPTS,
 *  never unbounded. A fresh mutation still resets a previously-'failed'/retried entry's `attempts`
 *  to 0 (new content deserves a full fresh attempt budget), preserved via `nextDoc`'s own field set
 *  -- only `due_at` is ever merged forward. */
export async function enqueueDeindexResweep(index: string, path: string, container: LegalContainer, nowMs: number = Date.now()): Promise<boolean> {
  if (!cosmosConfigured()) return false;
  const id = resweepId(index, path);
  const proposedDueAt = new Date(nowMs + DEINDEX_RESWEEP_DELAY_MS).toISOString();
  const freshDoc: DeindexResweepDoc = {
    id,
    board: DEINDEX_RESWEEP_BOARD,
    type: DOC_TYPE,
    index,
    path,
    container,
    due_at: proposedDueAt,
    status: 'pending',
    attempts: 0,
    created_at: new Date(nowMs).toISOString(),
  };

  for (let attempt = 0; attempt < DEINDEX_RESWEEP_ENQUEUE_CAS_ATTEMPTS; attempt++) {
    try {
      await createDoc(TASKS, DEINDEX_RESWEEP_BOARD, freshDoc as unknown as Record<string, unknown>);
      return true; // no prior entry existed -- our proposed due_at is trivially the max.
    } catch {
      // Fall through to read-and-conditionally-replace below (see doc comment for why this branch
      // is taken for ANY create failure, not just a confirmed 409).
    }
    try {
      const existing = await readDoc(TASKS, DEINDEX_RESWEEP_BOARD, id);
      if (!existing) continue; // deleted between the create conflict and this read -- retry create.
      const existingDueAt = (existing.doc as { due_at?: string }).due_at;
      const due_at = existingDueAt && existingDueAt > proposedDueAt ? existingDueAt : proposedDueAt;
      const nextDoc = { ...freshDoc, due_at };
      const rep = await replaceDoc(TASKS, DEINDEX_RESWEEP_BOARD, id, nextDoc as unknown as Record<string, unknown>, existing.etag ?? undefined);
      if (rep.status === 412) continue; // a concurrent writer landed first -- retry the whole loop.
      return rep.ok;
    } catch {
      return false;
    }
  }
  // Fail-open by design (see doc comment above): exhausting CAS attempts under heavy contention
  // just means this specific path relies solely on the synchronous best-effort cleanup that
  // already ran, same as any other enqueue failure.
  return false;
}

/** How long a caller that wants to AWAIT enqueueDeindexResweep (to know whether it actually
 *  persisted before responding) will wait before giving up and reporting "not confirmed." Small: a
 *  single Cosmos upsert is normally well under a second, and this sits on an already-completed
 *  blob operation's response critical path (2026-08-04, Copilot review round 16), so it must not
 *  meaningfully add to the MCP transport-timeout exposure the rest of this PR spent many rounds
 *  tightening. The underlying write is NOT cancelled when this timeout wins (no AbortController
 *  plumbing here, matching this file's existsWithTimeout/blob-store.ts's blobExistsWithTimeout) --
 *  it may still land after the caller has already reported `false`, which just means the caller's
 *  durability signal is conservative (a late-but-real persist is strictly better than the
 *  fire-and-forget version's total silence), never wrong in the unsafe direction. */
const DEINDEX_RESWEEP_ENQUEUE_AWAIT_TIMEOUT_MS = 2_000;

/** Bounded-await wrapper over enqueueDeindexResweep -- see its own doc comment for why callers that
 *  advertise this obligation as durable should use this instead of a bare fire-and-forget call. */
export async function enqueueDeindexResweepAwaited(index: string, path: string, container: LegalContainer, nowMs: number = Date.now()): Promise<boolean> {
  return Promise.race([
    enqueueDeindexResweep(index, path, container, nowMs),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), DEINDEX_RESWEEP_ENQUEUE_AWAIT_TIMEOUT_MS);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** One reconciler tick: query due entries, re-verify each (existence-check first, then re-run the
 *  index cleanup for anything genuinely still gone), and update the queue accordingly with
 *  ETag-conditional writes. Exported (not just the interval wrapper) so it is directly
 *  callable/testable without waiting on a real timer, and so an operator can trigger a tick on
 *  demand if needed. Fail-open: a per-item error is caught and treated as an incomplete attempt
 *  (retried later), and a failure to even QUERY Cosmos returns a zero-progress result rather than
 *  throwing. */
export async function runDeindexResweepOnce(
  nowMs: number = Date.now(),
): Promise<{ processed: number; cleaned: number; requeued: number; failed: number; raced: number; reason?: string }> {
  if (!cosmosConfigured()) return { processed: 0, cleaned: 0, requeued: 0, failed: 0, raced: 0, reason: 'Cosmos not configured' };

  let due: Record<string, unknown>[];
  try {
    due = await queryDocs(
      TASKS,
      // TOP (2026-08-04, Copilot review round 16): queryDocs's own client-side `.slice(0, max)`
      // already correctly bounds the ARRAY this function returns to DEINDEX_RESWEEP_BATCH_SIZE --
      // verified by this file's own "batch size is honored" test, which enqueues MORE than the
      // batch size and asserts `processed` never exceeds it. TOP is a separate, real efficiency fix
      // on top of that: without it, a single Cosmos page can internally return up to 100 documents
      // (queryDocs's own page-size hint) and be charged RU for all of them, even though only
      // DEINDEX_RESWEEP_BATCH_SIZE are ever used -- asking Cosmos to cap the result set AT THE
      // QUERY ITSELF avoids paying RU for rows this function was always going to discard.
      `SELECT TOP ${DEINDEX_RESWEEP_BATCH_SIZE} * FROM c WHERE c.type = @type AND c.status = 'pending' AND c.due_at <= @now`,
      [
        { name: '@type', value: DOC_TYPE },
        { name: '@now', value: new Date(nowMs).toISOString() },
      ],
      { pk: DEINDEX_RESWEEP_BOARD, max: DEINDEX_RESWEEP_BATCH_SIZE },
    );
  } catch (e) {
    return { processed: 0, cleaned: 0, requeued: 0, failed: 0, raced: 0, reason: `Cosmos query failed: ${(e as Error).message}` };
  }

  if (due.length === 0) return { processed: 0, cleaned: 0, requeued: 0, failed: 0, raced: 0 };

  // Resolve auth ONCE for the whole tick, not once per item (see module doc comment).
  const { auth } = await prepareDeindexAuth();

  let cleaned = 0;
  let requeued = 0;
  let failed = 0;
  let raced = 0;

  for (const raw of due) {
    const entry = raw as unknown as DeindexResweepDoc & { _etag?: string };
    try {
      // GUARD 1: existence check. See module doc comment for why this must run before any
      // path-only delete, and why it is the reason legal_blob_move's overwrite destination is
      // never enqueued here at all. Timeout-bounded and fail-SAFE: "could not confirm in time"
      // (null) is treated the same as "requeue, don't delete," never as "assume gone."
      const nowExists = await blobExistsWithTimeout(entry.container, entry.path, DEINDEX_RESWEEP_EXISTENCE_CHECK_TIMEOUT_MS);
      if (nowExists === null) {
        // Could not confirm existence in time -- persist a real retry (GUARD: this must advance
        // due_at, not just bump a counter; see retryOrFail's doc comment for the busy-loop bug an
        // earlier version of this branch had).
        const outcome = await retryOrFail(entry, 'existence check timed out', nowMs);
        if (outcome === 'raced') raced++;
        else if (outcome === 'failed') failed++;
        else requeued++;
        continue;
      }
      if (nowExists) {
        // A blob now exists at this path again (a concurrent legal_blob_put). Guard 1 correctly
        // still refuses to run a path-only delete here -- that risk (destroying the NEW content's
        // own valid chunks) is exactly what this check exists to prevent. But dropping the queue
        // entry outright as "job done" was ALSO wrong (2026-08-04, Copilot review round 16): if the
        // recreated content has FEWER or DIFFERENT chunks than whatever was here before, the pull-
        // indexer's own re-index only adds/updates chunks for the CURRENT content -- it does not
        // know to remove excess chunk IDs left over from the PRIOR generation (the exact deletion-
        // detection gap this whole PR exists to work around), so those orphaned prior-generation
        // chunks can persist forever with nothing left tracking them once this entry silently
        // vanished. Correctly closing this needs generation/ETag-aware chunk targeting (a chunk-
        // schema change -- the SAME open, tracked limitation already documented for
        // legal_blob_move's dst_path-overwrite case in search-write.ts), not yet built and not safe
        // to improvise here. Until then, treat "path recreated" as UNCERTAIN, not "done": route
        // through the same backoff/eventual-failed bookkeeping as any other not-confirmed-clean
        // outcome, so the obligation stays VISIBLE (a 'failed' entry after the attempt cap,
        // discoverable for a future generation-aware sweep) instead of disappearing without a
        // trace. Never counted as `skipped` any more -- that outcome name implied "verified safe,
        // nothing to do," which this case is not.
        const outcome = await retryOrFail(
          entry,
          'path was recreated before this resweep ran -- cannot safely verify or clean any orphaned prior-generation chunks without generation-aware chunk targeting (open follow-up, see search-write.ts)',
          nowMs,
          true, // nonRetriable: generation uncertainty does not resolve by waiting -- see retryOrFail's doc comment
        );
        if (outcome === 'raced') raced++;
        else if (outcome === 'failed') failed++;
        else requeued++;
        continue;
      }

      if (!auth) {
        // Auth failed for the whole tick -- persist a real retry rather than leaving due_at
        // unchanged (the same busy-loop risk as the existence-check-timeout case above, since a
        // persistently failing auth path would otherwise re-select the SAME batch every tick).
        const outcome = await retryOrFail(entry, 'deindex auth unavailable this tick', nowMs);
        if (outcome === 'raced') raced++;
        else if (outcome === 'failed') failed++;
        else requeued++;
        continue;
      }

      // Deadline computed FRESH per item from real wall-clock time, not from the tick-level
      // `nowMs` (which is fixed once at tick entry, and in tests may not even be real time) --
      // see DEINDEX_RESWEEP_PER_ITEM_MS's own doc comment for the bug this fixes.
      const deadlineAtMs = Date.now() + DEINDEX_RESWEEP_PER_ITEM_MS;
      // Pass `entry.container` (2026-08-04, Copilot review round 16) so deindexChunkedPathWithAuth
      // runs its OWN re-check immediately before searching/deleting -- GUARD 1 above already
      // confirmed non-existence moments ago, but this call itself can run for up to
      // DEINDEX_RESWEEP_PER_ITEM_MS (paginating a busy index), during which a fresh recreation could
      // still land; re-checking right at the point of danger narrows that residual window.
      const result = await deindexChunkedPathWithAuth(auth, entry.index, entry.path, deadlineAtMs, entry.container);
      const confirmedClean = result.attempted && !result.truncated;

      if (confirmedClean) {
        const del = await deleteDoc(TASKS, DEINDEX_RESWEEP_BOARD, entry.id, entry._etag);
        if (del.status === 412) raced++;
        else cleaned++;
        continue;
      }

      // Not confirmed clean this tick -- retry later, up to the attempt cap.
      const outcome = await retryOrFail(entry, result.reason ?? 'not confirmed clean', nowMs);
      if (outcome === 'raced') raced++;
      else if (outcome === 'failed') failed++;
      else requeued++;
    } catch (e) {
      // Never let one bad entry (a malformed doc, a Cosmos write hiccup, or a genuine failure
      // inside retryOrFail itself) stop the rest of the batch or crash the reconciler. Try to
      // persist a real backoff here too (2026-08-04, Copilot review round 16): this catch
      // previously only incremented an in-memory counter, leaving due_at unchanged, so a
      // persistently-malformed or repeatably-exception-throwing entry was immediately eligible
      // again every tick forever -- the SAME busy-loop class the two branches above were fixed for,
      // just for the residual "something unexpected happened" case. Best-effort, nested: if
      // retryOrFail ALSO throws (plausible, since the very failure that reached this catch might
      // BE a Cosmos write error thrown by an earlier retryOrFail call for this same entry), do not
      // let that compound into an unhandled rejection -- fall back to the original safe behavior of
      // leaving the entry exactly as queried, counted requeued, rather than risking a retry-of-a-
      // retry loop within a single tick.
      try {
        // nonRetriable=true (2026-08-04, Copilot review round 17): every KNOWN transient-infra
        // condition already has its own non-throwing branch above and never reaches this catch, so
        // an exception landing HERE is far more likely to be a genuinely permanent, structural
        // problem (a malformed doc, an unanticipated bug) than a recoverable blip -- retrying that
        // forever would just reintroduce the exact busy-loop-on-a-poison-pill-entry risk this whole
        // function exists to close. See retryOrFail's own doc comment for the full split.
        const outcome = await retryOrFail(entry, e instanceof Error ? e.message : 'unexpected sweep error', nowMs, true);
        if (outcome === 'raced') raced++;
        else if (outcome === 'failed') failed++;
        else requeued++;
      } catch {
        requeued++;
      }
    }
  }

  return { processed: due.length, cleaned, requeued, failed, raced };
}

/** Shared retry/fail bookkeeping for a sweep attempt that could NOT confirm clean this tick --
 *  bumps `attempts`, pushes `due_at` forward, and writes it back ETag-conditionally (GUARD 2: a 412
 *  means a fresher writer already governs this entry; leave it alone). Factored out (2026-08-04,
 *  Copilot review round 15) after the existence-check-timeout branch was found NOT persisting
 *  anything at all -- it only incremented the in-memory `requeued` counter, leaving the entry's
 *  `due_at` unchanged (still in the past), so the very same timed-out entry was immediately eligible
 *  again on every subsequent tick forever: an unbounded busy-loop of uncancelled Blob HEAD requests
 *  that could crowd the fixed-size batch ahead of genuinely healthy entries.
 *
 *  `nonRetriable` (2026-08-04, Copilot review round 17) separates TWO genuinely different classes
 *  of "not confirmed clean," which the original single DEINDEX_RESWEEP_MAX_ATTEMPTS cap conflated:
 *  - TRANSIENT infrastructure hiccups (Search/auth unavailable, an existence-check timeout, a
 *    Cosmos write hiccup reaching the outer catch) WILL eventually clear on their own. Terminal-ing
 *    these to 'failed' after a fixed ~5 attempts x 30 minutes (~2.5h) means a longer-but-recoverable
 *    outage permanently strands the entry: the sweep query only selects `status='pending'`, so a
 *    'failed' entry is never automatically revisited, contradicting the durable "self-heals within
 *    hours" promise this whole queue exists to keep. Default `false` -- these keep retrying on the
 *    same DEINDEX_RESWEEP_RETRY_DELAY_MS cadence INDEFINITELY, never hard-terminal. The bounded cost
 *    of a permanently-broken infra path retrying forever (one batch slot every ~20-30 minutes) is
 *    strictly preferable to silently losing the only backstop against an indexer resurrection.
 *  - The ONE genuinely NON-retriable case is generation uncertainty (a path was recreated with
 *    content this mechanism cannot safely characterize as a superset of the prior generation) --
 *    retrying does not help here; the path will still exist, still be uncharacterizable, every time.
 *    That case passes `nonRetriable: true` so it keeps the original bounded-attempts-then-'failed'
 *    behavior, making the unresolvable state visible (discoverable for a future generation-aware
 *    sweep) instead of retrying forever for no gain. The outer per-item catch-all ALSO passes
 *    `nonRetriable: true`: an exception reaching that block (a malformed doc, an unanticipated bug)
 *    is far more likely to be a permanent, structural problem than a transient network blip -- every
 *    KNOWN transient-infra condition already has its own non-throwing branch above and never reaches
 *    that catch, so retrying it forever would just be the exact "busy-loop on a poison-pill entry"
 *    risk this function was built to close. */
async function retryOrFail(
  entry: DeindexResweepDoc & { _etag?: string },
  reason: string,
  nowMs: number,
  nonRetriable: boolean = false,
): Promise<'raced' | 'requeued' | 'failed'> {
  const attempts = (entry.attempts ?? 0) + 1;
  const willFail = nonRetriable && attempts >= DEINDEX_RESWEEP_MAX_ATTEMPTS;
  const nextDoc: Record<string, unknown> = willFail
    ? { ...entry, attempts, status: 'failed', last_reason: reason }
    : { ...entry, attempts, due_at: new Date(nowMs + DEINDEX_RESWEEP_RETRY_DELAY_MS).toISOString(), last_reason: reason };
  delete (nextDoc as { _etag?: string })._etag; // never write the read-etag back as document content
  const rep = await replaceDoc(TASKS, DEINDEX_RESWEEP_BOARD, entry.id, nextDoc, entry._etag);
  if (rep.status === 412) return 'raced';
  // replaceDoc (unlike deleteDoc) never throws on a genuine non-412 failure -- it just returns the
  // failed response, so a real Cosmos write failure must be surfaced here rather than silently
  // treated as a successful requeue/fail (2026-08-04, adversarial review). The caller's per-item
  // try/catch routes this to the SAME safe fallback (leave the entry untouched, counted requeued)
  // as any other per-item error.
  if (!rep.ok) throw new Error(`Cosmos replaceDoc ${rep.status}: ${JSON.stringify(rep.body).slice(0, 200)}`);
  return willFail ? 'failed' : 'requeued';
}

const DEFAULT_TICK_MS = 20 * 60 * 1000; // 20m
let _tickTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic reconciler (idempotent; no-op without Cosmos). Called once from server boot,
 *  exactly like startRevocationReloader (see that file for the multi-replica safety rationale this
 *  mirrors, and this file's own module doc comment for why multi-replica execution is safe on BOTH
 *  the index side and the queue-state side). tickMs is overridable for tests; production always
 *  uses the default. */
export function startDeindexResweepReloader(tickMs: number = DEFAULT_TICK_MS): void {
  if (_tickTimer || !cosmosConfigured()) return;
  _tickTimer = setInterval(() => {
    void runDeindexResweepOnce();
  }, tickMs);
  // Do not keep the event loop alive just for this timer.
  (_tickTimer as unknown as { unref?: () => void }).unref?.();
}

/** Stop the reconciler (test teardown / graceful shutdown). */
export function stopDeindexResweepReloader(): void {
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}
