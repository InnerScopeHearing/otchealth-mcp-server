import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listGroups } from '../../posthog/full-client.js';

export function registerPostHogGroupList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_group_list',
    category: 'read',
    annotations: {
      title: 'List PostHog groups',
      description: 'List groups (companies, orgs, etc.) for a PostHog project (GET /api/projects/{id}/groups/). Requires group_type_index. MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      group_type_index: z.number().int().min(0).describe('Group type index (0-4) identifying which group type to list.'),
      limit: z.number().int().positive().optional().describe('Max results to return.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
      search: z.string().optional().describe('Search groups by group_key or property value.'),
    },
    outputShape: {
      results: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const data = await listGroups({
        project_id: input.project_id,
        group_type_index: input.group_type_index,
        limit: input.limit,
        offset: input.offset,
        search: input.search,
      });
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        data: { results, count: data?.count ?? results.length },
        summary: `${results.length} group(s) (type_index=${input.group_type_index}) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
