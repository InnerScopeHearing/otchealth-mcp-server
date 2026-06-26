import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteVariable } from '../../n8n/full-client.js';

export function registerN8nVariableDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_variable_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete n8n variable',
      description:
        'Permanently delete an n8n instance variable by ID. Workflows referencing $vars.<key> will fail at runtime after deletion. Irreversible. ' +
        'Use n8n_variable_list to find IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      variable_id: z.string().min(1).describe('ID of the variable to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      variable_id: z.string(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, variable_id: input.variable_id, upstream_result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete variable ${input.variable_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteVariable(input.variable_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, variable_id: input.variable_id, upstream_result: upstream },
        audit: { before: { variable_id: input.variable_id }, after: null },
        summary: `Deleted variable ${input.variable_id}.`,
      };
    },
  }, callerHash);
}
