import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteAnnotation } from '../../posthog/full-client.js';

export function registerPostHogAnnotationDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_annotation_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete PostHog annotation',
      description: 'Permanently delete an annotation (DELETE /api/projects/{id}/annotations/{annotation_id}/). Irreversible. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      annotation_id: z.string().min(1).describe('Annotation numeric ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      annotation_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, annotation_id: input.annotation_id },
          audit: { before: { annotation_id: input.annotation_id }, after: null },
          summary: `DRY RUN: would delete annotation ${input.annotation_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteAnnotation({ project_id: input.project_id, annotation_id: input.annotation_id });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, annotation_id: input.annotation_id },
        audit: { before: { annotation_id: input.annotation_id }, after: null },
        summary: `PostHog annotation ${input.annotation_id} deleted from project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
