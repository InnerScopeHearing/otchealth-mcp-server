import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getPackage } from '../../revenuecat/full-client.js';

export function registerRevenueCatPackageGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_package_get',
    category: 'read',
    annotations: {
      title: 'Get RevenueCat package',
      description: 'Fetch a single package by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      offering_id: z.string().describe('Parent offering ID'),
      package_id: z.string().describe('Package ID'),
    },
    outputShape: { package: z.unknown() },
    handler: async (input) => {
      const pkg = await getPackage(input.project_id, input.offering_id, input.package_id);
      return { data: { package: pkg }, summary: `Package: ${pkg?.lookup_key ?? input.package_id}` };
    },
  }, callerHash);
}
