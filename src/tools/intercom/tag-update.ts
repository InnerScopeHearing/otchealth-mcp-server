import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUpdateTag } from '../../intercom/full-client.js';

export function registerIntercomTagUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_tag_update',
    category: 'write_simple',
    annotations: {
      title: 'Update (rename) an Intercom tag',
      description: 'Rename an existing Intercom tag via POST /tags with id + name. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      tag_id: z.string().describe('Intercom tag ID to rename.'),
      name: z.string().describe('New tag name.'),
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
      const resp = await fcUpdateTag({ tag_id: input.tag_id, name: input.name });
      return {
        data: { executed: true, dry_run: false, tag_id: resp.id ?? input.tag_id, name: resp.name ?? input.name },
        audit: { before: null, after: input },
        summary: `Tag ${input.tag_id} renamed to "${input.name}".`,
      };
    },
  }, callerHash);
}
