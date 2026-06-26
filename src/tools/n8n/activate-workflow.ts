import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { activateWorkflow } from '../../n8n/write-client.js';

export function registerN8nActivateWorkflow(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_activate_workflow',
    category: 'write_simple',
    annotations: {
      title: 'Activate n8n workflow',
      description:
        'Activate an n8n workflow so its trigger nodes (webhooks, schedules, etc.) begin listening. ' +
        'Use n8n_list_workflows to find the workflow ID. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().min(1).describe('The n8n workflow ID to activate (from n8n_list_workflows).'),
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
          summary: `DRY RUN: would activate workflow ${input.workflow_id}. Pass dry_run=false to apply.`,
        };
      }

      const upstream = await activateWorkflow(input.workflow_id, { correlationId: ctx.correlationId });

      return {
        data: {
          executed: true,
          dry_run: false,
          workflow_id: input.workflow_id,
          active: upstream?.active ?? true,
          upstream_result: upstream,
        },
        audit: { before: null, after: { workflow_id: input.workflow_id, active: true } },
        summary: `Activated workflow ${input.workflow_id}.`,
      };
    },
  }, callerHash);
}
