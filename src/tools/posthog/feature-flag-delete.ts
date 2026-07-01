import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteFeatureFlag } from '../../posthog/full-client.js';

export function registerPostHogFeatureFlagDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_feature_flag_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete PostHog feature flag',
      description: 'Permanently delete a feature flag (DELETE /api/projects/{id}/feature_flags/{flag_id}/). Irreversible. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      flag_id: z.string().min(1).describe('Feature flag numeric ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      flag_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, flag_id: input.flag_id },
          audit: { before: { flag_id: input.flag_id }, after: null },
          summary: `DRY RUN: would delete feature flag ${input.flag_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteFeatureFlag({ project_id: input.project_id, flag_id: input.flag_id });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, flag_id: input.flag_id },
        audit: { before: { flag_id: input.flag_id }, after: null },
        summary: `Feature flag ${input.flag_id} deleted from project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
