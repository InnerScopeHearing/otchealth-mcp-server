import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createSnippet } from '../../customerio/full-client.js';

export function registerCioSnippetCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_snippet_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a Customer.io snippet',
      description: 'Create a new reusable Liquid snippet via App API POST /snippets. Snippets are referenced in email templates with {{ snippets.<name> }}. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Snippet name (used as the Liquid reference key: {{ snippets.<name> }}).'),
      value: z.string().describe('Liquid/HTML content of the snippet.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      snippet: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, snippet: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create snippet "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      const snippet = await createSnippet({ name: input.name, value: input.value, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, snippet },
        audit: { before: null, after: input },
        summary: `Snippet "${input.name}" created.`,
      };
    },
  }, callerHash);
}
