import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteProjectToken } from '../../depot/full-client.js';

export function registerDepotTokenDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_token_delete',
    category: 'write_simple',
    annotations: {
      title: 'Depot: delete project token',
      description: 'Revoke and permanently delete a Depot project token. IRREVERSIBLE — CI using this token will break immediately. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID.'),
      token_id: z.string().describe('The token ID to revoke (from depot_token_list).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      token_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, token_id: input.token_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would revoke token ${input.token_id} from project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteProjectToken({ projectId: input.project_id, tokenId: input.token_id });
      return {
        data: { executed: true, dry_run: false, token_id: input.token_id },
        audit: { before: { token_id: input.token_id }, after: null },
        summary: `Revoked Depot project token ${input.token_id}.`,
      };
    },
  }, callerHash);
}
