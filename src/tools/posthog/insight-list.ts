import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listInsights } from '../../posthog/full-client.js';

export function registerPostHogInsightList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_insight_list',
    category: 'read',
    annotations: {
      title: 'List PostHog insights',
      description: 'List saved insights for a PostHog project (GET /api/projects/{id}/insights/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      limit: z.number().int().positive().optional().describe('Max results to return.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
      saved: z.boolean().optional().describe('Filter to saved insights only.'),
    },
    outputShape: {
      results: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const data = await listInsights({ project_id: input.project_id, limit: input.limit, offset: input.offset, saved: input.saved });
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        data: { results, count: data?.count ?? results.length },
        summary: `${results.length} insight(s) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
