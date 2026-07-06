import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, listBlobs } from '../../legal/blob-store.js';
import { isLegalContainerAllowed, lanesForContainer } from './ring.js';

export function registerLegalBlobList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'legal_blob_list',
      category: 'read',
      annotations: {
        title: 'List blobs in the ring-gated legal document store',
        description:
          'List blobs in the legal document store (Azure account otchealthlegalstore), container company or personal, under an optional path prefix. RING-GATED: container=personal (attorney-privileged CA divorce/civil matters — the most sensitive corpus in the fleet) requires the same executive ring as the legal-personal search index; container=company requires the legal-company ring. The broad cto/default/external connector identity is refused. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        container: z.enum(['company', 'personal']).describe('Which legal container to list. personal is ring-gated to the legal-personal executive ring.'),
        prefix: z.string().optional().describe('Optional path prefix to filter blobs (e.g. "matters/" or "filings/2026/").'),
      },
      outputShape: {
        container: z.string(),
        prefix: z.string().nullable(),
        blobs: z.array(
          z.object({
            name: z.string(),
            size: z.number().nullable(),
            lastModified: z.string().nullable(),
            contentType: z.string().nullable(),
          }),
        ),
        count: z.number(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const container = input.container;
        const caller = ctx.callerAgent || '';
        const lanes = lanesForContainer(container);
        // RING ENFORCEMENT: caller must hold one of the container's ring lanes; cto/default/external refused.
        if (!isLegalContainerAllowed(container, caller)) {
          return {
            data: { container, prefix: input.prefix ?? null, blobs: [], count: 0, error: 'forbidden_ring' },
            summary: `Refused: legal container "${container}" requires one of the ${lanes.join('/')} trusted lanes. Your identity: ${caller || '(none)'}. Privileged legal data is never served to other lanes or external clients.`,
          };
        }
        if (!isConfigured()) {
          return { data: { container, prefix: input.prefix ?? null, blobs: [], count: 0, error: 'unconfigured' }, summary: 'Legal store not configured (AZURE_LEGAL_STORAGE_KEY unset).' };
        }
        const blobs = await listBlobs(container, input.prefix);
        return {
          data: { container, prefix: input.prefix ?? null, blobs, count: blobs.length },
          summary: `${blobs.length} blob(s) in legal/${container}${input.prefix ? `/${input.prefix}` : ''} (lane=${caller}).`,
        };
      },
    },
    callerHash,
  );
}
