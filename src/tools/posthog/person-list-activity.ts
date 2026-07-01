import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPersonActivity } from '../../posthog/full-client.js';

export function registerPostHogPersonListActivity(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_person_list_activity',
    category: 'read',
    annotations: {
      title: 'List PostHog person activity',
      description: 'List activity log for a person (GET /api/projects/{id}/persons/{person_id}/activity/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      person_id: z.string().min(1).describe('Person UUID or numeric ID.'),
    },
    outputShape: {
      activity: z.unknown(),
    },
    handler: async (input) => {
      const activity = await listPersonActivity({ project_id: input.project_id, person_id: input.person_id });
      return {
        data: { activity },
        summary: `Activity for person ${input.person_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
