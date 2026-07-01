import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getGroup } from '../../posthog/full-client.js';

export function registerPostHogGroupGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_group_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog group',
      description: 'Retrieve a single group by type index + group key (GET /api/projects/{id}/groups/find/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      group_type_index: z.number().int().min(0).describe('Group type index (0-4).'),
      group_key: z.string().min(1).describe('Group key (e.g. company id or org slug).'),
    },
    outputShape: {
      group: z.unknown(),
    },
    handler: async (input) => {
      const group = await getGroup({
        project_id: input.project_id,
        group_type_index: input.group_type_index,
        group_key: input.group_key,
      });
      return {
        data: { group },
        summary: `Group "${input.group_key}" (type_index=${input.group_type_index}) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
