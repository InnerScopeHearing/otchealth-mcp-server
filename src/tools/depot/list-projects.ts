import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjects } from '../../depot/api-client.js';

export function registerDepotListProjects(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'depot_list_projects',
      category: 'read',
      annotations: {
        title: 'List Depot projects',
        description:
          'List the Depot build projects in the org. Returns projectId, name, region, organizationId, and timestamps. Use the projectId with the other Depot tools.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {},
      outputShape: {
        projects: z.array(z.unknown()),
        count: z.number(),
      },
      handler: async (_input, ctx) => {
        const { projects } = await listProjects({ correlationId: ctx.correlationId });
        return {
          data: { projects, count: projects.length },
          summary: `Found ${projects.length} Depot project(s).`,
        };
      },
    },
    callerHash,
  );
}
