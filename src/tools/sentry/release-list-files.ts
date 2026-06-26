import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listReleaseFiles } from '../../sentry/full-client.js';

export function registerSentryReleaseListFiles(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_release_list_files',
    category: 'read',
    annotations: {
      title: 'List files for a Sentry release',
      description: 'List source-map / artifact files uploaded for a Sentry release.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      version: z.string().min(1).describe('Release version string.'),
    },
    outputShape: { files: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const files = await listReleaseFiles(input.version);
      return { data: { files, count: files.length }, summary: `${files.length} file(s) for release "${input.version}".` };
    },
  }, callerHash);
}
