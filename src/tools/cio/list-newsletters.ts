import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet } from '../../customerio/app-api-client.js';

interface NewsletterListResponse {
  newsletters?: Array<{
    id: number | string;
    name?: string;
    type?: string;
    state?: string;
    status?: string;
    created?: number;
    updated?: number;
    sent_at?: number | null;
    deduplicate_id?: string | null;
  }>;
  next?: string | null;
}

export function registerListNewsletters(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'cio_list_newsletters',
      category: 'read',
      annotations: {
        title: 'List Customer.io newsletters',
        description:
          'List newsletters in the OTCHealth Customer.io workspace (193366). Returns ids, names, status, and timestamps. Use cursor for pagination.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Max newsletters to return per page. Customer.io default ~50.'),
        cursor: z.string().optional().describe('Pagination cursor from previous response.'),
        created_after: z
          .number()
          .int()
          .optional()
          .describe('Unix epoch seconds. Only newsletters created after this timestamp.'),
        created_before: z
          .number()
          .int()
          .optional()
          .describe('Unix epoch seconds. Only newsletters created before this timestamp.'),
      },
      outputShape: {
        newsletters: z.array(z.unknown()),
        next_cursor: z.string().nullable(),
        count: z.number(),
      },
      handler: async (input, ctx) => {
        const opts: { query: Record<string, string | number | undefined>; correlationId: string } = {
          query: {
            limit: input.limit,
            start: input.cursor,
          },
          correlationId: ctx.correlationId,
        };
        const data = (await appApiGet<NewsletterListResponse>('/newsletters', opts)) ?? {};
        let newsletters = data.newsletters ?? [];
        if (input.created_after !== undefined) {
          newsletters = newsletters.filter((n) => (n.created ?? 0) >= input.created_after!);
        }
        if (input.created_before !== undefined) {
          newsletters = newsletters.filter((n) => (n.created ?? 0) <= input.created_before!);
        }
        return {
          data: {
            newsletters,
            next_cursor: data.next ?? null,
            count: newsletters.length,
          },
          summary: `Found ${newsletters.length} newsletter${newsletters.length === 1 ? '' : 's'}.`,
        };
      },
    },
    callerHash,
  );
}
