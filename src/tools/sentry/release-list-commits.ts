import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listReleaseCommits } from '../../sentry/full-client.js';

export function registerSentryReleaseListCommits(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_release_list_commits',
    category: 'read',
    annotations: {
      title: 'List commits for a Sentry release',
      description: 'List the commits (authors, SHAs, messages) associated with a Sentry release.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      version: z.string().min(1).describe('Release version string.'),
    },
    outputShape: { commits: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const commits = await listReleaseCommits(input.version);
      return { data: { commits, count: commits.length }, summary: `${commits.length} commit(s) for release "${input.version}".` };
    },
  }, callerHash);
}
