import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProject } from '../../depot/full-client.js';

export function registerDepotProjectGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_project_get',
    category: 'read',
    annotations: {
      title: 'Depot: get project',
      description: 'Get details for a specific Depot build project by ID, including region, cache policy, and organization. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID to fetch.'),
    },
    outputShape: {
      project: z.unknown(),
    },
    handler: async (input) => {
      const result = await getProject({ projectId: input.project_id });
      return {
        data: { project: result?.project ?? result },
        summary: `Depot project ${input.project_id} fetched.`,
      };
    },
  }, callerHash);
}
