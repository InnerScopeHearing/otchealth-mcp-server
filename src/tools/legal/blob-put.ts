import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, blobExists, putBlob } from '../../legal/blob-store.js';
import { isLegalContainerAllowed, lanesForContainer } from './ring.js';

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
          'Upload a new blob to the legal document store (account otchealthlegalstore). Provide text OR base64 content. FAIL-CLOSED SAFETY DEFAULT: if a blob already exists at the exact path, the upload is REFUSED (a filed court document is never silently clobbered); pass overwrite=true to intentionally replace it. RING-GATED identically to the legal read tools: container=personal requires the legal-personal executive ring; container=company requires the legal-company ring. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: {
        container: z.enum(['company', 'personal']).describe('Which legal container. personal is ring-gated to the legal-personal executive ring.'),
        path: z.string().min(1).describe('Destination blob path within the container (e.g. "filings/2026/petition.pdf").'),
        text: z.string().optional().describe('Text content to upload (mutually exclusive with base64).'),
        base64: z.string().optional().describe('Base64-encoded binary content to upload (mutually exclusive with text).'),
        content_type: z.string().optional().describe('Content-Type to store (default application/json for text, application/octet-stream for base64).'),
        overwrite: z.boolean().optional().describe('Set true to intentionally replace an existing blob. Default false = REFUSE if the path already exists (never silently clobber a filed document).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        container: z.string(),
        path: z.string(),
        bytes: z.number().nullable(),
        overwrote: z.boolean(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const container = input.container;
        const caller = ctx.callerAgent || '';
        const lanes = lanesForContainer(container);
        // RING ENFORCEMENT first — before any store touch or dry-run plan is surfaced.
        if (!isLegalContainerAllowed(container, caller)) {
          return {
            data: { executed: false, dry_run: ctx.dryRun, container, path: input.path, bytes: null, overwrote: false, error: 'forbidden_ring' },
            summary: `Refused: writing to legal container "${container}" requires one of the ${lanes.join('/')} trusted lanes. Your identity: ${caller || '(none)'}.`,
          };
        }
        if (input.text != null && input.base64 != null) {
          return {
            data: { executed: false, dry_run: ctx.dryRun, container, path: input.path, bytes: null, overwrote: false, error: 'invalid_input' },
            summary: 'Provide exactly one of text or base64, not both.',
          };
        }
        if (input.text == null && input.base64 == null) {
          return {
            data: { executed: false, dry_run: ctx.dryRun, container, path: input.path, bytes: null, overwrote: false, error: 'invalid_input' },
            summary: 'Provide content via text or base64.',
          };
        }
        if (!isConfigured()) {
          return { data: { executed: false, dry_run: ctx.dryRun, container, path: input.path, bytes: null, overwrote: false, error: 'unconfigured' }, summary: 'Legal store not configured (AZURE_LEGAL_STORAGE_KEY unset).' };
        }
        const overwrite = input.overwrite === true;

        // FAIL-CLOSED: refuse when a blob already exists and overwrite was not explicitly requested.
        // Checked in both dry-run and live paths so the caller learns the refusal before executing.
        const exists = await blobExists(container, input.path);
        if (exists && !overwrite) {
          return {
            data: { executed: false, dry_run: ctx.dryRun, container, path: input.path, bytes: null, overwrote: false, error: 'exists_no_overwrite' },
            summary: `Refused: a blob already exists at legal/${container}/${input.path}. Pass overwrite=true to intentionally replace it (never silently clobber a filed court document).`,
          };
        }

        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, container, path: input.path, bytes: null, overwrote: exists && overwrite },
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
          data: { executed: true, dry_run: false, container, path: input.path, bytes: put.bytes, overwrote: exists && overwrite },
          audit: { before: exists ? { existed: true } : null, after: { container, path: put.path, bytes: put.bytes } },
          summary: `${exists ? 'Overwrote' : 'Uploaded'} legal/${container}/${input.path} (${put.bytes} bytes, lane=${caller}).`,
        };
      },
    },
    callerHash,
  );
}
