import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listReleases } from '../../sentry/full-client.js';

export function registerSentryReleaseList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_release_list',
    category: 'read',
    annotations: {
      title: 'List Sentry releases',
      description: 'List all releases in the Sentry organization.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: { releases: z.array(z.unknown()), count: z.number() },
    handler: async () => {
      const releases = await listReleases();
      return { data: { releases, count: releases.length }, summary: `${releases.length} release(s).` };
    },
  }, callerHash);
}
