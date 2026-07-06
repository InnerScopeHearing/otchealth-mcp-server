import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, getBlob } from '../../legal/blob-store.js';
import { isLegalContainerAllowed, lanesForContainer } from './ring.js';

export function registerLegalBlobGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'legal_blob_get',
      category: 'read',
      annotations: {
        title: 'Fetch a blob from the ring-gated legal document store',
        description:
          'Fetch a specific blob\'s content by container + path from the legal document store (account otchealthlegalstore). Textual content is returned as text; binary content (or force_base64=true) is returned as base64. RING-GATED identically to legal_blob_list: container=personal requires the legal-personal executive ring; container=company requires the legal-company ring. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        container: z.enum(['company', 'personal']).describe('Which legal container. personal is ring-gated to the legal-personal executive ring.'),
        path: z.string().min(1).describe('Blob path within the container (e.g. "matters/2026-divorce.json" or "filings/petition.pdf").'),
        force_base64: z.boolean().optional().describe('Return the content as base64 even if it looks textual (binary-safe fetch).'),
      },
      outputShape: {
        container: z.string(),
        path: z.string(),
        found: z.boolean(),
        contentType: z.string().nullable(),
        size: z.number().nullable(),
        text: z.string().nullable(),
        base64: z.string().nullable(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const container = input.container;
        const caller = ctx.callerAgent || '';
        const lanes = lanesForContainer(container);
        if (!isLegalContainerAllowed(container, caller)) {
          return {
            data: { container, path: input.path, found: false, contentType: null, size: null, text: null, base64: null, error: 'forbidden_ring' },
            summary: `Refused: legal container "${container}" requires one of the ${lanes.join('/')} trusted lanes. Your identity: ${caller || '(none)'}. Privileged legal data is never served to other lanes or external clients.`,
          };
        }
        if (!isConfigured()) {
          return { data: { container, path: input.path, found: false, contentType: null, size: null, text: null, base64: null, error: 'unconfigured' }, summary: 'Legal store not configured (AZURE_LEGAL_STORAGE_KEY unset).' };
        }
        const res = await getBlob(container, input.path, input.force_base64 === true);
        if (!res.found) {
          return { data: { container, path: input.path, found: false, contentType: null, size: null, text: null, base64: null }, summary: `No blob at legal/${container}/${input.path}.` };
        }
        return {
          data: { container, path: input.path, found: true, contentType: res.contentType, size: res.size, text: res.text, base64: res.base64 },
          summary: `Fetched legal/${container}/${input.path} (${res.size ?? '?'} bytes, ${res.contentType ?? 'unknown type'}, lane=${caller}).`,
        };
      },
    },
    callerHash,
  );
}
