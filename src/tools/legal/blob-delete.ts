import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured, headBlob, blobExists, copyBlob, deleteBlobHard, listBlobs } from '../../legal/blob-store.js';
import { isLegalContainerAllowed, lanesForContainer, isProtectedPath, searchIndexForContainer } from './ring.js';
import { loadEnv } from '../../config/env.js';
import { prepareDeindexAuth, deindexChunkedPathWithAuth, type DeindexAuth } from '../../azure/search-write.js';
import { enqueueDeindexResweepAwaited } from '../../agentstate/deindex-resweep.js';

export const DEFAULT_MAX_ITEMS = 100;
export const HARD_MAX_ITEMS = 500;
/** Per-item cleanup deadline never exceeds this many ms, even when the batch's own time budget has
 *  more room left than that (2026-08-04, Copilot review PR #192 round 2: an earlier "skip cleanup
 *  when budget is thin" design silently abandoned cleanup with no visible signal -- deadline-bound
 *  it instead, so every item is at least ATTEMPTED and any incomplete result is reported in
 *  `deindex_incomplete`, never just dropped). */
const DEINDEX_PER_ITEM_CAP_MS = 8000;

/** How much of the configured move-time budget the live loop actually gets, once pre-mutation auth
 *  resolution (which is NOT allowed to starve moves, see the call site) has taken its own bite out
 *  of the transport-timeout margin LEGAL_DELETE_TIME_BUDGET_MS was tuned against (2026-08-04,
 *  Copilot review PR #192 round 7). Pure and exported so the math is directly unit-testable without
 *  timing-based coordination against a real setTimeout. Floored at 1000ms -- the same minimum
 *  LEGAL_DELETE_TIME_BUDGET_MS's own env schema enforces -- so a slow auth call can shrink the move
 *  budget but never fully starve it (that was round 3's fix; this must not undo it). */
export function effectiveMoveBudgetMs(configuredBudgetMs: number, authElapsedMs: number): number {
  return Math.max(1000, configuredBudgetMs - authElapsedMs);
}

/** Soft-delete destination for a given original path -- never a real hard delete of the only copy. */
export function trashPathFor(path: string): string {
  return `_TRASH/${path}`;
}

export const legalBlobDeleteInputShape = {
  container: z.enum(['company', 'personal']).describe('Which legal container. personal is ring-gated to the legal-personal executive ring.'),
  path: z.string().optional().describe('Single blob path to soft-delete. Mutually exclusive with prefix.'),
  prefix: z.string().optional().describe('Path prefix for a bulk soft-delete of every blob under it. Mutually exclusive with path. Bounded by max_items.'),
  max_items: z.number().int().min(1).max(HARD_MAX_ITEMS).optional().describe(`Cap on how many blobs a prefix delete may touch (default ${DEFAULT_MAX_ITEMS}, hard max ${HARD_MAX_ITEMS}). If more blobs match than this, the call refuses entirely -- it never silently processes a partial set.`),
  confirm: z.string().min(1).describe('Must exactly equal "path" (single mode) or "prefix" (bulk mode). Required on every call, including dry_run, so the confirmation habit is built before it matters.'),
} satisfies ZodRawShape;

