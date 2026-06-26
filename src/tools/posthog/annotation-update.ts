import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateAnnotation } from '../../posthog/full-client.js';

export function registerPostHogAnnotationUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_annotation_update',
    category: 'write_simple',
    annotations: {
      title: 'Update PostHog annotation',
      description: 'Update an existing annotation (PATCH /api/projects/{id}/annotations/{annotation_id}/). MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      annotation_id: z.string().min(1).describe('Annotation numeric ID to update.'),
      content: z.string().optional().describe('Updated annotation text.'),
      date_marker: z.string().optional().describe('Updated ISO 8601 datetime.'),
      scope: z.enum(['project', 'organization']).optional().describe('Updated scope.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      annotation_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, annotation_id: input.annotation_id, upstream_response: null },
          audit: { before: null, after: { content: input.content, date_marker: input.date_marker } },
          summary: `DRY RUN: would update annotation ${input.annotation_id} on project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateAnnotation({
        project_id: input.project_id,
        annotation_id: input.annotation_id,
        content: input.content,
        date_marker: input.date_marker,
        scope: input.scope,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, annotation_id: input.annotation_id, upstream_response: upstream },
        audit: { before: null, after: { content: input.content } },
        summary: `PostHog annotation ${input.annotation_id} updated on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
