import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getRelease } from '../../sentry/full-client.js';

export function registerSentryReleaseGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_release_get',
    category: 'read',
    annotations: {
      title: 'Get a Sentry release',
      description: 'Retrieve full details for a Sentry release by version string.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      version: z.string().min(1).describe('Release version string (e.g. "2.4.1" or "abc1234").'),
    },
    outputShape: { release: z.unknown() },
    handler: async (input) => {
      const release = await getRelease(input.version);
      return { data: { release }, summary: `Release "${input.version}" retrieved.` };
    },
  }, callerHash);
}
