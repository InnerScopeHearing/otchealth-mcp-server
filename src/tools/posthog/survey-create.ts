import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createSurvey } from '../../posthog/full-client.js';

export function registerPostHogSurveyCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_survey_create',
    category: 'write_simple',
    annotations: {
      title: 'Create PostHog survey',
      description: 'Create a new survey on a PostHog project (POST /api/projects/{id}/surveys/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      name: z.string().min(1).describe('Survey name.'),
      type: z.enum(['popover', 'button', 'email', 'full_screen']).describe('Survey display type.'),
      description: z.string().optional().describe('Survey description.'),
      questions: z.array(z.record(z.unknown())).optional().describe('Array of question objects.'),
      conditions: z.record(z.unknown()).optional().describe('Display conditions (URL, person property filters).'),
      appearance: z.record(z.unknown()).optional().describe('Appearance customization.'),
      start_date: z.string().optional().describe('ISO 8601 start date.'),
      end_date: z.string().optional().describe('ISO 8601 end date.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      name: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, name: input.name, upstream_response: null },
          audit: { before: null, after: { name: input.name, type: input.type } },
          summary: `DRY RUN: would create survey "${input.name}" on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createSurvey({
        project_id: input.project_id,
        name: input.name,
        type: input.type,
        description: input.description,
        questions: input.questions,
        conditions: input.conditions,
        appearance: input.appearance,
        start_date: input.start_date,
        end_date: input.end_date,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, name: input.name, upstream_response: upstream },
        audit: { before: null, after: { name: input.name, type: input.type } },
        summary: `PostHog survey "${input.name}" created on project ${input.project_id} (id: ${upstream?.id}).`,
      };
    },
  }, callerHash);
}
