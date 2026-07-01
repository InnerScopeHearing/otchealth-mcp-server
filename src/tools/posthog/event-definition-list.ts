import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEventDefinitions } from '../../posthog/full-client.js';

export function registerPostHogEventDefinitionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_event_definition_list',
    category: 'read',
    annotations: {
      title: 'List PostHog event definitions',
      description: 'List event definitions (schema) for a PostHog project (GET /api/projects/{id}/event_definitions/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      limit: z.number().int().positive().optional().describe('Max results to return.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
      search: z.string().optional().describe('Filter event definitions by name.'),
    },
    outputShape: {
      results: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const data = await listEventDefinitions({ project_id: input.project_id, limit: input.limit, offset: input.offset, search: input.search });
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        data: { results, count: data?.count ?? results.length },
        summary: `${results.length} event definition(s) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
