import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProject } from '../../revenuecat/full-client.js';

export function registerRevenueCatProjectGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_project_get',
    category: 'read',
    annotations: {
      title: 'Get RevenueCat project',
      description: 'Fetch a single RevenueCat project by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
    },
    outputShape: { project: z.unknown() },
    handler: async (input) => {
      const project = await getProject(input.project_id);
      return { data: { project }, summary: `Project: ${project?.name ?? input.project_id}` };
    },
  }, callerHash);
}
