import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCohort } from '../../posthog/full-client.js';

export function registerPostHogCohortGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_cohort_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog cohort',
      description: 'Retrieve a single cohort by ID (GET /api/projects/{id}/cohorts/{cohort_id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      cohort_id: z.string().min(1).describe('Cohort numeric ID.'),
    },
    outputShape: {
      cohort: z.unknown(),
    },
    handler: async (input) => {
      const cohort = await getCohort({ project_id: input.project_id, cohort_id: input.cohort_id });
      return {
        data: { cohort },
        summary: `Cohort ${input.cohort_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
