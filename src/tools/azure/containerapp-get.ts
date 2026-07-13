import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { armRequest, azureConfig, assertNonPhiTarget, redactContainerApp } from '../../azure/arm-client.js';

export function registerAzureContainerappGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_containerapp_get',
      category: 'read',
      annotations: {
        title: 'Azure: get a Container App (values-stripped)',
        description:
          'Get an Azure Container App: revision names, running image (+ digest), scale rules, ingress FQDN, and env-var NAMES ONLY. It deliberately NEVER returns env-var values or secret values (names/references only) so it is safe to call on the gateway itself. Use it to confirm what image/scale/config a Container App is actually running. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        name: z.string().min(1).describe('Container App name, e.g. otchealth-mcp-gateway.'),
        resource_group: z.string().optional().describe('Resource group (default rg-otchealth-apps-prod).'),
      },
      outputShape: { app: z.unknown() },
      handler: async (input) => {
        const { subscriptionId } = azureConfig();
        const rg = input.resource_group || 'rg-otchealth-apps-prod';
        assertNonPhiTarget(input.name, rg);
        const res = await armRequest<Record<string, unknown>>(
          'GET',
          `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${input.name}?api-version=2024-03-01`,
        );
        const app = redactContainerApp(res.body || {});
        const envCount = Array.isArray((app.containers as Array<{ envVarNames?: unknown[] }>)?.[0]?.envVarNames)
          ? ((app.containers as Array<{ envVarNames: unknown[] }>)[0].envVarNames.length)
          : 0;
        return {
          data: { app },
          summary: `${input.name}: state=${app.provisioningState}, latestRevision=${app.latestRevisionName}, ${envCount} env-var name(s) (VALUES redacted).`,
        };
      },
    },
    callerHash,
  );
}
