import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertAzureToolLive, retiredDescription } from '../../azure/retired.js';
import { armRequest, azureConfig, assertNonPhiTarget } from '../../azure/arm-client.js';

interface ArmJob {
  name?: string;
  id?: string;
  properties?: {
    provisioningState?: string;
    configuration?: {
      triggerType?: string;
      scheduleTriggerConfig?: { cronExpression?: string };
      replicaTimeout?: number;
    };
    template?: { containers?: Array<{ image?: string }> };
  };
}

export function registerAzureJobsList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_jobs_list',
      category: 'read',
      annotations: {
        title: 'Azure: list Container Apps Jobs',
        description: retiredDescription(
          'azure_jobs_list',
          'List Azure Container Apps Jobs (the cron/manual fleet: librarians, daily-digest, brain-reindex, deep-* passes, pg-migrate, innd-stock-daily) with trigger type, cron schedule, image, and provisioning state. Defaults across the RGs the gateway can read (rg-otchealth-apps-prod + otchealth-automation-rg). Read-only.'
        ),
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        resource_group: z
          .string()
          .optional()
          .describe('Limit to one resource group (default: all readable RGs, where the fleet jobs live in otchealth-automation-rg).'),
      },
      outputShape: { count: z.number(), jobs: z.array(z.unknown()) },
      handler: async (input) => {
        // RETIRED (see src/azure/retired.ts). Fails immediately -- before input handling,
        // before the dry-run branch, before any auth or network attempt -- with a named,
        // actionable error rather than a vague auth failure or a plausible dry-run plan.
        assertAzureToolLive('azure_jobs_list');
        const { subscriptionId, readerResourceGroups } = azureConfig();
        const rgs = input.resource_group ? [input.resource_group] : readerResourceGroups;
        for (const rg of rgs) assertNonPhiTarget(rg);
        const jobs: Array<Record<string, unknown>> = [];
        for (const rg of rgs) {
          const res = await armRequest<{ value?: ArmJob[] }>(
            'GET',
            `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/jobs?api-version=2024-03-01`,
          );
          for (const j of res.body?.value || []) {
            const cfg = j.properties?.configuration;
            jobs.push({
              name: j.name,
              resourceGroup: rg,
              triggerType: cfg?.triggerType,
              cron: cfg?.scheduleTriggerConfig?.cronExpression,
              replicaTimeout: cfg?.replicaTimeout,
              provisioningState: j.properties?.provisioningState,
              image: j.properties?.template?.containers?.[0]?.image,
            });
          }
        }
        return {
          data: { count: jobs.length, jobs },
          summary: `${jobs.length} Container Apps Job(s) across ${rgs.join(', ')}.`,
        };
      },
    },
    callerHash,
  );
}
