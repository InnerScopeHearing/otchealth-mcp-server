import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateAction } from '../../posthog/full-client.js';

export function registerPostHogActionUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_action_update',
    category: 'write_simple',
    annotations: {
      title: 'Update PostHog action',
      description: 'Update an existing action (PATCH /api/projects/{id}/actions/{action_id}/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      action_id: z.string().min(1).describe('Action numeric ID to update.'),
      name: z.string().optional().describe('Updated action name.'),
      description: z.string().optional().describe('Updated description.'),
      steps: z.array(z.record(z.unknown())).optional().describe('Updated step definitions.'),
      tags: z.array(z.string()).optional().describe('Updated tags.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      action_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, action_id: input.action_id, upstream_response: null },
          audit: { before: null, after: { name: input.name } },
          summary: `DRY RUN: would update action ${input.action_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateAction({
        project_id: input.project_id,
        action_id: input.action_id,
        name: input.name,
        description: input.description,
        steps: input.steps,
        tags: input.tags,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, action_id: input.action_id, upstream_response: upstream },
        audit: { before: null, after: { name: input.name } },
        summary: `PostHog action ${input.action_id} updated on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
