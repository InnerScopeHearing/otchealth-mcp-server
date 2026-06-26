import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createDashboard } from '../../posthog/full-client.js';

export function registerPostHogDashboardCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_dashboard_create',
    category: 'write_simple',
    annotations: {
      title: 'Create PostHog dashboard',
      description: 'Create a new dashboard on a PostHog project (POST /api/projects/{id}/dashboards/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      name: z.string().min(1).describe('Dashboard name.'),
      description: z.string().optional().describe('Dashboard description.'),
      tags: z.array(z.string()).optional().describe('Tags to apply to the dashboard.'),
      pinned: z.boolean().optional().describe('Pin to the top of the dashboard list.'),
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
          audit: { before: null, after: { name: input.name, tags: input.tags } },
          summary: `DRY RUN: would create dashboard "${input.name}" on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createDashboard({
        project_id: input.project_id,
        name: input.name,
        description: input.description,
        tags: input.tags,
        pinned: input.pinned,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, name: input.name, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog dashboard "${input.name}" created on project ${input.project_id} (id: ${upstream?.id}).`,
      };
    },
  }, callerHash);
}
