import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcDeleteArticle } from '../../intercom/full-client.js';

export function registerIntercomArticleDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_article_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete an Intercom help center article (irreversible)',
      description: 'Permanently delete a help center article via DELETE /articles/:id. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      article_id: z.string().describe('Intercom article ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      article_id: z.string(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, article_id: input.article_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete article ${input.article_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcDeleteArticle(input.article_id);
      return {
        data: { executed: true, dry_run: false, article_id: input.article_id, deleted: true },
        audit: { before: null, after: input },
        summary: `Article ${input.article_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
