import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateExperiment } from '../../posthog/full-client.js';

export function registerPostHogExperimentUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_experiment_update',
    category: 'write_simple',
    annotations: {
      title: 'Update PostHog experiment',
      description: 'Update an existing experiment (PATCH /api/projects/{id}/experiments/{experiment_id}/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      experiment_id: z.string().min(1).describe('Experiment numeric ID to update.'),
      name: z.string().optional().describe('Updated experiment name.'),
      description: z.string().optional().describe('Updated description.'),
      filters: z.record(z.unknown()).optional().describe('Updated exposure filters.'),
      parameters: z.record(z.unknown()).optional().describe('Updated parameters.'),
      start_date: z.string().optional().describe('Updated ISO 8601 start date.'),
      end_date: z.string().optional().describe('Updated ISO 8601 end date.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      experiment_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, experiment_id: input.experiment_id, upstream_response: null },
          audit: { before: null, after: { name: input.name, end_date: input.end_date } },
          summary: `DRY RUN: would update experiment ${input.experiment_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateExperiment({
        project_id: input.project_id,
        experiment_id: input.experiment_id,
        name: input.name,
        description: input.description,
        filters: input.filters,
        parameters: input.parameters,
        start_date: input.start_date,
        end_date: input.end_date,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, experiment_id: input.experiment_id, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog experiment ${input.experiment_id} updated on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
