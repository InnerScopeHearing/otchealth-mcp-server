import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcCreateTag } from '../../intercom/full-client.js';

export function registerIntercomTagCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_tag_create',
    category: 'write_simple',
    annotations: {
      title: 'Create an Intercom tag',
      description: 'Create a new tag in Intercom via POST /tags. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().describe('Tag name (must be unique within the workspace).'),
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
      const resp = await fcCreateTag({ name: input.name });
      return {
        data: { executed: true, dry_run: false, tag_id: resp.id ?? null, name: resp.name ?? input.name },
        audit: { before: null, after: input },
        summary: `Tag "${resp.name ?? input.name}" created (id: ${resp.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
