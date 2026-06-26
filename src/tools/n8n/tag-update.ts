import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateTag } from '../../n8n/full-client.js';

export function registerN8nTagUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_tag_update',
    category: 'write_simple',
    annotations: {
      title: 'Update n8n tag name',
      description:
        'Rename an existing n8n tag by its ID. All workflows that already carry this tag are unaffected (the tag ID stays the same). ' +
        'Use n8n_tag_list to find tag IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      tag_id: z.string().min(1).describe('ID of the tag to rename.'),
      name: z.string().min(1).describe('New tag name.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      tag_id: z.string(),
      name: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, tag_id: input.tag_id, name: input.name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would rename tag ${input.tag_id} to "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateTag(input.tag_id, input.name, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, tag_id: input.tag_id, name: upstream?.name ?? input.name },
        audit: { before: null, after: { tag_id: input.tag_id, name: input.name } },
        summary: `Renamed tag ${input.tag_id} to "${input.name}".`,
      };
    },
  }, callerHash);
}
