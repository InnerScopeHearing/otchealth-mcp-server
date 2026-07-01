import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcCreateDataAttribute } from '../../intercom/full-client.js';

export function registerIntercomDataAttributeCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_data_attribute_create',
    category: 'write_simple',
    annotations: {
      title: 'Create an Intercom custom data attribute',
      description: 'Create a new custom data attribute for contacts or companies via POST /data_attributes. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().describe('Attribute name (snake_case recommended).'),
      model: z.enum(['contact', 'company']).describe('Which model this attribute applies to.'),
      data_type: z.enum(['string', 'integer', 'float', 'boolean', 'date', 'list']).describe('Data type of the attribute.'),
      description: z.string().optional().describe('Human-readable description.'),
      options: z.array(z.object({ value: z.string() })).optional().describe('Allowed values for list-type attributes.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      attribute_id: z.number().nullable(),
      name: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, attribute_id: null, name: input.name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create ${input.model} data attribute "${input.name}" (${input.data_type}). Pass dry_run=false to apply.`,
        };
      }
      const resp = await fcCreateDataAttribute(input);
      return {
        data: { executed: true, dry_run: false, attribute_id: resp.id ?? null, name: resp.name ?? input.name },
        audit: { before: null, after: input },
        summary: `Data attribute "${resp.name ?? input.name}" created (id: ${resp.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
