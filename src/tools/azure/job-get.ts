import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { armRequest, azureConfig, assertNonPhiTarget, redactJob } from '../../azure/arm-client.js';

export function registerAzureJobGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_job_get',
      category: 'read',
      annotations: {
        title: 'Azure: get a Container Apps Job (values-stripped)',
        description:
          'Get one Azure Container Apps Job in full: running image (+ digest), the managed IDENTITY (type + user-assigned identity ids -- this is how you SEE whether a job still has the UAMI it needs to read Key Vault, the exact field the 07-05 daily-digest failure lost), trigger type + cron, replica timeout/retry policy, env-var NAMES ONLY, and secret/registry NAMES ONLY. It NEVER returns an env-var value or secret value. Use it before azure_job_update to confirm current state, or to diagnose a job that is failing to read secrets. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        job_name: z.string().min(1).describe('The Container Apps Job name (e.g. daily-digest, brain-reindex).'),
        resource_group: z.string().optional().describe('Resource group (default otchealth-automation-rg, where the fleet jobs live).'),
      },
      outputShape: { job: z.unknown() },
      handler: async (input) => {
        const { subscriptionId } = azureConfig();
        const rg = input.resource_group || 'otchealth-automation-rg';
        assertNonPhiTarget(input.job_name, rg);
        const res = await armRequest<Record<string, unknown>>(
          'GET',
          `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${input.job_name}?api-version=2024-03-01`,
        );
        const job = redactJob(res.body || {});
        const ident = job.identity as { type?: string; userAssignedIdentities?: string[] } | undefined;
        const img = (job.containers as Array<{ image?: string }> | undefined)?.[0]?.image || '';
        const digest = img.includes('@sha256:') ? img.split('@sha256:')[1].slice(0, 12) : img.split('/').pop();
        return {
          data: { job },
          summary:
            `${input.job_name}: state=${job.provisioningState}, image=${digest}, ` +
            `identity=${ident?.type}${ident?.userAssignedIdentities?.length ? `(${ident.userAssignedIdentities.length} UAMI)` : ''}, ` +
            `trigger=${job.triggerType}${job.cron ? ` cron="${job.cron}"` : ''}, ${(job.secretNames as string[] | undefined)?.length || 0} secret name(s) (VALUES redacted).`,
        };
      },
    },
    callerHash,
  );
}
