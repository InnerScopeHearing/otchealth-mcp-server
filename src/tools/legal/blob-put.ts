import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import {
  registerTool,
  type CallerHashProvider,
  type ToolContext,
  type ToolResultPayload,
} from '../registry.js';
import { isConfigured, blobExists, putBlob } from '../../legal/blob-store.js';
import { isLegalContainerAllowed, lanesForContainer } from './ring.js';

export const legalBlobPutInputShape = {
  container: z.enum(['company', 'personal']).describe(
    'Which legal container. personal is ring-gated to the legal-personal executive ring.',
  ),
  path: z.string().min(1).describe(
    'Destination blob path within the container (e.g. "filings/2026/petition.pdf").',
  ),
  text: z.string().optional().describe('Text content to upload (mutually exclusive with base64).'),
  base64: z.string().optional().describe(
    'Base64-encoded binary content to upload (mutually exclusive with text). The deprecated content_base64 name is not accepted.',
  ),
  content_type: z.string().optional().describe(
    'Content-Type to store (default application/json for text, application/octet-stream for base64).',
  ),
  overwrite: z.boolean().optional().describe(
    'Set true to intentionally replace an existing blob. Default false = REFUSE if the path already exists.',
  ),
} satisfies ZodRawShape;

export const legalBlobPutOutputShape = {
  executed: z.boolean(),
  dry_run: z.boolean(),
  container: z.string(),
  path: z.string(),
  bytes: z.number().nullable(),
  overwrote: z.boolean(),
  error: z.string().optional(),
} satisfies ZodRawShape;

export type LegalBlobPutInput = z.infer<z.ZodObject<typeof legalBlobPutInputShape>>;

/** Exported standalone so dry-run/live semantics and the base64 contract are directly testable. */
export async function handleLegalBlobPut(
  input: LegalBlobPutInput,
  ctx: ToolContext,
): Promise<ToolResultPayload> {
  const container = input.container;
  const caller = ctx.callerAgent || '';
  const lanes = lanesForContainer(container);
  const base = {
    executed: false,
    dry_run: ctx.dryRun,
    container,
    path: input.path,
    bytes: null as number | null,
    overwrote: false,
  };

  if (!isLegalContainerAllowed(container, caller)) {
    return {
      data: { ...base, error: 'forbidden_ring' },
      summary: `Refused: writing to legal container "${container}" requires one of the ${lanes.join('/')} trusted lanes. Your identity: ${caller || '(none)'}.`,
    };
  }
  if (input.text != null && input.base64 != null) {
    return {
      data: { ...base, error: 'invalid_input' },
      summary: 'Provide exactly one of text or base64, not both.',
    };
  }
  if (input.text == null && input.base64 == null) {
    return {
      data: { ...base, error: 'invalid_input' },
      summary: 'Provide content via text or base64. The deprecated content_base64 field is not accepted.',
    };
  }
  if (!isConfigured()) {
    return {
      data: { ...base, error: 'unconfigured' },
      summary: 'Legal store not configured (AZURE_LEGAL_STORAGE_KEY unset).',
    };
  }
  const overwrite = input.overwrite === true;
  const exists = await blobExists(container, input.path);
  if (exists && !overwrite) {
    return {
      data: { ...base, error: 'exists_no_overwrite' },
      summary: `Refused: a blob already exists at legal/${container}/${input.path}. Pass overwrite=true to intentionally replace it.`,
    };
  }

  if (ctx.dryRun) {
    return {
      data: { ...base, dry_run: true, overwrote: exists && overwrite },
      audit: { before: exists ? { existed: true } : null, after: { container, path: input.path, overwrite } },
      summary: `DRY RUN: would ${exists ? 'OVERWRITE' : 'create'} legal/${container}/${input.path}. Pass dry_run=false to apply.`,
    };
  }

  const put = await putBlob(
    container,
    input.path,
    { text: input.text, base64: input.base64, contentType: input.content_type },
    overwrite,
  );
  return {
    data: {
      ...base,
      executed: true,
      dry_run: false,
      bytes: put.bytes,
      overwrote: exists && overwrite,
    },
    audit: { before: exists ? { existed: true } : null, after: { container, path: put.path, bytes: put.bytes } },
    summary: `${exists ? 'Overwrote' : 'Uploaded'} legal/${container}/${input.path} (${put.bytes} bytes, lane=${caller}).`,
  };
}

export function registerLegalBlobPut(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'legal_blob_put',
      // write_simple: a single-object upload. Ring-gated to the SAME lanes as the read tools for the
      // container (personal -> legal-personal ring; company -> legal-company ring) — a write is at
      // least as sensitive as a read of the same corpus, so it is never more broadly reachable.
      category: 'write_simple',
      annotations: {
        title: 'Upload a blob to the ring-gated legal document store (fail-closed, no silent overwrite)',
        description:
          'Upload a new blob to the legal document store (account otchealthlegalstore). Provide text OR base64 content; the deprecated content_base64 field is not accepted. FAIL-CLOSED SAFETY DEFAULT: if a blob already exists at the exact path, the upload is REFUSED; pass overwrite=true to intentionally replace it. RING-GATED identically to the legal read tools. Defaults to dry_run; pass dry_run=false explicitly to upload.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: legalBlobPutInputShape,
      outputShape: legalBlobPutOutputShape,
      handler: handleLegalBlobPut,
    },
    callerHash,
  );
}
