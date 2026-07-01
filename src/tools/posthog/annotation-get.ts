import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getAnnotation } from '../../posthog/full-client.js';

export function registerPostHogAnnotationGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_annotation_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog annotation',
      description: 'Retrieve a single annotation by ID (GET /api/projects/{id}/annotations/{annotation_id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      annotation_id: z.string().min(1).describe('Annotation numeric ID.'),
    },
    outputShape: {
      annotation: z.unknown(),
    },
    handler: async (input) => {
      const annotation = await getAnnotation({ project_id: input.project_id, annotation_id: input.annotation_id });
      return {
        data: { annotation },
        summary: `Annotation ${input.annotation_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
