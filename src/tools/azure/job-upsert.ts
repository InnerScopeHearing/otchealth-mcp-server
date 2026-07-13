import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { armRequest, azureConfig, assertNonPhiTarget } from '../../azure/arm-client.js';

export function registerAzureJobUpsert(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_job_upsert',
      category: 'write_orchestrated',
      annotations: {
        title: 'Azure: create/update a Container Apps Job',
        description:
          'Create or update an Azure Container Apps Job via ARM PUT (declarative desired state). Use to schedule the freshness canary / fleet-backup etc. Provide the full ARM `properties` (environmentId + configuration + template) and `location`. NO delete. dry_run defaults TRUE (returns the exact PUT body to review); pass dry_run=false to apply. CTO-only, high-risk-gated.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        job_name: z.string().min(1).describe('Job name.'),
        resource_group: z.string().optional().describe('Resource group (default otchealth-automation-rg).'),
        location: z.string().optional().describe('Azure region (required on create; on update the existing location is reused if omitted).'),
        properties: z
          .record(z.unknown())
          .describe('The ARM job `properties` object: environmentId, configuration (triggerType, scheduleTriggerConfig/manualTriggerConfig, replicaTimeout), template (containers). This is the declarative desired state.'),
      },
      outputShape: { upserted: z.boolean(), name: z.string(), provisioningState: z.unknown(), dry_run: z.boolean() },
      handler: async (input, ctx) => {
        const { subscriptionId } = azureConfig();
        const rg = input.resource_group || 'otchealth-automation-rg';
        assertNonPhiTarget(input.job_name, rg);
        // PHI-scan the images in the template (defense in depth).
        const containers = (((input.properties as Record<string, unknown>).template as Record<string, unknown>)?.containers) as Array<{ image?: string }> | undefined;
        for (const c of containers || []) assertNonPhiTarget(c?.image);

        const base = `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${input.job_name}?api-version=2024-03-01`;
        // Reuse the existing location on update; require it on create.
        let location = input.location;
        const existing = await armRequest<{ location?: string }>('GET', base).catch(() => null);
        if (!location) location = existing?.body?.location;
        if (!location) {
          throw new Error(`location is required to create job ${input.job_name} (it does not exist yet).`);
        }
        const putBody = { location, properties: input.properties };
        if (ctx.dryRun) {
          return {
            data: { upserted: false, name: input.job_name, dry_run: true, planned: { method: 'PUT', body: putBody } },
            summary: `DRY RUN: would ${existing?.body ? 'UPDATE' : 'CREATE'} job ${input.job_name} in ${rg} (${location}). Pass dry_run=false to apply.`,
          };
        }
        const res = await armRequest<{ name?: string; properties?: { provisioningState?: string } }>('PUT', base, putBody);
        return {
          data: { upserted: true, name: input.job_name, provisioningState: res.body?.properties?.provisioningState, dry_run: false },
          summary: `${existing?.body ? 'Updated' : 'Created'} job ${input.job_name} (${res.body?.properties?.provisioningState}).`,
          audit: { before: existing?.body ? { existed: true } : { existed: false }, after: { name: input.job_name, provisioningState: res.body?.properties?.provisioningState } },
        };
      },
    },
    callerHash,
  );
}
