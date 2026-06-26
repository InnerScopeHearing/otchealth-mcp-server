import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCohort } from '../../posthog/full-client.js';

export function registerPostHogCohortDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_cohort_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete PostHog cohort',
      description: 'Permanently delete a cohort (DELETE /api/projects/{id}/cohorts/{cohort_id}/). Irreversible. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      cohort_id: z.string().min(1).describe('Cohort numeric ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      cohort_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, cohort_id: input.cohort_id },
          audit: { before: { cohort_id: input.cohort_id }, after: null },
          summary: `DRY RUN: would delete cohort ${input.cohort_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteCohort({ project_id: input.project_id, cohort_id: input.cohort_id });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, cohort_id: input.cohort_id },
        audit: { before: { cohort_id: input.cohort_id }, after: null },
        summary: `PostHog cohort ${input.cohort_id} deleted from project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
