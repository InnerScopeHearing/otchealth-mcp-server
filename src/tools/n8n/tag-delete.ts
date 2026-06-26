import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteTag } from '../../n8n/full-client.js';

export function registerN8nTagDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_tag_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete n8n tag',
      description:
        'Permanently delete an n8n tag by ID. The tag is removed from all workflows that reference it. Irreversible. ' +
        'Use n8n_tag_list to find IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      tag_id: z.string().min(1).describe('ID of the tag to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      tag_id: z.string(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, tag_id: input.tag_id, upstream_result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete tag ${input.tag_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteTag(input.tag_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, tag_id: input.tag_id, upstream_result: upstream },
        audit: { before: { tag_id: input.tag_id }, after: null },
        summary: `Deleted tag ${input.tag_id}.`,
      };
    },
  }, callerHash);
}
