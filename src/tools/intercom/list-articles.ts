import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { intercomGet } from '../../intercom/client.js';

interface ArticlesListResponse {
  type?: string;
  total_count?: number;
  pages?: { page?: number; per_page?: number; total_pages?: number; next?: { page?: number; starting_after?: string } };
  data?: Array<{
    id: string;
    title?: string;
    state?: string;
    parent_id?: string | null;
    parent_type?: string | null;
    url?: string | null;
    author_id?: number | null;
    created_at?: number;
    updated_at?: number;
  }>;
}

export function registerIntercomListArticles(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'intercom_list_articles',
      category: 'read',
      annotations: {
        title: 'List Intercom help-center articles',
        description:
          'Paginated list of articles in the Intercom workspace (the same 158 articles RAG-indexed for the voice agents). Returns id, title, state, parent collection, and timestamps.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        per_page: z.number().int().min(1).max(50).optional(),
        page: z.number().int().min(1).optional(),
      },
      outputShape: {
        articles: z.array(z.unknown()),
        count: z.number(),
        total_count: z.number().nullable(),
        next_page: z.number().nullable(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | undefined> = {};
        if (input.per_page !== undefined) query.per_page = input.per_page;
        if (input.page !== undefined) query.page = input.page;
        const data = await intercomGet<ArticlesListResponse>('/articles', {
          query,
          correlationId: ctx.correlationId,
        });
        const articles = data.data ?? [];
        return {
          data: {
            articles,
            count: articles.length,
            total_count: data.total_count ?? null,
            next_page: data.pages?.next?.page ?? null,
          },
          summary: `Found ${articles.length} article(s) on this page (${data.total_count ?? 'unknown'} total).`,
        };
      },
    },
    callerHash,
  );
}
