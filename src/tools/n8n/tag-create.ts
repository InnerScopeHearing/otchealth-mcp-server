import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createTag } from '../../n8n/full-client.js';

export function registerN8nTagCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_tag_create',
    category: 'write_simple',
    annotations: {
      title: 'Create n8n tag',
      description:
        'Create a new workflow tag in n8n. Tags help organize and filter workflows. ' +
        'After creating, use n8n_workflow_tags_update to apply it to workflows. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Tag name to create (should be unique).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      tag_id: z.string().nullable(),
      name: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, tag_id: null, name: input.name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create tag "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createTag(input.name, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, tag_id: upstream?.id ?? null, name: upstream?.name ?? input.name },
        audit: { before: null, after: { tag_id: upstream?.id, name: input.name } },
        summary: `Created tag "${input.name}" (id: ${upstream?.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
