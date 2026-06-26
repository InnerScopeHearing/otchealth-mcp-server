import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCohort } from '../../posthog/full-client.js';

export function registerPostHogCohortCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_cohort_create',
    category: 'write_simple',
    annotations: {
      title: 'Create PostHog cohort',
      description: 'Create a new cohort on a PostHog project (POST /api/projects/{id}/cohorts/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      name: z.string().min(1).describe('Cohort name.'),
      description: z.string().optional().describe('Cohort description.'),
      filters: z.record(z.unknown()).optional().describe('PostHog filters object for dynamic cohort membership.'),
      groups: z.array(z.record(z.unknown())).optional().describe('Legacy group-based cohort definition.'),
      is_static: z.boolean().optional().describe('True for a static (manually curated) cohort.'),
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
          audit: { before: null, after: { name: input.name, is_static: input.is_static } },
          summary: `DRY RUN: would create cohort "${input.name}" on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createCohort({
        project_id: input.project_id,
        name: input.name,
        description: input.description,
        filters: input.filters,
        groups: input.groups,
        is_static: input.is_static,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, name: input.name, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog cohort "${input.name}" created on project ${input.project_id} (id: ${upstream?.id}).`,
      };
    },
  }, callerHash);
}
