import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured, blobExists, copyBlob } from '../../legal/blob-store.js';
import { isLegalContainerAllowed, lanesForContainer } from './ring.js';

export const legalBlobCopyInputShape = {
  container: z.enum(['company', 'personal']).describe('Which legal container. personal is ring-gated to the legal-personal executive ring.'),
  src_path: z.string().min(1).describe('Source blob path to copy from.'),
  dst_path: z.string().min(1).describe('Destination blob path.'),
  overwrite: z.boolean().optional().describe('Set true to intentionally replace an existing blob at dst_path. Default false = refuse if it already exists.'),
} satisfies ZodRawShape;

export const legalBlobCopyOutputShape = {
  executed: z.boolean(),
  dry_run: z.boolean(),
  container: z.string(),
  src_path: z.string(),
  dst_path: z.string(),
  bytes: z.number().nullable(),
  error: z.string().optional(),
} satisfies ZodRawShape;

export type LegalBlobCopyInput = z.infer<z.ZodObject<typeof legalBlobCopyInputShape>>;

/**
 * `legal_blob_copy` handler. Exported standalone, mirrors handleLegalBlobMove but never deletes
 * anything -- the original at src_path is always left untouched, so there is deliberately no
 * protected-prefix check here (copying evidence into a new organizational tree is additive, not
 * destructive). Use legal_blob_move (which IS prefix-guarded) when the intent is to relocate.
 */
export async function handleLegalBlobCopy(input: LegalBlobCopyInput, ctx: ToolContext): Promise<ToolResultPayload> {
  const container = input.container;
  const caller = ctx.callerAgent || '';
  const lanes = lanesForContainer(container);
  const base = { executed: false, dry_run: ctx.dryRun, container, src_path: input.src_path, dst_path: input.dst_path, bytes: null as number | null };

  if (!isLegalContainerAllowed(container, caller)) {
    return { data: { ...base, error: 'forbidden_ring' }, summary: `Refused: copying within legal container "${container}" requires one of the ${lanes.join('/')} trusted lanes. Your identity: ${caller || '(none)'}.` };
  }
  if (!isConfigured()) {
    return { data: { ...base, error: 'unconfigured' }, summary: 'Legal store not configured (AZURE_LEGAL_STORAGE_KEY unset).' };
  }
  if (input.src_path === input.dst_path) {
    return { data: { ...base, error: 'invalid_input' }, summary: 'src_path and dst_path are identical; nothing to copy.' };
  }

  const [srcExists, dstExists] = await Promise.all([blobExists(container, input.src_path), blobExists(container, input.dst_path)]);
  if (!srcExists) {
    return { data: { ...base, error: 'src_not_found' }, summary: `Refused: no blob at legal/${container}/${input.src_path}.` };
  }
  const overwrite = input.overwrite === true;
  if (dstExists && !overwrite) {
    return { data: { ...base, error: 'dst_exists_no_overwrite' }, summary: `Refused: a blob already exists at legal/${container}/${input.dst_path}. Pass overwrite=true to intentionally replace it.` };
  }

  if (ctx.dryRun) {
    return {
      data: { ...base, dry_run: true },
      audit: { before: { srcExists, dstExists }, after: { container, src_path: input.src_path, dst_path: input.dst_path } },
      summary: `DRY RUN: would copy legal/${container}/${input.src_path} -> ${input.dst_path}${dstExists ? ' (OVERWRITE)' : ''}. Pass dry_run=false to apply.`,
    };
  }

  const copy = await copyBlob(container, input.src_path, input.dst_path, overwrite);
  return {
    data: { ...base, executed: true, dry_run: false, bytes: copy.bytes },
    audit: { before: { srcExists: true, dstExists }, after: { container, dst_path: input.dst_path, bytes: copy.bytes } },
    summary: `Copied legal/${container}/${input.src_path} -> ${input.dst_path} (${copy.bytes} bytes, lane=${caller}).`,
  };
}

export function registerLegalBlobCopy(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'legal_blob_copy',
      category: 'write_simple',
      annotations: {
        title: 'Copy a blob within the ring-gated legal document store',
        description:
          'Copy a blob from src_path to dst_path within the same container (server-side Azure copy; the original at src_path is left untouched). FAIL-CLOSED: refuses if dst_path already exists unless overwrite=true. No protected-prefix restriction on the source -- copying evidence to organize a new tree is additive, not destructive; use legal_blob_move (which IS prefix-guarded) if the intent is to relocate rather than duplicate. RING-GATED identically to legal_blob_put. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: legalBlobCopyInputShape,
      outputShape: legalBlobCopyOutputShape,
      handler: handleLegalBlobCopy,
    },
    callerHash,
  );
}
