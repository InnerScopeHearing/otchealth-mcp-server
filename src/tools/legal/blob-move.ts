import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured, headBlob, blobExists, copyBlob, deleteBlobHard } from '../../legal/blob-store.js';
import { isLegalContainerAllowed, lanesForContainer, isProtectedPath, searchIndexForContainer } from './ring.js';
import { deindexChunkedPath, effectiveOneShotDeindexBudgetMs } from '../../azure/search-write.js';
import { enqueueDeindexResweepAwaited } from '../../agentstate/deindex-resweep.js';

export const legalBlobMoveInputShape = {
  container: z.enum(['company', 'personal']).describe('Which legal container. personal is ring-gated to the legal-personal executive ring.'),
  src_path: z.string().min(1).describe('Source blob path to move.'),
  dst_path: z.string().min(1).describe('Destination blob path.'),
  overwrite: z.boolean().optional().describe('Set true to intentionally replace an existing blob at dst_path. Default false = refuse if it already exists.'),
} satisfies ZodRawShape;

export const legalBlobMoveOutputShape = {
  executed: z.boolean(),
  dry_run: z.boolean(),
  container: z.string(),
  src_path: z.string(),
  dst_path: z.string(),
  bytes: z.number().nullable(),
  /** Chunk documents removed from the search index at src_path after a successful move (2026-08-04,
   *  CLO field report Finding 3): the chunked doc rooms are fed by slow native pull-indexers with no
   *  deletion-detection policy, so without this a moved blob's OLD path stays indexed indefinitely,
   *  pointing at content that no longer resolves there. Best-effort/fail-open, deadline-bounded; 0
   *  on dry_run. */
  deindexed: z.number(),
  /** True when cleanup of src_path's search entry was NOT confirmed complete (search unconfigured,
   *  the overall deindex deadline was hit, or a mid-pagination failure) -- src_path may still
   *  surface a stale search hit (2026-08-04, Copilot review PR #192 round 2). Always false on
   *  dry_run. */
  deindex_truncated: z.boolean(),
  /** True only once the durable delayed re-verification enqueue (see deindex-resweep.ts) is
   *  CONFIRMED persisted to Cosmos, not merely "was attempted" (2026-08-04, Copilot review round
   *  16: the earlier fire-and-forget `void enqueueDeindexResweep(...)` call gave callers no way to
   *  know whether the durable backstop this tool's description promises actually landed before the
   *  response returned). False on dry_run, when Cosmos is unconfigured, or when the bounded await
   *  timed out / the write failed -- `deindex_truncated:true` alongside `deindex_resweep_queued:
   *  false` means BOTH the immediate and the delayed cleanup mechanisms are currently unconfirmed
   *  for this path, worth surfacing distinctly from the common case. */
  deindex_resweep_queued: z.boolean(),
  error: z.string().optional(),
} satisfies ZodRawShape;

export type LegalBlobMoveInput = z.infer<z.ZodObject<typeof legalBlobMoveInputShape>>;

/**
 * `legal_blob_move` handler. Exported standalone (mirrors graph-drive/upload.ts's pattern) so it
 * is directly unit-testable without standing up the full registerTool gating stack.
 *
 * SAFETY ORDERING (2026-08-04, CLO brief §1): ring check -> protected-prefix check on src_path ->
 * existence checks -> dry_run short-circuit -> copy to dst_path -> ONLY THEN delete src_path. Azure
 * Blob has no native rename/move; this is copy-then-remove-original, and the remove step never
 * runs unless copyBlob resolved successfully (it throws on any failure, including an async copy
 * that never reaches copyStatus=success) -- a failed copy always leaves the original intact.
 */
