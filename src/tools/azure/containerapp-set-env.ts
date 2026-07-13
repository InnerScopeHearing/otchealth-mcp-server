import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import {
  armRequest,
  azureConfig,
  assertNonPhiTarget,
  assertContainerAppEnvSafe,
  mergeEnv,
  type EnvVarUpsert,
} from '../../azure/arm-client.js';

export function registerAzureContainerappSetEnv(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_containerapp_set_env',
      category: 'write_orchestrated',
      annotations: {
        title: 'Azure: set env vars on a Container App (non-destructive)',
        description:
          'Add or update environment variables on an Azure Container App. NON-DESTRUCTIVE: it merges into the existing env (never drops other vars) by reading the app and PATCHing the full template. Provide plain `value` for config, or `secretRef` (name of an existing secret) for secret-backed vars; do NOT pass raw secret values (they are never rendered back). HARD DENY: refuses to touch the gateway\'s oauth-clients binding (incident 20260713-019). dry_run defaults TRUE; pass dry_run=false to apply. CTO-only, high-risk-gated.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        name: z.string().min(1).describe('Container App name.'),
        resource_group: z.string().optional().describe('Resource group (default rg-otchealth-apps-prod).'),
        container: z.string().optional().describe('Target container name (default: the first / main container).'),
        env: z
          .array(
            z.object({
              name: z.string().min(1),
              value: z.string().optional().describe('Plain config value. Omit for a secret-backed var.'),
              secretRef: z.string().optional().describe('Name of an existing app secret to bind (for secret-backed vars).'),
            }),
          )
          .min(1)
          .describe('Env vars to add/update. Use secretRef for secrets; never a raw secret value.'),
      },
      outputShape: { updated: z.boolean(), changed: z.array(z.string()), dry_run: z.boolean() },
      handler: async (input, ctx) => {
        const { subscriptionId } = azureConfig();
        const rg = input.resource_group || 'rg-otchealth-apps-prod';
        assertNonPhiTarget(input.name, rg);
        const upserts: EnvVarUpsert[] = input.env;
        // HARD GUARD: never touch the gateway's oauth-clients binding.
        assertContainerAppEnvSafe(input.name, upserts);

        const base = `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${input.name}?api-version=2024-03-01`;
        const app = await armRequest<Record<string, unknown>>('GET', base);
        const props = (app.body?.properties || {}) as Record<string, unknown>;
        const template = (props.template || {}) as Record<string, unknown>;
        const containers = Array.isArray(template.containers) ? (template.containers as Record<string, unknown>[]) : [];
        if (!containers.length) throw new Error(`container app ${input.name} has no containers to set env on.`);
        const targetIdx = input.container ? containers.findIndex((c) => c.name === input.container) : 0;
        if (targetIdx < 0) throw new Error(`container "${input.container}" not found on ${input.name}.`);
        const existingEnv = Array.isArray(containers[targetIdx].env) ? (containers[targetIdx].env as Record<string, unknown>[]) : [];
        const { merged, changed } = mergeEnv(existingEnv, upserts);

        if (ctx.dryRun) {
          return {
            // NAMES ONLY -- never echo the values back into context.
            data: { updated: false, dry_run: true, changed, container: containers[targetIdx].name, note: 'values redacted; PATCH merges into existing env (nothing dropped)' },
            summary: `DRY RUN: would set ${changed.length} env var name(s) [${changed.join(', ')}] on ${input.name}/${containers[targetIdx].name} (non-destructive merge). Pass dry_run=false to apply.`,
          };
        }
        // PATCH back the FULL template with the merged env so no other var/field is dropped.
        const newContainers = containers.map((c, i) => (i === targetIdx ? { ...c, env: merged } : c));
        const patchBody = { properties: { template: { ...template, containers: newContainers } } };
        const res = await armRequest<{ properties?: { provisioningState?: string } }>('PATCH', base, patchBody);
        return {
          data: { updated: true, dry_run: false, changed, provisioningState: res.body?.properties?.provisioningState },
          summary: `Set ${changed.length} env var name(s) on ${input.name} (${res.status}); merged, non-destructive.`,
          audit: { before: { envCount: existingEnv.length }, after: { envCount: merged.length, changed } },
        };
      },
    },
    callerHash,
  );
}
