import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deletePerson } from '../../posthog/full-client.js';

export function registerPostHogPersonDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_person_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete PostHog person',
      description: 'Permanently delete a person and optionally their events (DELETE /api/projects/{id}/persons/{person_id}/). GDPR erasure path — irreversible. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      person_id: z.string().min(1).describe('Person UUID or numeric ID to delete.'),
      delete_events: z.boolean().optional().describe('Also hard-delete all events for this person. Defaults to false.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      person_id: z.string(),
      delete_events: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, person_id: input.person_id, delete_events: input.delete_events ?? false },
          audit: { before: { person_id: input.person_id }, after: null },
          summary: `DRY RUN: would delete person ${input.person_id} on project ${input.project_id}${input.delete_events ? ' (including events)' : ''}. Pass dry_run=false to apply.`,
        };
      }
      await deletePerson({ project_id: input.project_id, person_id: input.person_id, delete_events: input.delete_events });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, person_id: input.person_id, delete_events: input.delete_events ?? false },
        audit: { before: { person_id: input.person_id }, after: null },
        summary: `PostHog person ${input.person_id} deleted from project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
