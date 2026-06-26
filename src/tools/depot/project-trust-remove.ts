import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { removeTrustPolicy } from '../../depot/full-client.js';

export function registerDepotProjectTrustRemove(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_project_trust_remove',
    category: 'write_simple',
    annotations: {
      title: 'Depot: remove project trust policy',
      description: 'Remove an OIDC trust policy from a Depot project by policy ID. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID.'),
      trust_policy_id: z.string().describe('ID of the trust policy to remove (from depot_project_trust_list).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would remove trust policy ${input.trust_policy_id} from project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      await removeTrustPolicy({ projectId: input.project_id, trustPolicyId: input.trust_policy_id });
      return {
        data: { executed: true, dry_run: false },
        audit: { before: { trust_policy_id: input.trust_policy_id }, after: null },
        summary: `Removed trust policy ${input.trust_policy_id} from Depot project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
