import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listReleaseDeploys } from '../../sentry/full-client.js';

export function registerSentryReleaseListDeploys(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_release_list_deploys',
    category: 'read',
    annotations: {
      title: 'List deploys for a Sentry release',
      description: 'List all deploy records attached to a Sentry release version.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      version: z.string().min(1).describe('Release version string.'),
    },
    outputShape: { deploys: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const deploys = await listReleaseDeploys(input.version);
      return { data: { deploys, count: deploys.length }, summary: `${deploys.length} deploy(s) for release "${input.version}".` };
    },
  }, callerHash);
}
