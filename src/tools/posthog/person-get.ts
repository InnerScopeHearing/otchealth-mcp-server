import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getPerson } from '../../posthog/full-client.js';

export function registerPostHogPersonGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_person_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog person',
      description: 'Retrieve a single person by ID (GET /api/projects/{id}/persons/{person_id}/). MedReview PHI project 468398 is blocked.',
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
      person: z.unknown(),
    },
    handler: async (input) => {
      const person = await getPerson({ project_id: input.project_id, person_id: input.person_id });
      return {
        data: { person },
        summary: `Person ${input.person_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
