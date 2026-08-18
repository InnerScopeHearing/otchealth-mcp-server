import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertAzureToolLive, retiredDescription } from '../../azure/retired.js';
import { armRequest, azureConfig, assertNonPhiTarget } from '../../azure/arm-client.js';

interface ArmExecution {
  name?: string;
  properties?: { status?: string; startTime?: string; endTime?: string };
}

export function registerAzureJobExecutions(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_job_executions',
      category: 'read',
      annotations: {
        title: 'Azure: list a job\'s execution history',
        description: retiredDescription(
          'azure_job_executions',
          'List recent executions of an Azure Container Apps Job (status Succeeded/Failed/Running, start/end times). This is how you tell whether a cron job (e.g. daily-digest, a librarian, brain-reindex) is actually running green or silently failing. Read-only.'
        ),
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        job_name: z.string().min(1).describe('The Container Apps Job name (e.g. daily-digest).'),
        resource_group: z.string().optional().describe('Resource group (default otchealth-automation-rg, where the fleet jobs live).'),
        top: z.number().int().min(1).max(100).optional().describe('Max executions to return, newest first (default 20).'),
      },
      outputShape: { count: z.number(), executions: z.array(z.unknown()) },
      handler: async (input) => {
        // RETIRED (see src/azure/retired.ts). Fails immediately -- before input handling,
        // before the dry-run branch, before any auth or network attempt -- with a named,
        // actionable error rather than a vague auth failure or a plausible dry-run plan.
        assertAzureToolLive('azure_job_executions');
        const { subscriptionId } = azureConfig();
        const rg = input.resource_group || 'otchealth-automation-rg';
        const top = input.top ?? 20;
        assertNonPhiTarget(input.job_name, rg);
        const res = await armRequest<{ value?: ArmExecution[] }>(
          'GET',
          `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${input.job_name}/executions?api-version=2024-03-01`,
        );
        const executions = (res.body?.value || [])
          .map((e) => ({
            name: e.name,
            status: e.properties?.status,
            startTime: e.properties?.startTime,
            endTime: e.properties?.endTime,
          }))
          .sort((a, b) => String(b.startTime || '').localeCompare(String(a.startTime || '')))
          .slice(0, top);
        const last = executions[0];
        return {
          data: { count: executions.length, executions },
          summary: `${input.job_name}: ${executions.length} execution(s)${last ? `, latest ${last.status} at ${last.startTime}` : ''}.`,
        };
      },
    },
    callerHash,
  );
}
