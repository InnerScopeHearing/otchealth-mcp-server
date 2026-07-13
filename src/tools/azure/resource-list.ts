import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { armRequest, azureConfig, assertNonPhiTarget } from '../../azure/arm-client.js';

interface ArmResource {
  name?: string;
  type?: string;
  location?: string;
  kind?: string;
}

export function registerAzureResourceList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_resource_list',
      category: 'read',
      annotations: {
        title: 'Azure: list resources in a resource group',
        description:
          'List Azure resources (name, type, location) in the resource groups the gateway can read (rg-otchealth-apps-prod + otchealth-automation-rg by default). Optional resourceType filter, e.g. Microsoft.App/containerApps, Microsoft.Search/searchServices. Use it to inventory what actually exists in the estate. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        resource_group: z
          .string()
          .optional()
          .describe('Limit to one resource group (default: all readable RGs).'),
        resource_type: z
          .string()
          .optional()
          .describe('Filter by resource type, e.g. Microsoft.App/jobs.'),
      },
      outputShape: { count: z.number(), resources: z.array(z.unknown()) },
      handler: async (input) => {
        const { subscriptionId, readerResourceGroups } = azureConfig();
        const rgs = input.resource_group ? [input.resource_group] : readerResourceGroups;
        for (const rg of rgs) assertNonPhiTarget(rg);
        const filter = input.resource_type ? `&$filter=resourceType eq '${input.resource_type.replace(/'/g, "''")}'` : '';
        const resources: Array<Record<string, unknown>> = [];
        for (const rg of rgs) {
          const res = await armRequest<{ value?: ArmResource[] }>(
            'GET',
            `/subscriptions/${subscriptionId}/resourceGroups/${rg}/resources?api-version=2021-04-01${filter}`,
          );
          for (const r of res.body?.value || []) {
            resources.push({ name: r.name, type: r.type, location: r.location, kind: r.kind, resourceGroup: rg });
          }
        }
        return {
          data: { count: resources.length, resources },
          summary: `${resources.length} resource(s) across ${rgs.join(', ')}${input.resource_type ? ` of type ${input.resource_type}` : ''}.`,
        };
      },
    },
    callerHash,
  );
}
