import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured, headBlob, blobExists, copyBlob, deleteBlobHard } from '../../legal/blob-store.js';
import { isLegalContainerAllowed, lanesForContainer, isProtectedPath, searchIndexForContainer } from './ring.js';
import { deindexChunkedPath, effectiveOneShotDeindexBudgetMs } from '../../azure/search-write.js';

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
  const container = input.container;
  const caller = ctx.callerAgent || '';
  const lanes = lanesForContainer(container);
  const base = { executed: false, dry_run: ctx.dryRun, container, src_path: input.src_path, dst_path: input.dst_path, bytes: null as number | null, deindexed: 0, deindex_truncated: false };

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
  const moveOpsStartedAt = Date.now();
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
  const deindex = await deindexChunkedPath(searchIndexForContainer(container), input.src_path, effectiveOneShotDeindexBudgetMs(moveElapsedMs));
  const deindexTruncated = !deindex.attempted || Boolean(deindex.truncated);

  return {
    data: { ...base, executed: true, dry_run: false, bytes: copy.bytes, deindexed: deindex.deleted, deindex_truncated: deindexTruncated },
    audit: { before: { srcExists: true, dstExists }, after: { container, dst_path: input.dst_path, bytes: copy.bytes } },
    summary: deindexTruncated
      ? `Moved legal/${container}/${input.src_path} -> ${input.dst_path} (${copy.bytes} bytes, lane=${caller}). Search-index cleanup at the old path was NOT confirmed complete -- it may still surface a stale hit.`
      : `Moved legal/${container}/${input.src_path} -> ${input.dst_path} (${copy.bytes} bytes, lane=${caller}).`,
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
          'Move a blob from src_path to dst_path within the same container (copy-then-remove-original; Azure Blob has no native rename). FAIL-CLOSED: refuses if dst_path already exists unless overwrite=true, and refuses outright if src_path falls under a protected prefix (LEGAL_PROTECTED_PREFIXES -- the court-download folder and raw filings stay append-only regardless of caller). The original is removed ONLY after the copy to dst_path is verified to have landed. After a successful move, the stale search-index entry at src_path is also purged (best-effort, deadline-bounded; confirmed count in "deindexed") -- the chunked doc rooms are fed by slow native pull-indexers with no deletion-detection policy, so without this the old path keeps appearing in search results pointing at content that no longer resolves there. "deindex_truncated" is true when that cleanup was NOT confirmed complete -- src_path may still surface a stale hit. Note: even a CONFIRMED clean deindex races an independent, asynchronous pull-indexer -- if a reindex run was already reading src_path when this call ran, it can reappear later; a full fix needs indexer coordination or a recurring sweep, not yet built. RING-GATED identically to legal_blob_put. Defaults to dry_run.',
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
