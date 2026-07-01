import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createInsight } from '../../posthog/full-client.js';

export function registerPostHogInsightCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_insight_create',
    category: 'write_simple',
    annotations: {
      title: 'Create PostHog insight',
      description: 'Create a new insight on a PostHog project (POST /api/projects/{id}/insights/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      name: z.string().optional().describe('Human-readable insight name.'),
      description: z.string().optional().describe('Insight description.'),
      filters: z.record(z.unknown()).optional().describe('PostHog filters object (legacy query format).'),
      query: z.record(z.unknown()).optional().describe('PostHog HogQL or query node object.'),
      saved: z.boolean().optional().describe('Mark as a saved insight. Default false.'),
      dashboards: z.array(z.number()).optional().describe('Dashboard IDs to add this insight to.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, upstream_response: null },
          audit: { before: null, after: { name: input.name, filters: input.filters, query: input.query } },
          summary: `DRY RUN: would create insight "${input.name ?? '(unnamed)'}" on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createInsight({
        project_id: input.project_id,
        name: input.name,
        description: input.description,
        filters: input.filters,
        query: input.query,
        saved: input.saved,
        dashboards: input.dashboards,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog insight created on project ${input.project_id} (id: ${upstream?.id}).`,
      };
    },
  }, callerHash);
}
