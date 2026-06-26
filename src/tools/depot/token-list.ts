import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjectTokens } from '../../depot/full-client.js';

export function registerDepotTokenList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_token_list',
    category: 'read',
    annotations: {
      title: 'Depot: list project tokens',
      description: 'List project tokens for a Depot project. Returns token IDs, descriptions, and created dates — never secret values. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID.'),
    },
    outputShape: {
      tokens: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const result = await listProjectTokens({ projectId: input.project_id });
      const tokens = (result?.tokens ?? []).map((t: any) => ({
        tokenId: t.tokenId,
        description: t.description,
        createdAt: t.createdAt,
        // Explicitly exclude any secret value field
      }));
      return {
        data: { tokens, count: tokens.length },
        summary: `${tokens.length} project token(s) for project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
