import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createAction } from '../../posthog/full-client.js';

export function registerPostHogActionCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_action_create',
    category: 'write_simple',
    annotations: {
      title: 'Create PostHog action',
      description: 'Create a new action (event grouping) on a PostHog project (POST /api/projects/{id}/actions/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      name: z.string().min(1).describe('Action name.'),
      description: z.string().optional().describe('Action description.'),
      steps: z.array(z.record(z.unknown())).optional().describe('Action step definitions (event matchers, URL matchers, etc.).'),
      tags: z.array(z.string()).optional().describe('Tags to apply to the action.'),
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
          audit: { before: null, after: { name: input.name, steps: input.steps } },
          summary: `DRY RUN: would create action "${input.name}" on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createAction({
        project_id: input.project_id,
        name: input.name,
        description: input.description,
        steps: input.steps,
        tags: input.tags,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, name: input.name, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog action "${input.name}" created on project ${input.project_id} (id: ${upstream?.id}).`,
      };
    },
  }, callerHash);
}
