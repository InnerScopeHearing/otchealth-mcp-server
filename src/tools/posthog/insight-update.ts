import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateInsight } from '../../posthog/full-client.js';

export function registerPostHogInsightUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_insight_update',
    category: 'write_simple',
    annotations: {
      title: 'Update PostHog insight',
      description: 'Update an existing insight (PATCH /api/projects/{id}/insights/{insight_id}/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      insight_id: z.string().min(1).describe('Insight numeric ID to update.'),
      name: z.string().optional().describe('Updated insight name.'),
      description: z.string().optional().describe('Updated description.'),
      filters: z.record(z.unknown()).optional().describe('Updated filters object.'),
      query: z.record(z.unknown()).optional().describe('Updated query node.'),
      saved: z.boolean().optional().describe('Toggle saved status.'),
      dashboards: z.array(z.number()).optional().describe('Updated list of dashboard IDs.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      insight_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, insight_id: input.insight_id, upstream_response: null },
          audit: { before: null, after: { name: input.name, filters: input.filters } },
          summary: `DRY RUN: would update insight ${input.insight_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateInsight({
        project_id: input.project_id,
        insight_id: input.insight_id,
        name: input.name,
        description: input.description,
        filters: input.filters,
        query: input.query,
        saved: input.saved,
        dashboards: input.dashboards,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, insight_id: input.insight_id, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog insight ${input.insight_id} updated on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
