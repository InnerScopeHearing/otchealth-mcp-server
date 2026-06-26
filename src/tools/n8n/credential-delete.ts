import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCredential } from '../../n8n/full-client.js';

export function registerN8nCredentialDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_credential_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete n8n credential',
      description:
        'Permanently delete an n8n credential by ID. Any workflows that reference this credential will lose their auth and fail at runtime. Irreversible. ' +
        'Use n8n_credential_list to find credential IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      credential_id: z.string().min(1).describe('ID of the n8n credential to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      credential_id: z.string(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, credential_id: input.credential_id, upstream_result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete credential ${input.credential_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteCredential(input.credential_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, credential_id: input.credential_id, upstream_result: upstream },
        audit: { before: { credential_id: input.credential_id }, after: null },
        summary: `Deleted credential ${input.credential_id}.`,
      };
    },
  }, callerHash);
}
