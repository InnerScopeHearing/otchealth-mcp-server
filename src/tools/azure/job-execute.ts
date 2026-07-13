import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { armRequest, azureConfig, assertNonPhiTarget } from '../../azure/arm-client.js';

export function registerAzureJobExecute(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_job_execute',
      category: 'write_orchestrated',
      annotations: {
        title: 'Azure: start a Container Apps Job',
        description:
          'Manually trigger an existing Azure Container Apps Job (runs already-deployed code, e.g. re-run a librarian or brain-reindex on demand). Low risk. dry_run defaults TRUE (returns the plan); pass dry_run=false to actually start it. CTO-only, high-risk-gated.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        job_name: z.string().min(1).describe('The Container Apps Job to start.'),
        resource_group: z.string().optional().describe('Resource group (default otchealth-automation-rg).'),
      },
      outputShape: { started: z.boolean(), execution: z.unknown(), dry_run: z.boolean() },
      handler: async (input, ctx) => {
        const { subscriptionId } = azureConfig();
        const rg = input.resource_group || 'otchealth-automation-rg';
        assertNonPhiTarget(input.job_name, rg);
        const path = `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${input.job_name}/start?api-version=2024-03-01`;
        if (ctx.dryRun) {
          return {
            data: { started: false, dry_run: true, planned: { action: 'POST job start', job: input.job_name, resourceGroup: rg } },
            summary: `DRY RUN: would start job ${input.job_name} in ${rg}. Pass dry_run=false to execute.`,
          };
        }
        const res = await armRequest<Record<string, unknown>>('POST', path);
        const exec = (res.body as { name?: string; id?: string } | null) || null;
        return {
          data: { started: true, dry_run: false, execution: exec },
          summary: `Started job ${input.job_name} (execution ${exec?.name || '(pending)'}).`,
          audit: { after: { job: input.job_name, execution: exec?.name } },
        };
      },
    },
    callerHash,
  );
}
