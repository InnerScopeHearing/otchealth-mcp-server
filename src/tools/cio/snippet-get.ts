import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSnippet } from '../../customerio/full-client.js';

export function registerCioSnippetGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_snippet_get',
    category: 'read',
    annotations: {
      title: 'Get a Customer.io snippet',
      description: 'Fetch full details of a single Liquid snippet via App API GET /snippets/{id}. Returns the snippet name and Liquid/HTML content value.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      snippet_id: z.number().int().positive().describe('Numeric ID of the snippet.'),
    },
    outputShape: {
      snippet: z.unknown(),
    },
    handler: async (input, ctx) => {
      const snippet = await getSnippet({ snippet_id: input.snippet_id, correlationId: ctx.correlationId });
      return { data: { snippet } };
    },
  }, callerHash);
}
