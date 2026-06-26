import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createArticle } from '../../intercom/write-client.js';

export function registerIntercomCreateArticle(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_create_article',
    category: 'write_simple',
    annotations: {
      title: 'Create a new Intercom help-center article',
      description: 'Create a new article in the Intercom help center via POST /articles. Article can be saved as draft or published immediately. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      title: z.string().describe('Article title.'),
      body: z.string().optional().describe('Article body HTML content.'),
      author_id: z.number().int().describe('Intercom admin id who authors the article. Required by Intercom.'),
      description: z.string().optional().describe('Short article description/summary.'),
      state: z.enum(['draft', 'published']).optional().describe('Article state (default draft).'),
      parent_id: z.number().int().optional().describe('Collection or section id to nest the article under.'),
      parent_type: z.enum(['collection', 'section']).optional().describe('Type of the parent container.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      article_id: z.string().nullable(),
      title: z.string(),
      state: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, article_id: null, title: input.title, state: input.state ?? 'draft' },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create article "${input.title}" (state: ${input.state ?? 'draft'}). Pass dry_run=false to apply.`,
        };
      }
      const resp = await createArticle({
        title: input.title,
        body: input.body,
        author_id: input.author_id,
        description: input.description,
        state: input.state,
        parent_id: input.parent_id,
        parent_type: input.parent_type,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          article_id: resp.id ?? null,
          title: resp.title ?? input.title,
          state: resp.state ?? null,
        },
        audit: { before: null, after: input },
        summary: `Article "${resp.title ?? input.title}" created (id: ${resp.id ?? 'unknown'}, state: ${resp.state ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
