import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { armRequest, azureConfig, assertNonPhiTarget, computeJobUpsertDrops } from '../../azure/arm-client.js';

export function registerAzureJobUpsert(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_job_upsert',
      category: 'write_orchestrated',
      annotations: {
        title: 'Azure: create/update a Container Apps Job (full declarative)',
        description:
          'Create or fully (re)define an Azure Container Apps Job via ARM PUT (declarative desired state). Provide the full ARM `properties` (environmentId + configuration + template) and `location`. For a NARROW change (image/cron/timeout) prefer azure_job_update -- a PUT here REPLACES the whole resource and DROPS anything the body omits. SAFETY: this tool auto-PRESERVES the job\'s existing managed identity unless you pass `identity` explicitly (silence preserves; pass identity:{type:"None"} to intentionally remove it), and its dry_run diffs the PUT body against the live job and LISTS every field the PUT would delete (identity, secrets, env vars, registries) -- the 07-05 daily-digest failure was exactly a full-PUT silently dropping the UAMI. NO delete. dry_run defaults TRUE; pass dry_run=false to apply. CTO-only, high-risk-gated.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        job_name: z.string().min(1).describe('Job name.'),
        resource_group: z.string().optional().describe('Resource group (default otchealth-automation-rg).'),
        location: z.string().optional().describe('Azure region (required on create; on update the existing location is reused if omitted).'),
        identity: z
          .record(z.unknown())
          .optional()
          .describe('ARM `identity` block (type + userAssignedIdentities). OMIT to preserve the existing identity (recommended). Pass explicitly only to change it; pass {type:"None"} to deliberately remove it.'),
        properties: z
          .record(z.unknown())
          .describe('The ARM job `properties` object: environmentId, configuration (triggerType, scheduleTriggerConfig/manualTriggerConfig, replicaTimeout, secrets, registries), template (containers). This is the declarative desired state and REPLACES the current properties.'),
      },
      outputShape: { upserted: z.boolean(), name: z.string(), provisioningState: z.unknown(), dry_run: z.boolean(), drops: z.unknown().optional() },
      handler: async (input, ctx) => {
        const { subscriptionId } = azureConfig();
        const rg = input.resource_group || 'otchealth-automation-rg';
        assertNonPhiTarget(input.job_name, rg);
        // PHI-scan the images in the template (defense in depth).
        const containers = (((input.properties as Record<string, unknown>).template as Record<string, unknown>)?.containers) as Array<{ image?: string }> | undefined;
        for (const c of containers || []) assertNonPhiTarget(c?.image);

        const base = `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${input.job_name}?api-version=2024-03-01`;
        const existing = await armRequest<Record<string, unknown>>('GET', base).catch(() => null);

        // Reuse the existing location on update; require it on create.
        let location = input.location;
        if (!location) location = existing?.body?.location as string | undefined;
        if (!location) throw new Error(`location is required to create job ${input.job_name} (it does not exist yet).`);

        // SAFETY: preserve the existing identity unless the caller explicitly overrides it. This alone
        // prevents the 07-05 failure (a full PUT with a properties-only body silently dropped the UAMI).
        const identity = input.identity !== undefined ? input.identity : (existing?.body?.identity as unknown);
        const putBody: Record<string, unknown> = { location, properties: input.properties };
        if (identity !== undefined) putBody.identity = identity;

        // Diff the PUT body against the live job: what will this full replace DELETE?
        const drops = computeJobUpsertDrops(existing?.body ?? null, { identity, properties: input.properties });

        if (ctx.dryRun) {
          return {
            data: { upserted: false, name: input.job_name, dry_run: true, drops, planned: { method: 'PUT', body: putBody } },
            summary:
              `DRY RUN: would ${existing?.body ? 'REPLACE' : 'CREATE'} job ${input.job_name} in ${rg} (${location}). ` +
              (drops.warnings.length ? `WARNINGS: ${drops.warnings.join(' ')} ` : 'No fields dropped vs live. ') +
              `Pass dry_run=false to apply.`,
          };
        }

        const res = await armRequest<{ name?: string; properties?: { provisioningState?: string } }>('PUT', base, putBody);
        return {
          data: { upserted: true, name: input.job_name, provisioningState: res.body?.properties?.provisioningState, dry_run: false, drops },
          summary:
            `${existing?.body ? 'Replaced' : 'Created'} job ${input.job_name} (${res.body?.properties?.provisioningState}).` +
            (drops.warnings.length ? ` DROPPED: ${drops.warnings.join(' ')}` : ''),
          audit: { before: existing?.body ? { existed: true, dropped: drops } : { existed: false }, after: { name: input.job_name, provisioningState: res.body?.properties?.provisioningState } },
        };
      },
    },
    callerHash,
  );
}
