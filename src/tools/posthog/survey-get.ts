import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSurvey } from '../../posthog/full-client.js';

export function registerPostHogSurveyGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_survey_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog survey',
      description: 'Retrieve a single survey by ID (GET /api/projects/{id}/surveys/{survey_id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      survey_id: z.string().min(1).describe('Survey UUID or numeric ID.'),
    },
    outputShape: {
      survey: z.unknown(),
    },
    handler: async (input) => {
      const survey = await getSurvey({ project_id: input.project_id, survey_id: input.survey_id });
      return {
        data: { survey },
        summary: `Survey ${input.survey_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
