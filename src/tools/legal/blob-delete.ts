import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured, blobExists, copyBlob, deleteBlobHard, listBlobs } from '../../legal/blob-store.js';
import { isLegalContainerAllowed, lanesForContainer, isProtectedPath } from './ring.js';

export const DEFAULT_MAX_ITEMS = 100;
export const HARD_MAX_ITEMS = 500;

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
export async function handleLegalBlobDelete(input: LegalBlobDeleteInput, ctx: ToolContext): Promise<ToolResultPayload> {
  const container = input.container;
  const caller = ctx.callerAgent || '';
  const lanes = lanesForContainer(container);
  const base = { executed: false, dry_run: ctx.dryRun, container, mode: null as 'single' | 'prefix' | null, matched: 0, moved: [] as Array<{ from: string; to: string }> };

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

  // Resolve the exact set of (path -> trash path) pairs this call would act on.
  let items: Array<{ from: string; to: string }>;
  if (mode === 'single') {
    const path = input.path as string;
    const exists = await blobExists(container, path);
    if (!exists) {
      return { data: { ...base, mode, error: 'not_found' }, summary: `Refused: no blob at legal/${container}/${path}.` };
    }
    items = [{ from: path, to: trashPathFor(path) }];
  } else {
    const prefix = input.prefix as string;
    const maxItems = input.max_items ?? DEFAULT_MAX_ITEMS;
    const found = await listBlobs(container, prefix);
    // Never touch anything already in _TRASH/ via a prefix sweep -- a broad top-level prefix could
    // otherwise re-trash an already-trashed item.
    const candidates = found.filter((b) => !b.name.startsWith('_TRASH/'));
    if (candidates.length > maxItems) {
      return {
        data: { ...base, mode, matched: candidates.length, error: 'too_many_matches' },
        summary: `Refused: ${candidates.length} blob(s) match prefix "${prefix}", which exceeds max_items=${maxItems}. Narrow the prefix or raise max_items (hard cap ${HARD_MAX_ITEMS}) and re-run. Nothing was touched.`,
      };
    }
    if (candidates.length === 0) {
      return { data: { ...base, mode, matched: 0 }, summary: `No blobs matched prefix "${prefix}" (outside _TRASH/). Nothing to do.` };
    }
    items = candidates.map((b) => ({ from: b.name, to: trashPathFor(b.name) }));
  }

  if (ctx.dryRun) {
    return {
      data: { ...base, dry_run: true, mode, matched: items.length, moved: items },
      audit: { before: { matched: items.length }, after: null },
      summary: `DRY RUN: would soft-delete ${items.length} blob(s) in legal/${container} (move to _TRASH/). Pass dry_run=false to apply.`,
    };
  }

  // Execute one at a time, sequentially -- these are legal documents, not a place for
  // concurrent-write surprises, and a partial failure should stop with a clear accounting of what
  // DID move rather than racing ahead.
  const moved: Array<{ from: string; to: string }> = [];
  for (const item of items) {
    const trashExists = await blobExists(container, item.to);
    if (trashExists) {
      return {
        data: { ...base, mode, matched: items.length, moved, error: 'trash_collision' },
        summary: `Stopped after moving ${moved.length}/${items.length}: a blob already exists at the trash destination "${item.to}" (a previous delete of the same path?). Resolve that manually, then re-run for the remaining items.`,
      };
    }
    await copyBlob(container, item.from, item.to, false);
    await deleteBlobHard(container, item.from);
    moved.push(item);
  }

  return {
    data: { ...base, executed: true, dry_run: false, mode, matched: items.length, moved },
    audit: { before: { matched: items.length }, after: { movedToTrash: moved.length } },
    summary: `Soft-deleted ${moved.length} blob(s) in legal/${container} (moved to _TRASH/, lane=${caller}). Recoverable via legal_blob_move back to the original path.`,
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
          `SOFT delete only -- moves the blob(s) to _TRASH/<original-path> within the same container, never a real hard delete. Provide exactly one of "path" (single blob) or "prefix" (bulk, bounded by max_items, default ${DEFAULT_MAX_ITEMS}, hard cap ${HARD_MAX_ITEMS} -- if more blobs match the prefix than max_items, the call REFUSES entirely rather than silently deleting a partial set; narrow the prefix or raise max_items and re-run). "confirm" MUST exactly echo path (or prefix) -- a mismatch refuses, by design a wrong-path delete needs two independent mistakes to happen. Refuses outright if path/prefix falls under a protected prefix (LEGAL_PROTECTED_PREFIXES) -- the court-download folder and raw filings stay append-only no matter what. RING-GATED identically to legal_blob_put. Defaults to dry_run: run it once with dry_run true (the default) to see exactly what would move before passing dry_run=false.`,
        readOnlyHint: false,
        destructiveHint: false, // soft delete: nothing is destroyed, everything lands in _TRASH/
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
