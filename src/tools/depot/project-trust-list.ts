import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTrustPolicies } from '../../depot/full-client.js';

export function registerDepotProjectTrustList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_project_trust_list',
    category: 'read',
    annotations: {
      title: 'Depot: list project trust policies',
      description: 'List OIDC trust policies (GitHub Actions, CircleCI, Buildkite, RWX) for a Depot project. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID.'),
    },
    outputShape: {
      trust_policies: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const result = await listTrustPolicies({ projectId: input.project_id });
      const policies = result?.trustPolicies ?? result?.policies ?? [];
      return {
        data: { trust_policies: policies, count: policies.length },
        summary: `${policies.length} trust policy/policies for project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
