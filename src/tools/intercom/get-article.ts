import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { intercomGet } from '../../intercom/client.js';

export function registerIntercomGetArticle(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'intercom_get_article',
      category: 'read',
      annotations: {
        title: 'Get an Intercom help-center article',
        description:
          'Fetch full article content (title, body HTML, state, parent collection, author, timestamps) by article id. Use intercom_list_articles to find ids.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        article_id: z.string().min(1),
      },
      outputShape: {
        article: z.unknown(),
      },
      handler: async (input, ctx) => {
        const id = encodeURIComponent(input.article_id);
        const data = await intercomGet<unknown>(`/articles/${id}`, {
          correlationId: ctx.correlationId,
        });
        return { data: { article: data } };
      },
    },
    callerHash,
  );
}
