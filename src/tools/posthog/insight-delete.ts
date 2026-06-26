import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteInsight } from '../../posthog/full-client.js';

export function registerPostHogInsightDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_insight_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete PostHog insight',
      description: 'Permanently delete an insight (DELETE /api/projects/{id}/insights/{insight_id}/). Irreversible. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      insight_id: z.string().min(1).describe('Insight numeric ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      insight_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, insight_id: input.insight_id },
          audit: { before: { insight_id: input.insight_id }, after: null },
          summary: `DRY RUN: would delete insight ${input.insight_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteInsight({ project_id: input.project_id, insight_id: input.insight_id });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, insight_id: input.insight_id },
        audit: { before: { insight_id: input.insight_id }, after: null },
        summary: `PostHog insight ${input.insight_id} deleted from project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
