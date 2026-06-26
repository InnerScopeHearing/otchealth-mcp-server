import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMonitors } from '../../sentry/full-client.js';

export function registerSentryMonitorList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_monitor_list',
    category: 'read',
    annotations: {
      title: 'List Sentry cron monitors',
      description: 'List all cron/uptime monitors in the Sentry organization.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: { monitors: z.array(z.unknown()), count: z.number() },
    handler: async () => {
      const monitors = await listMonitors();
      return { data: { monitors, count: monitors.length }, summary: `${monitors.length} monitor(s).` };
    },
  }, callerHash);
}
