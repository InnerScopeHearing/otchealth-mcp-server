import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUpdateDataAttribute } from '../../intercom/full-client.js';

export function registerIntercomDataAttributeUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_data_attribute_update',
    category: 'write_simple',
    annotations: {
      title: 'Update an Intercom custom data attribute',
      description: 'Update description, options, or archived status of a custom data attribute via PUT /data_attributes/:id. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      attribute_id: z.number().int().describe('Intercom data attribute ID (numeric).'),
      description: z.string().optional().describe('New description.'),
      options: z.array(z.object({ value: z.string() })).optional().describe('Updated list of allowed values.'),
      archived: z.boolean().optional().describe('Set to true to archive (soft-delete) this attribute.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      attribute_id: z.number(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, attribute_id: input.attribute_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update data attribute ${input.attribute_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcUpdateDataAttribute(input);
      return {
        data: { executed: true, dry_run: false, attribute_id: input.attribute_id },
        audit: { before: null, after: input },
        summary: `Data attribute ${input.attribute_id} updated.`,
      };
    },
  }, callerHash);
}
