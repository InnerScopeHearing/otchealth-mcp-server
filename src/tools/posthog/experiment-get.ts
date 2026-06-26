import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getExperiment } from '../../posthog/full-client.js';

export function registerPostHogExperimentGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_experiment_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog experiment',
      description: 'Retrieve a single experiment by ID (GET /api/projects/{id}/experiments/{experiment_id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      experiment_id: z.string().min(1).describe('Experiment numeric ID.'),
    },
    outputShape: {
      experiment: z.unknown(),
    },
    handler: async (input) => {
      const experiment = await getExperiment({ project_id: input.project_id, experiment_id: input.experiment_id });
      return {
        data: { experiment },
        summary: `Experiment ${input.experiment_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
