import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updatePerson } from '../../posthog/full-client.js';

export function registerPostHogPersonUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_person_update',
    category: 'write_simple',
    annotations: {
      title: 'Update PostHog person',
      description: 'Update properties on a person (PATCH /api/projects/{id}/persons/{person_id}/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      person_id: z.string().min(1).describe('Person UUID or numeric ID to update.'),
      properties: z.record(z.unknown()).optional().describe('Properties to set on the person profile.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      person_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, person_id: input.person_id, upstream_response: null },
          audit: { before: null, after: { properties: input.properties } },
          summary: `DRY RUN: would update person ${input.person_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updatePerson({ project_id: input.project_id, person_id: input.person_id, properties: input.properties });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, person_id: input.person_id, upstream_response: upstream },
        audit: { before: null, after: { properties: input.properties } },
        summary: `PostHog person ${input.person_id} updated on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
