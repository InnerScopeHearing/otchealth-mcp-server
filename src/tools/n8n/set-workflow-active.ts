import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { n8nWrite } from '../../n8n/api-client.js';

export function registerN8nSetWorkflowActive(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'n8n_set_workflow_active',
      category: 'write_simple',
      annotations: {
        title: 'n8n: activate / deactivate workflow',
        description: 'Activate or deactivate an n8n workflow by id (turns an automation on or off). Use n8n_list_workflows to find ids. Honors dry_run (plan-only by default).',
        readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
      },
      inputShape: {
        workflow_id: z.string().describe('n8n workflow id.'),
        active: z.boolean().describe('true = activate, false = deactivate.'),
      },
      outputShape: { id: z.string().optional(), active: z.boolean().optional(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        const verb = input.active ? 'activate' : 'deactivate';
        if (ctx.dryRun) return { data: { planned: true }, summary: `DRY RUN: would ${verb} workflow ${input.workflow_id}. Pass dry_run=false to execute.` };
        const r = await n8nWrite<{ id?: string; active?: boolean }>('POST', `/workflows/${encodeURIComponent(input.workflow_id)}/${verb}`, undefined, { correlationId: ctx.correlationId });
        return { data: { id: r.id ?? input.workflow_id, active: r.active ?? input.active }, summary: `Workflow ${input.workflow_id} ${verb}d.`, audit: { after: { active: input.active } } };
      },
    },
    callerHash,
  );
}