export async function handleLegalBlobMove(input: LegalBlobMoveInput, ctx: ToolContext): Promise<ToolResultPayload> {
  // Captured at the very top, before ANY I/O (2026-08-04, Copilot review PR #192 round 10): this
  // clock feeds effectiveOneShotDeindexBudgetMs below, and it must reflect the WHOLE handler's
  // elapsed time, not just the copy+delete steps. The earlier placement (right before copyBlob)
  // excluded the src/dst preflight (headBlob + blobExists, an unbounded Promise.all) -- if THAT
  // preflight ran long, moveElapsedMs would still look small and grant deindex the full budget,
  // right when the least transport-timeout margin actually remained.
  const moveOpsStartedAt = Date.now();
  const container = input.container;
  const caller = ctx.callerAgent || '';
  const lanes = lanesForContainer(container);
  const base = { executed: false, dry_run: ctx.dryRun, container, src_path: input.src_path, dst_path: input.dst_path, bytes: null as number | null, deindexed: 0, deindex_truncated: false, deindex_resweep_queued: false };

  if (!isLegalContainerAllowed(container, caller)) {
    return { data: { ...base, error: 'forbidden_ring' }, summary: `Refused: moving within legal container "${container}" requires one of the ${lanes.join('/')} trusted lanes. Your identity: ${caller || '(none)'}.` };
  }
  if (isProtectedPath(input.src_path)) {
    return { data: { ...base, error: 'protected_prefix' }, summary: `Refused: src_path "${input.src_path}" falls under a protected prefix and cannot be moved (evidence stays append-only). legal_blob_copy is still fine; move/delete is not.` };
  }
  if (!isConfigured()) {
    return { data: { ...base, error: 'unconfigured' }, summary: 'Legal store not configured (AZURE_LEGAL_STORAGE_KEY unset).' };
  }
  if (input.src_path === input.dst_path) {
    return { data: { ...base, error: 'invalid_input' }, summary: 'src_path and dst_path are identical; nothing to move.' };
  }

  const [src, dstExists] = await Promise.all([headBlob(container, input.src_path), blobExists(container, input.dst_path)]);
  if (!src.exists) {
    return { data: { ...base, error: 'src_not_found' }, summary: `Refused: no blob at legal/${container}/${input.src_path}.` };
  }
  const overwrite = input.overwrite === true;
  if (dstExists && !overwrite) {
    return { data: { ...base, error: 'dst_exists_no_overwrite' }, summary: `Refused: a blob already exists at legal/${container}/${input.dst_path}. Pass overwrite=true to intentionally replace it.` };
  }

  if (ctx.dryRun) {
    return {
      data: { ...base, dry_run: true },
      audit: { before: { srcExists: src.exists, dstExists }, after: { container, src_path: input.src_path, dst_path: input.dst_path } },
      summary: `DRY RUN: would move legal/${container}/${input.src_path} -> ${input.dst_path}${dstExists ? ' (OVERWRITE)' : ''}. Pass dry_run=false to apply.`,
    };
  }

  // src.etag pins BOTH the copy (x-ms-source-if-match) and the delete (If-Match) to the exact
  // version just observed above, so a concurrent overwrite of the source between this HEAD and the
  // delete fails the move closed instead of deleting a version that was never actually copied
  // (2026-08-04, PR #190 review).
  const copy = await copyBlob(container, input.src_path, input.dst_path, overwrite, src.etag ?? undefined);
  await deleteBlobHard(container, input.src_path, src.etag ?? undefined);

  // Best-effort, fail-open, deadline-bounded (see deindexChunkedPath's own doc comment): purge the
  // stale search-index entry at src_path now that the blob no longer lives there (2026-08-04, CLO
  // field report Finding 3 -- same stale-path failure mode as legal_blob_delete, since move is
  // copy-then-remove-original too). Never throws; a failure here does not undo, block, or flag the
  // move itself, which has already durably happened.
  //
  // The deindex budget SHRINKS by however long the move steps above already took (2026-08-04,
  // Copilot review PR #192 round 9): headBlob/copyBlob/deleteBlobHard have no overall deadline of
  // their own (copyBlob alone can poll up to ~20s), so always giving deindex its full flat 10s cap
  // on top could erode the margin under the 60s MCP transport timeout on a slow move. See
  // effectiveOneShotDeindexBudgetMs's own doc comment for the full rationale.
  const moveElapsedMs = Date.now() - moveOpsStartedAt;
  const searchIndex = searchIndexForContainer(container);
  const deindex = await deindexChunkedPath(searchIndex, input.src_path, effectiveOneShotDeindexBudgetMs(moveElapsedMs), container);
  const deindexTruncated = !deindex.attempted || Boolean(deindex.truncated);

  // THE PERMANENT FIX (2026-08-04, Copilot review PR #192 round 12 + full residual-limitation
  // closure): enqueue src_path for delayed re-verification regardless of the synchronous result
  // above -- even a CONFIRMED-clean synchronous pass can still be resurrected by an independent
  // pull-indexer that read this path before the move and writes after it returns, a race no
  // synchronous MCP call can close. deindex-resweep.ts's sweep checks whether a blob has been
  // legitimately RECREATED at src_path before deleting anything there, so a concurrent
  // legal_blob_put reusing this exact path is safe. AWAITED, bounded (2026-08-04, Copilot review
  // round 16): a bare fire-and-forget call gave no way to know whether the durable backstop
  // actually persisted before this response returns; still fail-open (never throws, never blocks
  // the already-completed move) -- only the timing discipline changed.
  const resweepQueued = await enqueueDeindexResweepAwaited(searchIndex, input.src_path, container);
  // dst_path is DELIBERATELY NOT enqueued here (2026-08-04, Copilot review, corrected after an
  // earlier version of this fix got it wrong): on an overwrite move, dst_path is EXPECTED to
  // exist -- the new content lives there -- so the resweep's existence-check guard (the mechanism
  // that makes src_path's enqueue safe) can never fire for it, and a path-only delete would
  // eventually remove the NEW content's own valid chunks alongside any orphaned old ones from the
  // overwritten blob. Cleaning dst_path's orphaned excess chunks on an overwrite remains a
  // genuinely open, tracked follow-up (needs a chunk-schema generation/ETag marker so cleanup can
  // target only the PRIOR blob version's chunks) -- see search-write.ts's module doc comment. Do
  // not re-add a dst_path enqueue here without that generation-aware targeting.

  return {
    data: { ...base, executed: true, dry_run: false, bytes: copy.bytes, deindexed: deindex.deleted, deindex_truncated: deindexTruncated, deindex_resweep_queued: resweepQueued },
    audit: { before: { srcExists: true, dstExists }, after: { container, dst_path: input.dst_path, bytes: copy.bytes } },
    summary: (() => {
      // 2026-08-04, Copilot review round 19: the resweep-not-confirmed caveat must appear
      // regardless of deindexTruncated -- the ORIGINAL version only surfaced it as a suffix on the
      // deindexTruncated branch, so an immediate cleanup that succeeded (deindexTruncated:false)
      // but whose durable enqueue failed (resweepQueued:false) fell through to an unqualified
      // success summary, silently hiding the remaining indexer-resurrection risk that
      // deindex_resweep_queued:false was specifically added to expose.
      const base_ = `Moved legal/${container}/${input.src_path} -> ${input.dst_path} (${copy.bytes} bytes, lane=${caller}).`;
      const immediate = deindexTruncated ? ' Search-index cleanup at the old path was NOT confirmed complete -- it may still surface a stale hit.' : '';
      const durable = resweepQueued ? '' : deindexTruncated
        ? ' The delayed re-verification enqueue was also not confirmed persisted.'
        : ' The delayed re-verification enqueue was NOT confirmed persisted -- an indexer resurrection at the old path would have no backstop.';
      return base_ + immediate + durable;
    })(),
  };
}

