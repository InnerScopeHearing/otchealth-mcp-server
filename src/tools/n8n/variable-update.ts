import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateVariable } from '../../n8n/full-client.js';

export function registerN8nVariableUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_variable_update',
    category: 'write_simple',
    annotations: {
      title: 'Update n8n variable',
      description:
        'Update the key and/or value of an existing n8n instance variable. Use n8n_variable_list to find variable IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      variable_id: z.string().min(1).describe('ID of the variable to update (from n8n_variable_list).'),
      key: z.string().min(1).describe('New key name for the variable.'),
      value: z.string().describe('New value for the variable.'),
      type: z
        .enum(['string', 'number', 'boolean', 'object'])
        .optional()
        .describe('Updated type hint.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      variable_id: z.string(),
      key: z.string(),
      value: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, variable_id: input.variable_id, key: input.key, value: input.value },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update variable ${input.variable_id} to key="${input.key}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateVariable({
        variableId: input.variable_id,
        key: input.key,
        value: input.value,
        type: input.type,
        correlationId: ctx.correlationId,
      });
      return {
        data: {
          executed: true, dry_run: false,
          variable_id: input.variable_id,
          key: upstream?.key ?? input.key,
          value: upstream?.value ?? input.value,
        },
        audit: { before: null, after: { variable_id: input.variable_id, key: input.key } },
        summary: `Updated variable ${input.variable_id} (key: "${input.key}").`,
      };
    },
  }, callerHash);
}
