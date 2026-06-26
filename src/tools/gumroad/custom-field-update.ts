import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateCustomField } from '../../gumroad/full-client.js';

export function registerGumroadCustomFieldUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_custom_field_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Gumroad custom field',
      description: 'Update the name or required status of a Gumroad product custom field. Addressed by current field name. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      field_name: z.string().describe('Current name of the custom field (used as identifier).'),
      name: z.string().optional().describe('New name for the field.'),
      required: z.boolean().optional().describe('New required status.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      custom_field: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update custom field "${input.field_name}" on product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await updateCustomField(input.product_id, input.field_name, {
        name: input.name,
        required: input.required,
      });
      return {
        data: { executed: true, dry_run: false, custom_field: resp.custom_field ?? resp },
        audit: { before: null, after: input },
        summary: `Updated custom field "${input.field_name}" on product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
