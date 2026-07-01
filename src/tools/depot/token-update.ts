import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProjectToken } from '../../depot/full-client.js';

export function registerDepotTokenUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_token_update',
    category: 'write_simple',
    annotations: {
      title: 'Depot: update project token',
      description: 'Update the description of an existing Depot project token. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID.'),
      token_id: z.string().describe('The token ID to update (from depot_token_list).'),
      description: z.string().describe('New description for the token.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      token: z.unknown().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update token ${input.token_id} description to "${input.description}". Pass dry_run=false to apply.`,
        };
      }
      const result = await updateProjectToken({
        projectId: input.project_id,
        tokenId: input.token_id,
        description: input.description,
      });
      return {
        data: { executed: true, dry_run: false, token: result?.token ?? result },
        audit: { before: null, after: input },
        summary: `Updated token ${input.token_id} description to "${input.description}".`,
      };
    },
  }, callerHash);
}
