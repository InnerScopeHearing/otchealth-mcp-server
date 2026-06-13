import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCacheUsage } from '../../depot/api-client.js';

export function registerDepotListCacheUsage(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'depot_list_cache_usage',
      category: 'read',
      annotations: {
        title: 'List Depot build cache usage',
        description:
          'Report a Depot project build-cache usage (size, last used). Scopes to project_id (or DEPOT_PROJECT_ID). Pair with depot_get_usage for full grant-burn visibility.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        project_id: z.string().optional().describe('Depot project id. Defaults to DEPOT_PROJECT_ID if unset.'),
      },
      outputShape: {
        cache: z.unknown(),
        source_rpc: z.string(),
      },
      handler: async (input, ctx) => {
        const { cache, source_rpc } = await getCacheUsage(
          { projectId: input.project_id },
          { correlationId: ctx.correlationId },
        );
        return {
          data: { cache, source_rpc },
          summary: `Depot cache usage from ${source_rpc}.`,
        };
      },
    },
    callerHash,
  );
}