export const legalBlobDeleteOutputShape = {
  executed: z.boolean(),
  dry_run: z.boolean(),
  container: z.string(),
  mode: z.enum(['single', 'prefix']).nullable(),
  matched: z.number(),
  moved: z.array(z.object({ from: z.string(), to: z.string() })),
  /** Items that would (dry_run) or did (a mid-batch stop) collide with an existing _TRASH/ path. */
  collisions: z.array(z.object({ from: z.string(), to: z.string() })),
  /** 'partial' means the call stopped at its time budget with items still unprocessed (see
   *  `remaining`) -- re-invoke with the SAME path/prefix to continue; already-moved items will not
   *  be re-matched. 'complete' means every matched item was either moved or the call stopped for a
   *  reason already reflected in `error` (trash_collision, too_many_matches, ...). */
  status: z.enum(['complete', 'partial']),
  /** How many resolved items were neither moved nor definitively refused. 0 outside a 'partial' stop. */
  remaining: z.number(),
  /** ISO8601 timestamp of the listing/existence-check this response is based on, or null when the
   *  call refused BEFORE ever reading storage (2026-08-04, CLO field report Finding 2, tightened
   *  after PR #191 review: every response that DID observe storage -- including not_found,
   *  protected_prefix on a resolved candidate set, too_many_matches, and zero-matches, not only
   *  dry_run/executed -- carries the real timestamp, since Azure's List Blobs enumeration is not
   *  guaranteed strongly consistent the way a single-blob GET/HEAD is and any of those responses can
   *  be judged stale). null (not an empty string) precisely marks "no observation happened". */
  as_of: z.string().nullable(),
  /** Chunk documents actively removed from the search index for the ORIGINAL (pre-move) path(s) of
   *  every item actually moved this call (2026-08-04, CLO field report Finding 3): the chunked doc
   *  rooms are fed by slow native pull-indexers with no deletion-detection policy, so without this
   *  a soft-deleted blob's stale index entry survives indefinitely, citing a path that
   *  legal_blob_get now returns not_found for. Best-effort/fail-open -- a lower count than expected
   *  does not mean the blob move failed, only that index cleanup could not confirm a match (the
   *  room may not have indexed this path yet, which is not an error). Always 0 on dry_run.
   */
  deindexed: z.number(),
  /** ORIGINAL (from) paths of items whose move succeeded but whose IMMEDIATE search-index cleanup
   *  was NOT confirmed complete (a deadline, a mid-pagination failure, or search being
   *  unconfigured entirely) -- these paths may still return a stale search hit right after this
   *  call returns (2026-08-04, Copilot review PR #192 round 2: reporting cleanup as
   *  done-or-silently-abandoned with no signal either way is worse than an honest "not
   *  confirmed"). Always empty on dry_run. Every moved item's original path -- listed here or not
   *  -- is ALSO enqueued into a durable delayed re-verification sweep (agentstate/deindex-resweep.ts)
   *  that runs safely past one full indexer cadence, so this list is visibility into the immediate
   *  result, not the whole recovery story: an entry here should self-heal within hours without
   *  needing to re-invoke this tool.
   */
  deindex_incomplete: z.array(z.string()),
  /** ORIGINAL (from) paths whose durable delayed re-verification enqueue (deindex-resweep.ts) was
   *  NOT confirmed persisted before this call returned (2026-08-04, Copilot review round 16: the
   *  earlier fire-and-forget `void enqueueDeindexResweep(...)` gave no way to know whether the
   *  durable backstop this tool's description promises actually landed). Bounded await, not
   *  fire-and-forget -- still never blocks or fails the blob move itself. A path listed both here
   *  AND in `deindex_incomplete` has neither cleanup mechanism confirmed for it, worth noticing.
   *  Always empty on dry_run. */
  deindex_resweep_incomplete: z.array(z.string()),
  error: z.string().optional(),
} satisfies ZodRawShape;

export type LegalBlobDeleteInput = z.infer<z.ZodObject<typeof legalBlobDeleteInputShape>>;

/**
 * `legal_blob_delete` handler. Exported standalone. SOFT delete only -- every call moves the
 * matched blob(s) to `_TRASH/<original-path>` (copy-then-remove-original, same primitive as
 * legal_blob_move), never a hard delete of the only copy. See the tool's own description for the
 * full safety design (2026-08-04, CLO brief §1): confirm echo, protected-prefix refusal,
 * bounded+non-silent bulk mode, sequential execution with a clear stop-and-report on any mid-batch
 * collision.
 */
interface DeleteItem {
  from: string;
  to: string;
  /** Source ETag observed when this item's candidacy was resolved (headBlob for single mode,
   *  Azure's List Blobs <Etag> for bulk mode) -- pins the copy + the original's delete to this
   *  exact version so a concurrent overwrite between resolution and execution fails closed rather
   *  than deleting a version that was never actually copied to _TRASH/ (2026-08-04, PR #190 review). */
  etag: string | null;
}

