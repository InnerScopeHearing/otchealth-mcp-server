import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProject } from '../../posthog/full-client.js';

export function registerPostHogProjectGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_project_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog project',
      description: 'Retrieve configuration details for a single PostHog project (GET /api/projects/{id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
    },
    outputShape: {
      project: z.unknown(),
    },
    handler: async (input) => {
      const project = await getProject({ project_id: input.project_id });
      return {
        data: { project },
        summary: `PostHog project ${input.project_id} details.`,
      };
    },
  }, callerHash);
}
