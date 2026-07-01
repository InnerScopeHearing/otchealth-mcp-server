import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSurveys } from '../../posthog/full-client.js';

export function registerPostHogSurveyList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_survey_list',
    category: 'read',
    annotations: {
      title: 'List PostHog surveys',
      description: 'List surveys for a PostHog project (GET /api/projects/{id}/surveys/). MedReview PHI project 468398 is blocked.',
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
      const data = await listSurveys({ project_id: input.project_id, limit: input.limit, offset: input.offset });
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        data: { results, count: data?.count ?? results.length },
        summary: `${results.length} survey(s) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
