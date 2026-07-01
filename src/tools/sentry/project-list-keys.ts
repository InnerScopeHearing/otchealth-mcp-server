import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjectKeys } from '../../sentry/full-client.js';

export function registerSentryProjectListKeys(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_project_list_keys',
    category: 'read',
    annotations: {
      title: 'List Sentry project DSN keys',
      description: 'List all client keys (DSNs) for a Sentry project. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
    },
    outputShape: { keys: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const keys = await listProjectKeys(input.project_slug);
      return { data: { keys, count: keys.length }, summary: `${keys.length} key(s) for project "${input.project_slug}".` };
    },
  }, callerHash);
}
