import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateFeatureFlag } from '../../posthog/write-client.js';

export function registerPostHogUpdateFeatureFlag(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_update_feature_flag',
    category: 'write_simple',
    annotations: {
      title: 'Update PostHog feature flag',
      description:
        'Update an existing PostHog feature flag via PATCH /api/projects/{id}/feature_flags/{flag_id}/. Toggle active state, rename, or adjust rollout. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z
        .string()
        .min(1)
        .describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      flag_id: z
        .string()
        .min(1)
        .describe('Numeric PostHog feature flag ID (as a string).'),
      active: z
        .boolean()
        .optional()
        .describe('Enable (true) or disable (false) the flag.'),
      name: z
        .string()
        .optional()
        .describe('New human-readable name for the flag.'),
      rollout_percentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Updated simple person rollout percentage (0-100). Ignored if filters is provided.'),
      filters: z
        .record(z.unknown())
        .optional()
        .describe('Full PostHog filters object to replace the existing targeting rules.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      flag_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            project_id: input.project_id,
            flag_id: input.flag_id,
            upstream_response: null,
          },
          audit: { before: null, after: { active: input.active, name: input.name, rollout_percentage: input.rollout_percentage } },
          summary: `DRY RUN: would update PostHog feature flag ${input.flag_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateFeatureFlag({
        project_id: input.project_id,
        flag_id: input.flag_id,
        active: input.active,
        name: input.name,
        rollout_percentage: input.rollout_percentage,
        filters: input.filters,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          project_id: input.project_id,
          flag_id: input.flag_id,
          upstream_response: upstream,
        },
        audit: { before: null, after: { active: input.active, name: input.name, rollout_percentage: input.rollout_percentage } },
        summary: `PostHog feature flag ${input.flag_id} updated on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
