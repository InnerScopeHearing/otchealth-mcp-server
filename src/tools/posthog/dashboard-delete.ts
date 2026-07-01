import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteDashboard } from '../../posthog/full-client.js';

export function registerPostHogDashboardDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_dashboard_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete PostHog dashboard',
      description: 'Permanently delete a dashboard (DELETE /api/projects/{id}/dashboards/{dashboard_id}/). Irreversible. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      dashboard_id: z.string().min(1).describe('Dashboard numeric ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      dashboard_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, dashboard_id: input.dashboard_id },
          audit: { before: { dashboard_id: input.dashboard_id }, after: null },
          summary: `DRY RUN: would delete dashboard ${input.dashboard_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteDashboard({ project_id: input.project_id, dashboard_id: input.dashboard_id });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, dashboard_id: input.dashboard_id },
        audit: { before: { dashboard_id: input.dashboard_id }, after: null },
        summary: `PostHog dashboard ${input.dashboard_id} deleted from project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
