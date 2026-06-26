import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createExperiment } from '../../posthog/full-client.js';

export function registerPostHogExperimentCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_experiment_create',
    category: 'write_simple',
    annotations: {
      title: 'Create PostHog experiment',
      description: 'Create a new A/B experiment on a PostHog project (POST /api/projects/{id}/experiments/). Requires a feature flag key. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      name: z.string().min(1).describe('Experiment name.'),
      feature_flag_key: z.string().min(1).describe('Feature flag key that backs this experiment variants.'),
      description: z.string().optional().describe('Experiment description.'),
      filters: z.record(z.unknown()).optional().describe('Experiment exposure filters.'),
      parameters: z.record(z.unknown()).optional().describe('Experiment parameters (minimum_detectable_effect, etc.).'),
      secondary_metrics: z.array(z.record(z.unknown())).optional().describe('Secondary metric definitions.'),
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
          audit: { before: null, after: { name: input.name, feature_flag_key: input.feature_flag_key } },
          summary: `DRY RUN: would create experiment "${input.name}" on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createExperiment({
        project_id: input.project_id,
        name: input.name,
        feature_flag_key: input.feature_flag_key,
        description: input.description,
        filters: input.filters,
        parameters: input.parameters,
        secondary_metrics: input.secondary_metrics,
        start_date: input.start_date,
        end_date: input.end_date,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, name: input.name, upstream_response: upstream },
        audit: { before: null, after: { name: input.name, feature_flag_key: input.feature_flag_key } },
        summary: `PostHog experiment "${input.name}" created on project ${input.project_id} (id: ${upstream?.id}).`,
      };
    },
  }, callerHash);
}
