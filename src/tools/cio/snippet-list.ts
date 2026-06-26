import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSnippets } from '../../customerio/full-client.js';

export function registerCioSnippetList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_snippet_list',
    category: 'read',
    annotations: {
      title: 'List Customer.io snippets',
      description: 'List all Liquid snippets (reusable content blocks) in the workspace via App API GET /snippets. Returns snippet IDs, names, and values for inclusion in email templates.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      snippets: z.unknown(),
    },
    handler: async (_input, ctx) => {
      const snippets = await listSnippets({ correlationId: ctx.correlationId });
      return { data: { snippets } };
    },
  }, callerHash);
}
