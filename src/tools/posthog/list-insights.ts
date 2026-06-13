import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listInsights } from '../../posthog/api-client.js';

export function registerPosthogListInsights(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'posthog_list_insights',
      category: 'read',
      annotations: {
        title: 'List PostHog insights (funnels, trends)',
        description:
          'List saved insights for a project (funnels, trends, retention). Returns insight definitions and metadata only, never raw person-level event rows.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        project_id: z.union([z.string(), z.number()]),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        search: z.string().optional().describe('Filter by name/description text.'),
      },
      outputShape: {
        insights: z.array(z.unknown()),
        count: z.number().nullable(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | undefined> = {};
        if (input.limit !== undefined) query.limit = input.limit;
        if (input.offset !== undefined) query.offset = input.offset;
        if (input.search !== undefined) query.search = input.search;
        const data = await listInsights(input.project_id, { query, correlationId: ctx.correlationId });
        const insights = data.results ?? [];
        return {
          data: { insights, count: data.count ?? null },
          summary: `Found ${insights.length} insight(s) on this page.`,
        };
      },
    },
    callerHash,
  );
}
