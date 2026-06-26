import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getMonitor } from '../../sentry/full-client.js';

export function registerSentryMonitorGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_monitor_get',
    category: 'read',
    annotations: {
      title: 'Get a Sentry cron monitor',
      description: 'Retrieve details for a single Sentry cron/uptime monitor by slug.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      monitor_slug: z.string().min(1).describe('Monitor slug.'),
    },
    outputShape: { monitor: z.unknown() },
    handler: async (input) => {
      const monitor = await getMonitor(input.monitor_slug);
      return { data: { monitor }, summary: `Monitor "${input.monitor_slug}" retrieved.` };
    },
  }, callerHash);
}
