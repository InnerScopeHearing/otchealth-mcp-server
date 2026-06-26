import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createFeatureFlag } from '../../posthog/write-client.js';

export function registerPostHogCreateFeatureFlag(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_create_feature_flag',
    category: 'write_simple',
    annotations: {
      title: 'Create PostHog feature flag',
      description:
        'Create a new feature flag on a PostHog project (POST /api/projects/{id}/feature_flags/). Optionally set an initial rollout percentage. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z
        .string()
        .min(1)
        .describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      key: z
        .string()
        .min(1)
        .regex(/^[a-z0-9_-]+$/i, 'Flag key must contain only letters, numbers, hyphens, and underscores.')
        .describe('Unique flag key (e.g. "new-checkout-flow").'),
      name: z
        .string()
        .optional()
        .describe('Human-readable flag name.'),
      active: z
        .boolean()
        .optional()
        .describe('Whether the flag is active immediately. Defaults to false (PostHog default).'),
      rollout_percentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Simple person rollout percentage (0-100). Ignored if filters is provided.'),
      filters: z
        .record(z.unknown())
        .optional()
        .describe('Full PostHog filters object. Overrides rollout_percentage when provided.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      key: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            project_id: input.project_id,
            key: input.key,
            upstream_response: null,
          },
          audit: { before: null, after: { key: input.key, active: input.active, rollout_percentage: input.rollout_percentage } },
          summary: `DRY RUN: would create PostHog feature flag "${input.key}" on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createFeatureFlag({
        project_id: input.project_id,
        key: input.key,
        name: input.name,
        active: input.active,
        rollout_percentage: input.rollout_percentage,
        filters: input.filters,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          project_id: input.project_id,
          key: input.key,
          upstream_response: upstream,
        },
        audit: { before: null, after: { key: input.key, active: input.active, rollout_percentage: input.rollout_percentage } },
        summary: `PostHog feature flag "${input.key}" created on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
