import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCohorts } from '../../posthog/full-client.js';

export function registerPostHogCohortList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_cohort_list',
    category: 'read',
    annotations: {
      title: 'List PostHog cohorts',
      description: 'List cohorts for a PostHog project (GET /api/projects/{id}/cohorts/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      limit: z.number().int().positive().optional().describe('Max results to return.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
    },
    outputShape: {
      results: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const data = await listCohorts({ project_id: input.project_id, limit: input.limit, offset: input.offset });
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        data: { results, count: data?.count ?? results.length },
        summary: `${results.length} cohort(s) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
