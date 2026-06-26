import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPersons } from '../../posthog/full-client.js';

export function registerPostHogPersonList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_person_list',
    category: 'read',
    annotations: {
      title: 'List PostHog persons',
      description: 'List persons (users) in a PostHog project (GET /api/projects/{id}/persons/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      limit: z.number().int().positive().optional().describe('Max results to return.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
      search: z.string().optional().describe('Search persons by distinct_id or property value.'),
      cohort: z.number().int().positive().optional().describe('Filter to persons in a specific cohort ID.'),
    },
    outputShape: {
      results: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const data = await listPersons({ project_id: input.project_id, limit: input.limit, offset: input.offset, search: input.search, cohort: input.cohort });
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        data: { results, count: data?.count ?? results.length },
        summary: `${results.length} person(s) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