export async function handleLegalBlobDelete(input: LegalBlobDeleteInput, ctx: ToolContext): Promise<ToolResultPayload> {
  const container = input.container;
  const caller = ctx.callerAgent || '';
  const lanes = lanesForContainer(container);
  const base = {
    executed: false,
    dry_run: ctx.dryRun,
    container,
    mode: null as 'single' | 'prefix' | null,
    matched: 0,
    moved: [] as Array<{ from: string; to: string }>,
    collisions: [] as Array<{ from: string; to: string }>,
    status: 'complete' as 'complete' | 'partial',
    remaining: 0,
    as_of: null as string | null,
    deindexed: 0,
    deindex_incomplete: [] as string[],
    deindex_resweep_incomplete: [] as string[],
  };

  if (!isLegalContainerAllowed(container, caller)) {
    return { data: { ...base, error: 'forbidden_ring' }, summary: `Refused: deleting from legal container "${container}" requires one of the ${lanes.join('/')} trusted lanes. Your identity: ${caller || '(none)'}.` };
  }
  if (!isConfigured()) {
    return { data: { ...base, error: 'unconfigured' }, summary: 'Legal store not configured (AZURE_LEGAL_STORAGE_KEY unset).' };
  }
  if ((input.path == null) === (input.prefix == null)) {
    return { data: { ...base, error: 'invalid_input' }, summary: 'Provide exactly one of path or prefix, not both and not neither.' };
  }

  const mode: 'single' | 'prefix' = input.path != null ? 'single' : 'prefix';
  const target = (input.path ?? input.prefix) as string;
  if (input.confirm !== target) {
    return {
      data: { ...base, mode, error: 'confirm_mismatch' },
      summary: `Refused: confirm ("${input.confirm}") must exactly equal ${mode === 'single' ? 'path' : 'prefix'} ("${target}"). Nothing was touched.`,
    };
  }
  if (isProtectedPath(target)) {
    return { data: { ...base, mode, error: 'protected_prefix' }, summary: `Refused: "${target}" falls under a protected prefix and cannot be deleted (evidence stays append-only).` };
  }

  // Resolve the exact set of (path -> trash path) pairs this call would act on. `asOf` is stamped
  // IMMEDIATELY after the real storage observation (headBlob / listBlobs) that each branch performs
  // -- not once at the end -- so every return from this point on (not_found, protected_prefix on a
  // resolved candidate, too_many_matches, zero-matches, dry_run, executed) carries the real
  // observation time, not the default null (2026-08-04, PR #191 review).
  let items: DeleteItem[];
  let asOf: string;
  if (mode === 'single') {
    const path = input.path as string;
    // Reject BEFORE checking existence: re-trashing an already-trashed path (_TRASH/x ->
    // _TRASH/_TRASH/x) breaks the recovery invariant bulk mode already enforces via its
    // "!b.name.startsWith('_TRASH/')" filter below -- single mode had no equivalent guard
    // (2026-08-04, PR #190 review). No storage read has happened yet, so as_of stays null (base's
    // default) on this refusal.
    if (path.startsWith('_TRASH/')) {
      return {
        data: { ...base, mode, error: 'already_trashed' },
        summary: `Refused: "${path}" is already under _TRASH/ -- soft-deleting it again would nest it as _TRASH/_TRASH/... and break the recovery path. Use legal_blob_move to relocate it out of _TRASH/ first if that is genuinely the intent.`,
      };
    }
    const head = await headBlob(container, path);
    asOf = new Date().toISOString();
    if (!head.exists) {
      return { data: { ...base, mode, as_of: asOf, error: 'not_found' }, summary: `Refused: no blob at legal/${container}/${path}.` };
    }
    items = [{ from: path, to: trashPathFor(path), etag: head.etag }];
  } else {
    const prefix = input.prefix as string;
    const maxItems = input.max_items ?? DEFAULT_MAX_ITEMS;
    const found = await listBlobs(container, prefix);
    asOf = new Date().toISOString();
    // Never touch anything already in _TRASH/ via a prefix sweep -- a broad top-level prefix could
    // otherwise re-trash an already-trashed item.
    const candidates = found.filter((b) => !b.name.startsWith('_TRASH/'));
    // A bulk prefix can be an ANCESTOR of a protected prefix (e.g. prefix="clo-outgoing/" is not
    // itself protected, but its candidates can include the protected court-download subtree). Check
    // every resolved candidate, not just the prefix string itself, and refuse the WHOLE batch (never
    // a silent partial skip) if any candidate is protected (2026-08-04, PR #190 review).
    const protectedHit = candidates.find((b) => isProtectedPath(b.name));
    if (protectedHit) {
      return {
        data: { ...base, mode, matched: candidates.length, as_of: asOf, error: 'protected_prefix' },
        summary: `Refused: prefix "${prefix}" matches ${candidates.length} blob(s), at least one of which ("${protectedHit.name}") falls under a protected prefix. Nothing was touched -- narrow the prefix to exclude the protected subtree.`,
      };
    }
    if (candidates.length > maxItems) {
      return {
        data: { ...base, mode, matched: candidates.length, as_of: asOf, error: 'too_many_matches' },
        summary: `Refused: ${candidates.length} blob(s) match prefix "${prefix}", which exceeds max_items=${maxItems}. Narrow the prefix or raise max_items (hard cap ${HARD_MAX_ITEMS}) and re-run. Nothing was touched.`,
      };
    }
    if (candidates.length === 0) {
      return { data: { ...base, mode, matched: 0, as_of: asOf }, summary: `No blobs matched prefix "${prefix}" (outside _TRASH/). Nothing to do.` };
    }
    items = candidates.map((b) => ({ from: b.name, to: trashPathFor(b.name), etag: b.etag }));
  }

  const budgetMs = loadEnv().LEGAL_DELETE_TIME_BUDGET_MS;
  const startedAt = Date.now();

  if (ctx.dryRun) {
    // Preflight the trash-destination collision check even in dry_run: a dry_run that only ever
    // says "would move" understates what a live call would actually do if a destination already
    // exists (the live call stops the batch there) -- report the split so "what would move" is
    // trustworthy on its own, without ever issuing a PUT/DELETE (2026-08-04, PR #190 review).
    // Time-budgeted the same as live execution below: a large batch's preflight (one blobExists HEAD
    // per item) can itself approach the transport ceiling.
    const moved: Array<{ from: string; to: string }> = [];
    const collisions: Array<{ from: string; to: string }> = [];
    let status: 'complete' | 'partial' = 'complete';
    for (const item of items) {
      if (Date.now() - startedAt > budgetMs) {
        status = 'partial';
        break;
      }
      const wouldCollide = await blobExists(container, item.to);
      (wouldCollide ? collisions : moved).push({ from: item.from, to: item.to });
    }
    const checked = moved.length + collisions.length;
    const remaining = items.length - checked;
    return {
      data: { ...base, dry_run: true, mode, matched: items.length, moved, collisions, status, remaining, as_of: asOf },
      audit: { before: { matched: items.length }, after: null },
      summary:
        status === 'partial'
          ? `DRY RUN (PARTIAL, time budget): previewed ${checked}/${items.length} before stopping at the time budget; ${remaining} unchecked. Re-run to see the full plan, or just pass dry_run=false -- the live run applies the same budget and is naturally resumable. Plan as of ${asOf}.`
          : collisions.length
            ? `DRY RUN: would soft-delete ${moved.length}/${items.length} blob(s) in legal/${container} (move to _TRASH/); ${collisions.length} would COLLIDE with an existing _TRASH/ path and would stop a live run at that point (see collisions). Plan as of ${asOf} -- Azure's blob listing is not guaranteed strongly consistent, re-run if this is more than a few seconds old before trusting it. Pass dry_run=false to apply.`
            : `DRY RUN: would soft-delete ${items.length} blob(s) in legal/${container} (move to _TRASH/). Plan as of ${asOf} -- Azure's blob listing is not guaranteed strongly consistent, re-run if this is more than a few seconds old before trusting it. Pass dry_run=false to apply.`,
    };
  }

  // Execute one at a time, sequentially -- these are legal documents, not a place for
  // concurrent-write surprises, and a partial failure should stop with a clear accounting of what
  // DID move rather than racing ahead.
  //
  // SELF-BOUNDED TO THE TIME BUDGET (2026-08-04, CLO field report Finding 1): the CLO's live 147-item
  // batch measured ~0.7s/item -- ~100s total, over the 60s MCP transport timeout. The delete had
  // actually completed server-side, but the client had no way to know that: it just saw a transport
  // timeout with no partial-progress signal. Checking the budget BEFORE each item (not after) means
  // the response is always sent well inside the transport window, with an honest {status:'partial',
  // remaining} instead of an orphaned execution the caller can't observe. A partial stop is naturally
  // resumable: re-invoking with the SAME path/prefix only re-matches what has not yet moved, since
  // moved items are gone from the source prefix by then.
  // The index that indexes this container's blobs -- needed to purge the stale entry at each
  // item's ORIGINAL path once its move succeeds (2026-08-04, CLO field report Finding 3; see
  // deindexChunkedPathWithAuth's own doc comment for the full rationale). Auth is resolved ONCE
  // here, outside the loop -- not per item -- so a large batch does not mint N identical ARM
  // admin-key round trips (2026-08-04, Copilot review PR #192).
  //
  // BOUNDED to DEINDEX_AUTH_DEADLINE_MS (prepareDeindexAuth's own default) and, critically, NOT
  // ALLOWED TO STARVE the move-time budget below: this call happens BEFORE any blob has moved, so
  // an unbounded (or budget-shared) auth resolution would let cleanup infrastructure block the
  // tool's PRIMARY function -- a slow/erroring Azure control plane could consume the whole budget
  // before the first item even starts, turning a best-effort add-on into an outage of the actual
  // delete (2026-08-04, Copilot review PR #192 round 3).
  //
  // `moveStartedAt` is a SEPARATE clock, started only after this resolves. But the move loop's
  // budget is `effectiveBudgetMs`, not the raw configured `budgetMs`: LEGAL_DELETE_TIME_BUDGET_MS's
  // ceiling (see config/env.ts) was tuned so budgetMs + copyBlob's worst-case 20s poll stays under
  // the 60s MCP transport timeout with real margin, on the assumption that auth resolution is free.
  // It is not -- auth can take up to DEINDEX_AUTH_DEADLINE_MS on the pre-mutation critical path, and
  // silently NOT counting that against anything would erode exactly the margin that bound was
  // designed to guarantee (2026-08-04, Copilot review PR #192 round 7). So the auth latency IS
  // subtracted from the move loop's own budget here -- preserving round 3's guarantee that a slow
  // auth call never fully starves the primary delete (floored at the same 1000ms minimum
  // LEGAL_DELETE_TIME_BUDGET_MS's own schema enforces) while keeping total wall time close to the
  // configured budget instead of silently growing by however long auth took.
  const searchIndex = searchIndexForContainer(container);
  const authStartedAt = Date.now();
  const deindexAuth: DeindexAuth | null = (await prepareDeindexAuth()).auth;
  const authElapsedMs = Date.now() - authStartedAt;
  const moveStartedAt = Date.now();
  const effectiveBudgetMs = effectiveMoveBudgetMs(budgetMs, authElapsedMs);
  const moved: Array<{ from: string; to: string }> = [];
  let deindexedCount = 0;
  const deindexIncomplete: string[] = [];
  const deindexResweepIncomplete: string[] = [];
  for (const item of items) {
    if (Date.now() - moveStartedAt > effectiveBudgetMs) {
      const remaining = items.length - moved.length;
      return {
        data: { ...base, executed: moved.length > 0, mode, matched: items.length, moved, status: 'partial', remaining, as_of: asOf, deindexed: deindexedCount, deindex_incomplete: deindexIncomplete, deindex_resweep_incomplete: deindexResweepIncomplete },
        // Any real moves that happened before the stop must be audited the same as a normal
        // completion -- omitting `audit` here would log a real mutation (copy+delete already ran on
        // `moved.length` blobs) as if nothing happened, since the registry only records before/after
        // when payload.audit is present (2026-08-04, PR #191 review).
        audit: { before: { matched: items.length }, after: { movedToTrash: moved.length } },
        summary: `Stopped at the time budget (${effectiveBudgetMs}ms) after moving ${moved.length}/${items.length}; ${remaining} remaining. Re-run the SAME ${mode === 'single' ? 'path' : 'prefix'} to continue -- already-moved items will not be re-matched.`,
      };
    }
    const trashExists = await blobExists(container, item.to);
    if (trashExists) {
      const remaining = items.length - moved.length;
      return {
        // A mid-batch stop after some items already moved is a PARTIAL execution, not "nothing
        // happened" -- executed reflects whether at least one mutation occurred, not whether the
        // whole batch finished (2026-08-04, PR #190 review). status is ALSO 'partial' here (not the
        // base default 'complete'): this is the same "batch stopped with unprocessed items left"
        // situation as the time-budget stop above, just for a different reason -- `error` already
        // distinguishes why (2026-08-04, PR #191 review: status:'complete' with a positive
        // `remaining` was a self-contradictory response).
        data: { ...base, executed: moved.length > 0, mode, matched: items.length, moved, collisions: [{ from: item.from, to: item.to }], status: 'partial', remaining, as_of: asOf, deindexed: deindexedCount, deindex_incomplete: deindexIncomplete, deindex_resweep_incomplete: deindexResweepIncomplete, error: 'trash_collision' },
        audit: { before: { matched: items.length }, after: { movedToTrash: moved.length } },
        summary: `Stopped after moving ${moved.length}/${items.length}: a blob already exists at the trash destination "${item.to}" (a previous delete of the same path?). Resolve that manually, then re-run for the remaining items.`,
      };
    }
    await copyBlob(container, item.from, item.to, false, item.etag ?? undefined);
    await deleteBlobHard(container, item.from, item.etag ?? undefined);
    moved.push({ from: item.from, to: item.to });
    // Best-effort, fail-open, DEADLINE-BOUNDED: purge the stale search-index entry at the path this
    // blob just moved FROM. Never throws (deindexChunkedPathWithAuth's own contract); a failure
    // here does not undo, block, or even flag the blob move itself, which has already durably
    // happened. The deadline is the EARLIER of a per-item cap and the batch's own remaining budget,
    // so cleanup latency can never itself push a bulk batch over the MCP transport timeout after
    // blobs have already moved (2026-08-04, Copilot review PR #192). Every item is still ATTEMPTED
    // (never silently skipped) -- a `truncated`/unattempted result is recorded in
    // `deindexIncomplete` so the caller can SEE that a path's cleanup was not confirmed, rather
    // than the earlier design where a thin-budget item's stale index entry just silently vanished
    // from the response with no trace.
    if (deindexAuth) {
      const deadline = Math.min(Date.now() + DEINDEX_PER_ITEM_CAP_MS, moveStartedAt + effectiveBudgetMs);
      const deindex = await deindexChunkedPathWithAuth(deindexAuth, searchIndex, item.from, deadline, container);
      deindexedCount += deindex.deleted;
      if (!deindex.attempted || deindex.truncated) deindexIncomplete.push(item.from);
    } else {
      deindexIncomplete.push(item.from);
    }
    // THE PERMANENT FIX (2026-08-04, Copilot review PR #192 round 12 + full residual-limitation
    // closure): enqueue a delayed re-verification regardless of the synchronous result above --
    // even a CONFIRMED-clean synchronous pass can still be resurrected by an independent
    // pull-indexer that read this path before the delete and writes after it returns, a race no
    // synchronous MCP call can close. deindex-resweep.ts's sweep checks whether a blob has been
    // legitimately RECREATED at this path before deleting anything there, so a concurrent
    // legal_blob_put reusing this exact path is safe. AWAITED, bounded (2026-08-04, Copilot review
    // round 16): a bare fire-and-forget call gave no way to know whether the durable backstop
    // actually persisted before this response returns; still fail-open (never throws, never blocks
    // an already-completed move) -- only the timing discipline changed. Not confirmed persisted is
    // tracked per-item, same visibility pattern as `deindexIncomplete` above, rather than silently
    // dropped.
    const resweepQueued = await enqueueDeindexResweepAwaited(searchIndex, item.from, container);
    if (!resweepQueued) deindexResweepIncomplete.push(item.from);
  }

  return {
    data: { ...base, executed: true, dry_run: false, mode, matched: items.length, moved, as_of: asOf, deindexed: deindexedCount, deindex_incomplete: deindexIncomplete, deindex_resweep_incomplete: deindexResweepIncomplete },
    audit: { before: { matched: items.length }, after: { movedToTrash: moved.length } },
    summary:
      deindexIncomplete.length > 0
        ? `Soft-deleted ${moved.length} blob(s) in legal/${container} (moved to _TRASH/, lane=${caller}). Search-index cleanup was NOT confirmed complete for ${deindexIncomplete.length}/${moved.length} of them (see deindex_incomplete) -- those paths may still surface a stale search hit. Recoverable via legal_blob_move back to the original path.`
        : `Soft-deleted ${moved.length} blob(s) in legal/${container} (moved to _TRASH/, lane=${caller}). Recoverable via legal_blob_move back to the original path.`,
  };
}

