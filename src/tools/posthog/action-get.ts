import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getAction } from '../../posthog/full-client.js';

export function registerPostHogActionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_action_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog action',
      description: 'Retrieve a single action by ID (GET /api/projects/{id}/actions/{action_id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      action_id: z.string().min(1).describe('Action numeric ID.'),
    },
    outputShape: {
      action: z.unknown(),
    },
    handler: async (input) => {
      const action = await getAction({ project_id: input.project_id, action_id: input.action_id });
      return {
        data: { action },
        summary: `Action ${input.action_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
