import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getApp } from '../../revenuecat/full-client.js';

export function registerRevenueCatAppGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_app_get',
    category: 'read',
    annotations: {
      title: 'Get RevenueCat app',
      description: 'Fetch a single app (store config) by ID within a project.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      app_id: z.string().describe('App ID'),
    },
    outputShape: { app: z.unknown() },
    handler: async (input) => {
      const app = await getApp(input.project_id, input.app_id);
      return { data: { app }, summary: `App: ${app?.name ?? input.app_id}` };
    },
  }, callerHash);
}
