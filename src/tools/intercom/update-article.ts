import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateArticle } from '../../intercom/write-client.js';

export function registerIntercomUpdateArticle(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_update_article',
    category: 'write_simple',
    annotations: {
      title: 'Update an Intercom help-center article',
      description: 'Update title, body, description, or state of an existing Intercom help-center article via PUT /articles/{id}. Use to publish drafts or correct live content. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      article_id: z.string().describe('Intercom article id to update (from intercom_list_articles or intercom_get_article).'),
      title: z.string().optional().describe('New article title.'),
      body: z.string().optional().describe('New article body HTML.'),
      description: z.string().optional().describe('New article description/summary.'),
      state: z.enum(['draft', 'published']).optional().describe('New article state.'),
      author_id: z.number().int().optional().describe('Change article author (Intercom admin id).'),
      parent_id: z.number().int().optional().describe('Move to a different parent collection or section id.'),
      parent_type: z.enum(['collection', 'section']).optional().describe('Type of the new parent container.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      article_id: z.string(),
      state: z.string().nullable(),
      title: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, article_id: input.article_id, state: input.state ?? null, title: input.title ?? null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update article ${input.article_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await updateArticle({
        article_id: input.article_id,
        title: input.title,
        body: input.body,
        description: input.description,
        state: input.state,
        author_id: input.author_id,
        parent_id: input.parent_id,
        parent_type: input.parent_type,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          article_id: resp.id ?? input.article_id,
          state: resp.state ?? null,
          title: resp.title ?? null,
        },
        audit: { before: null, after: input },
        summary: `Article ${resp.id ?? input.article_id} updated (state: ${resp.state ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
