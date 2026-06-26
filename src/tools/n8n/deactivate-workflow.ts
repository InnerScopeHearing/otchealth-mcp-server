import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deactivateWorkflow } from '../../n8n/write-client.js';

export function registerN8nDeactivateWorkflow(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_deactivate_workflow',
    category: 'write_simple',
    annotations: {
      title: 'Deactivate n8n workflow',
      description:
        'Deactivate an n8n workflow, stopping its trigger nodes (webhooks, schedules, etc.) from firing. ' +
        'Use n8n_list_workflows to find the workflow ID. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().min(1).describe('The n8n workflow ID to deactivate (from n8n_list_workflows).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string(),
      active: z.boolean().nullable(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            workflow_id: input.workflow_id,
            active: null,
            upstream_result: null,
          },
          audit: { before: null, after: input },
          summary: `DRY RUN: would deactivate workflow ${input.workflow_id}. Pass dry_run=false to apply.`,
        };
      }

      const upstream = await deactivateWorkflow(input.workflow_id, { correlationId: ctx.correlationId });

      return {
        data: {
          executed: true,
          dry_run: false,
          workflow_id: input.workflow_id,
          active: upstream?.active ?? false,
          upstream_result: upstream,
        },
        audit: { before: null, after: { workflow_id: input.workflow_id, active: false } },
        summary: `Deactivated workflow ${input.workflow_id}.`,
      };
    },
  }, callerHash);
}
