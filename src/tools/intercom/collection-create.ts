import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcCreateCollection } from '../../intercom/full-client.js';

export function registerIntercomCollectionCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_collection_create',
    category: 'write_simple',
    annotations: {
      title: 'Create an Intercom help center collection',
      description: 'Create a new help center collection (top-level category) via POST /help_center/collections. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().describe('Collection name (displayed in the help center).'),
      description: z.string().optional().describe('Collection description.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      collection_id: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, collection_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create collection "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      const resp = await fcCreateCollection({ name: input.name, description: input.description });
      return {
        data: { executed: true, dry_run: false, collection_id: resp.id ?? null },
        audit: { before: null, after: input },
        summary: `Collection created (id: ${resp.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
