import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCustomField } from '../../gumroad/full-client.js';

export function registerGumroadCustomFieldCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_custom_field_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Gumroad custom field',
      description: 'Add a custom checkout field (e.g. "Company name") to a Gumroad product. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      name: z.string().describe('Name/label for the custom field (e.g. "Company"). This also acts as the field identifier.'),
      required: z.boolean().optional().default(false).describe('Whether this field is required at checkout.'),
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
          summary: `DRY RUN: would create custom field "${input.name}" (required=${input.required}) on product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await createCustomField(input.product_id, {
        name: input.name,
        required: input.required,
      });
      return {
        data: { executed: true, dry_run: false, custom_field: resp.custom_field ?? resp },
        audit: { before: null, after: input },
        summary: `Created custom field "${input.name}" on product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
