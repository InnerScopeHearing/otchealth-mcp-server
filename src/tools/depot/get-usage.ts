import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getUsage } from '../../depot/api-client.js';

export function registerDepotGetUsage(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'depot_get_usage',
      category: 'read',
      annotations: {
        title: 'Get Depot usage / grant burn',
        description:
          'Report Depot usage (compute minutes, cache, grant burn). Scopes to project_id when given (or DEPOT_PROJECT_ID), otherwise org-level. Used to monitor the $5k Depot grant burn; macOS minutes cost ~10x Linux.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        project_id: z.string().optional().describe('Scope usage to one project. Omit for org-level (or set DEPOT_PROJECT_ID).'),
      },
      outputShape: {
        usage: z.unknown(),
        source_rpc: z.string(),
      },
      handler: async (input, ctx) => {
        const { usage, source_rpc } = await getUsage(
          { projectId: input.project_id },
          { correlationId: ctx.correlationId },
        );
        return {
          data: { usage, source_rpc },
          summary: `Depot usage from ${source_rpc}.`,
        };
      },
    },
    callerHash,
  );
}
