import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listOrgTags } from '../../sentry/full-client.js';

export function registerSentryTagList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_tag_list',
    category: 'read',
    annotations: {
      title: 'List org-level Sentry tags',
      description: 'List all tag keys seen across the Sentry organization.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: { tags: z.array(z.unknown()), count: z.number() },
    handler: async () => {
      const tags = await listOrgTags();
      return { data: { tags, count: tags.length }, summary: `${tags.length} org-level tag key(s).` };
    },
  }, callerHash);
}
