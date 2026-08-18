import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertAzureToolLive, retiredDescription } from '../../azure/retired.js';
import { armRequest, azureConfig, assertNonPhiTarget, applyJobPatch, redactJob } from '../../azure/arm-client.js';

export function registerAzureJobUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_job_update',
      category: 'write_orchestrated',
      annotations: {
        title: 'Azure: update a Container Apps Job (targeted, safe)',
        description: retiredDescription(
          'azure_job_update',
          'Change ONE OR MORE narrow fields on a Container Apps Job -- image (repoint to a new digest), cron schedule, replica timeout, or replica retry limit -- via a TARGETED PATCH, never a full-replace PUT. It reads the live job and changes only the fields you name, so identity (the UAMI), env vars, secrets, and registries are preserved by construction (this is what prevents the 07-05 "full-PUT dropped the identity -> job can no longer read Key Vault" failure). Prefer this over azure_job_upsert for routine changes like image repoints. dry_run defaults TRUE and returns the exact before->after diff + the PATCH body; pass dry_run=false to apply. After applying it re-reads the job and confirms identity + env survived. CTO-only, high-risk-gated.'
        ),
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        job_name: z.string().min(1).describe('The Container Apps Job to update (e.g. daily-digest).'),
        resource_group: z.string().optional().describe('Resource group (default otchealth-automation-rg).'),
        image: z.string().optional().describe('New container image, e.g. otchealthacr.azurecr.io/doc-indexer@sha256:... Repoints the primary container; env/resources are preserved.'),
        cron: z.string().optional().describe('New cron expression for a scheduled job, e.g. "59 23 * * *". Other schedule fields (parallelism) are preserved.'),
        replica_timeout: z.number().int().positive().optional().describe('New replicaTimeout in seconds.'),
        replica_retry_limit: z.number().int().min(0).optional().describe('New replicaRetryLimit.'),
      },
      outputShape: {
        updated: z.boolean(),
        name: z.string(),
        diff: z.array(z.unknown()),
        dry_run: z.boolean(),
        preserved: z.unknown().optional(),
      },
      handler: async (input, ctx) => {
        // RETIRED (see src/azure/retired.ts). Fails immediately -- before input handling,
        // before the dry-run branch, before any auth or network attempt -- with a named,
        // actionable error rather than a vague auth failure or a plausible dry-run plan.
        assertAzureToolLive('azure_job_update');
        const { subscriptionId } = azureConfig();
        const rg = input.resource_group || 'otchealth-automation-rg';
        assertNonPhiTarget(input.job_name, rg, input.image);
        const base = `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${input.job_name}?api-version=2024-03-01`;

        const existing = await armRequest<Record<string, unknown>>('GET', base).catch(() => null);
        if (!existing?.body) throw new Error(`job ${input.job_name} not found in ${rg} (use azure_job_upsert to create it).`);

        const { patchBody, diff, touched } = applyJobPatch(existing.body, {
          image: input.image,
          cron: input.cron,
          replicaTimeout: input.replica_timeout,
          replicaRetryLimit: input.replica_retry_limit,
        });
        const before = redactJob(existing.body);

        if (ctx.dryRun) {
          return {
            data: { updated: false, name: input.job_name, diff, dry_run: true, planned: { method: 'PATCH', body: patchBody } },
            summary: `DRY RUN: would PATCH ${input.job_name} [${touched.join(', ')}]: ${diff.map((d) => `${d.field} ${JSON.stringify(d.from)}->${JSON.stringify(d.to)}`).join('; ')}. Identity/env/secrets preserved (targeted PATCH). Pass dry_run=false to apply.`,
          };
        }

        await armRequest('PATCH', base, patchBody);
        // Re-read and CONFIRM the change landed AND identity/env survived (the 07-05 guardrail).
        const after = await armRequest<Record<string, unknown>>('GET', base);
        const afterJob = redactJob(after.body || {});
        const bIdent = (before.identity as { type?: string; userAssignedIdentities?: string[] });
        const aIdent = (afterJob.identity as { type?: string; userAssignedIdentities?: string[] });
        const identityPreserved = bIdent.type === aIdent.type && (bIdent.userAssignedIdentities?.length || 0) === (aIdent.userAssignedIdentities?.length || 0);
        const bEnv = ((before.containers as Array<{ envVarNames?: unknown[] }>)?.[0]?.envVarNames || []).length;
        const aEnv = ((afterJob.containers as Array<{ envVarNames?: unknown[] }>)?.[0]?.envVarNames || []).length;
        const envPreserved = bEnv === aEnv;

        return {
          data: {
            updated: true,
            name: input.job_name,
            diff,
            dry_run: false,
            preserved: { identity: identityPreserved, envCount: aEnv, envPreserved },
            after: afterJob,
          },
          summary:
            `Updated ${input.job_name} [${touched.join(', ')}]. ` +
            `Preserved: identity=${identityPreserved ? 'OK' : 'CHANGED!'} (${aIdent.type}), env=${envPreserved ? 'OK' : 'CHANGED!'} (${aEnv} vars).` +
            (identityPreserved && envPreserved ? '' : ' WARNING: a preserved field changed unexpectedly -- inspect immediately.'),
          audit: { before, after: afterJob },
        };
      },
    },
    callerHash,
  );
}
