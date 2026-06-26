import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateDashboard } from '../../posthog/full-client.js';

export function registerPostHogDashboardUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_dashboard_update',
    category: 'write_simple',
    annotations: {
      title: 'Update PostHog dashboard',
      description: 'Update an existing dashboard (PATCH /api/projects/{id}/dashboards/{dashboard_id}/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      dashboard_id: z.string().min(1).describe('Dashboard numeric ID to update.'),
      name: z.string().optional().describe('Updated dashboard name.'),
      description: z.string().optional().describe('Updated description.'),
      tags: z.array(z.string()).optional().describe('Updated tags.'),
      pinned: z.boolean().optional().describe('Pin/unpin the dashboard.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      dashboard_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, dashboard_id: input.dashboard_id, upstream_response: null },
          audit: { before: null, after: { name: input.name, tags: input.tags } },
          summary: `DRY RUN: would update dashboard ${input.dashboard_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateDashboard({
        project_id: input.project_id,
        dashboard_id: input.dashboard_id,
        name: input.name,
        description: input.description,
        tags: input.tags,
        pinned: input.pinned,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, dashboard_id: input.dashboard_id, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog dashboard ${input.dashboard_id} updated on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
