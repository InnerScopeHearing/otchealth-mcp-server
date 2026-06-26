import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateSurvey } from '../../posthog/full-client.js';

export function registerPostHogSurveyUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_survey_update',
    category: 'write_simple',
    annotations: {
      title: 'Update PostHog survey',
      description: 'Update an existing survey (PATCH /api/projects/{id}/surveys/{survey_id}/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      survey_id: z.string().min(1).describe('Survey UUID or numeric ID to update.'),
      name: z.string().optional().describe('Updated survey name.'),
      description: z.string().optional().describe('Updated description.'),
      questions: z.array(z.record(z.unknown())).optional().describe('Updated questions array.'),
      conditions: z.record(z.unknown()).optional().describe('Updated display conditions.'),
      appearance: z.record(z.unknown()).optional().describe('Updated appearance.'),
      start_date: z.string().optional().describe('Updated ISO 8601 start date.'),
      end_date: z.string().optional().describe('Updated ISO 8601 end date.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      survey_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, survey_id: input.survey_id, upstream_response: null },
          audit: { before: null, after: { name: input.name } },
          summary: `DRY RUN: would update survey ${input.survey_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateSurvey({
        project_id: input.project_id,
        survey_id: input.survey_id,
        name: input.name,
        description: input.description,
        questions: input.questions,
        conditions: input.conditions,
        appearance: input.appearance,
        start_date: input.start_date,
        end_date: input.end_date,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, survey_id: input.survey_id, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog survey ${input.survey_id} updated on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