export function registerLegalBlobMove(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'legal_blob_move',
      category: 'write_simple',
      annotations: {
        title: 'Move (rename/relocate) a blob within the ring-gated legal document store',
        description:
          'Move a blob from src_path to dst_path within the same container (copy-then-remove-original; Azure Blob has no native rename). FAIL-CLOSED: refuses if dst_path already exists unless overwrite=true, and refuses outright if src_path falls under a protected prefix (LEGAL_PROTECTED_PREFIXES -- the court-download folder and raw filings stay append-only regardless of caller). The original is removed ONLY after the copy to dst_path is verified to have landed. After a successful move, the stale search-index entry at src_path is also purged immediately (best-effort, deadline-bounded; confirmed count in "deindexed") -- the chunked doc rooms are fed by slow native pull-indexers with no deletion-detection policy, so without this the old path keeps appearing in search results pointing at content that no longer resolves there. "deindex_truncated" is true when that IMMEDIATE cleanup at src_path was not confirmed complete. Only src_path (never dst_path) is also enqueued into a durable delayed re-verification sweep that runs safely past one full indexer cadence, so a resurrection race against an in-flight indexer run self-heals within hours even when the immediate cleanup could not confirm clean; "deindex_resweep_queued" is true only once that enqueue is CONFIRMED persisted (a bounded await, not fire-and-forget), false if it timed out or Cosmos is unconfigured. On an overwrite move, dst_path\'s own pre-existing (now-replaced) search chunks are NOT cleaned up by anything in this tool -- a path-only sweep there cannot distinguish the new content\'s own valid chunks from any orphaned excess of the prior blob at that path, so that narrower overwrite-cleanup case remains a tracked, undelivered follow-up (see search-write.ts). RING-GATED identically to legal_blob_put. Defaults to dry_run.',
        readOnlyHint: false,
        // A move removes src_path (and can overwrite dst_path) -- destructiveHint:false ("additive
        // only" under MCP annotation semantics) misdescribed this operation (2026-08-04, PR #190 review).
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: legalBlobMoveInputShape,
      outputShape: legalBlobMoveOutputShape,
      handler: handleLegalBlobMove,
    },
    callerHash,
  );
}