export function registerLegalBlobDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'legal_blob_delete',
      category: 'write_simple',
      annotations: {
        title: 'Soft-delete a blob (or a prefix of blobs) in the ring-gated legal document store',
        description:
          `SOFT delete only -- moves the blob(s) to _TRASH/<original-path> within the same container, never a real hard delete. Provide exactly one of "path" (single blob) or "prefix" (bulk, bounded by max_items, default ${DEFAULT_MAX_ITEMS}, hard cap ${HARD_MAX_ITEMS} -- if more blobs match the prefix than max_items, the call REFUSES entirely rather than silently deleting a partial set; narrow the prefix or raise max_items and re-run). "confirm" MUST exactly echo path (or prefix) -- a mismatch refuses, by design a wrong-path delete needs two independent mistakes to happen. Refuses outright if path/prefix falls under a protected prefix (LEGAL_PROTECTED_PREFIXES) -- the court-download folder and raw filings stay append-only no matter what. RING-GATED identically to legal_blob_put. Defaults to dry_run: run it once with dry_run true (the default) to see exactly what would move before passing dry_run=false. A large bulk batch is SELF-BOUNDED to a time budget well under the MCP transport timeout: if the batch does not finish in time, the call returns status:"partial" with a "remaining" count instead of risking a client-side timeout on a call that actually completed server-side -- re-invoke with the SAME path/prefix to continue, already-moved items are never re-matched. "as_of" (null when the call refused before ever reading storage) marks when the underlying listing/existence-check was read (Azure's list-blobs enumeration is not guaranteed strongly consistent the way a single-blob read is); treat a non-null plan more than a few seconds old as possibly stale and re-run before trusting it. After each successful move, the stale search-index entry at the blob's ORIGINAL path is also purged (best-effort, deadline-bounded; confirmed count in "deindexed") -- the chunked doc rooms are fed by slow native pull-indexers with no deletion-detection policy, so without this a soft-deleted document keeps appearing in search results under a path that no longer resolves. "deindex_incomplete" lists the original paths where that IMMEDIATE cleanup was NOT confirmed complete (a deadline or a mid-pagination failure). Either way, every moved item's original path is also enqueued into a durable delayed re-verification sweep that runs safely past one full indexer cadence, so a resurrection race against an in-flight indexer run self-heals within hours even when the immediate cleanup could not confirm clean; "deindex_resweep_incomplete" lists paths where that enqueue itself was NOT confirmed persisted (a bounded await, not fire-and-forget) before this call returned.`,
        readOnlyHint: false,
        // Soft delete still REMOVES the blob from its original location (recoverability via
        // _TRASH/ does not make the invocation additive) -- destructiveHint:false understated the
        // risk and could suppress a client's confirmation UX (2026-08-04, PR #190 review).
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: legalBlobDeleteInputShape,
      outputShape: legalBlobDeleteOutputShape,
      handler: handleLegalBlobDelete,
    },
    callerHash,
  );
}
