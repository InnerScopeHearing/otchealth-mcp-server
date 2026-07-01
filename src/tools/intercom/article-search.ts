import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcSearchArticles } from '../../intercom/full-client.js';

export function registerIntercomArticleSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_article_search',
    category: 'read',
    annotations: {
      title: 'Search Intercom help center articles by phrase',
      description: 'Search articles using a text phrase via GET /articles?phrase=... Returns articles matching the search query with optional state filter.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      phrase: z.string().describe('Search phrase to match against article titles and body content.'),
      state: z.enum(['published', 'draft']).optional().describe('Filter by article state (published or draft).'),
    },
    outputShape: {
      articles: z.array(z.unknown()),
      count: z.number(),
      total_count: z.number().nullable(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcSearchArticles({ phrase: input.phrase, state: input.state });
      const articles = resp.data ?? [];
      return {
        data: { articles, count: articles.length, total_count: resp.total_count ?? null },
        summary: `Found ${articles.length} article(s) matching "${input.phrase}".`,
      };
    },
  }, callerHash);
}
