import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateCohort } from '../../posthog/full-client.js';

export function registerPostHogCohortUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_cohort_update',
    category: 'write_simple',
    annotations: {
      title: 'Update PostHog cohort',
      description: 'Update an existing cohort (PATCH /api/projects/{id}/cohorts/{cohort_id}/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      cohort_id: z.string().min(1).describe('Cohort numeric ID to update.'),
      name: z.string().optional().describe('Updated cohort name.'),
      description: z.string().optional().describe('Updated description.'),
      filters: z.record(z.unknown()).optional().describe('Updated filters object.'),
      groups: z.array(z.record(z.unknown())).optional().describe('Updated groups definition.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      cohort_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, cohort_id: input.cohort_id, upstream_response: null },
          audit: { before: null, after: { name: input.name } },
          summary: `DRY RUN: would update cohort ${input.cohort_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateCohort({
        project_id: input.project_id,
        cohort_id: input.cohort_id,
        name: input.name,
        description: input.description,
        filters: input.filters,
        groups: input.groups,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, cohort_id: input.cohort_id, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog cohort ${input.cohort_id} updated on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
