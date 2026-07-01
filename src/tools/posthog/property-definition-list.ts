import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPropertyDefinitions } from '../../posthog/full-client.js';

export function registerPostHogPropertyDefinitionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_property_definition_list',
    category: 'read',
    annotations: {
      title: 'List PostHog property definitions',
      description: 'List property definitions for a PostHog project (GET /api/projects/{id}/property_definitions/). Filter by type: event, person, group, or session. MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      limit: z.number().int().positive().optional().describe('Max results to return.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
      search: z.string().optional().describe('Filter property definitions by name.'),
      type: z.enum(['event', 'person', 'group', 'session']).optional().describe('Property type to filter on.'),
    },
    outputShape: {
      results: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const data = await listPropertyDefinitions({ project_id: input.project_id, limit: input.limit, offset: input.offset, search: input.search, type: input.type });
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        data: { results, count: data?.count ?? results.length },
        summary: `${results.length} property definition(s) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
