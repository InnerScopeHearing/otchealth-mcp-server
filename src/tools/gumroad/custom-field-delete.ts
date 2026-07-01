import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCustomField } from '../../gumroad/full-client.js';

export function registerGumroadCustomFieldDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_custom_field_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Gumroad custom field',
      description: 'Permanently remove a custom checkout field from a Gumroad product. Addressed by field name. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      field_name: z.string().describe('Name (identifier) of the custom field to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      success: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete custom field "${input.field_name}" from product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await deleteCustomField(input.product_id, input.field_name);
      return {
        data: { executed: true, dry_run: false, success: resp.success },
        audit: { before: null, after: input },
        summary: `Deleted custom field "${input.field_name}" from product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
