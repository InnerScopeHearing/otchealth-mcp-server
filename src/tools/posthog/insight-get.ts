import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getInsight } from '../../posthog/full-client.js';

export function registerPostHogInsightGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_insight_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog insight',
      description: 'Retrieve a single insight by ID (GET /api/projects/{id}/insights/{insight_id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      insight_id: z.string().min(1).describe('Insight numeric ID.'),
    },
    outputShape: {
      insight: z.unknown(),
    },
    handler: async (input) => {
      const insight = await getInsight({ project_id: input.project_id, insight_id: input.insight_id });
      return {
        data: { insight },
        summary: `Insight ${input.insight_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
