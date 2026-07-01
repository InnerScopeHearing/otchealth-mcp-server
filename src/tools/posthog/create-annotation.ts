import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createAnnotation } from '../../posthog/write-client.js';

export function registerPostHogCreateAnnotation(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_create_annotation',
    category: 'write_simple',
    annotations: {
      title: 'Create PostHog annotation',
      description:
        'Create a timeline annotation on a PostHog project (POST /api/projects/{id}/annotations/). Useful for marking deploys, experiments, or incidents on insight charts. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z
        .string()
        .min(1)
        .describe('PostHog numeric project ID (e.g. "12345"). Project 468398 (MedReview PHI) is blocked.'),
      content: z
        .string()
        .min(1)
        .describe('Text content of the annotation (e.g. "v2.4.1 deployed to production").'),
      date_marker: z
        .string()
        .optional()
        .describe('ISO 8601 datetime to pin the annotation to (e.g. "2026-06-26T00:00:00Z"). Defaults to now.'),
      scope: z
        .enum(['project', 'organization'])
        .optional()
        .describe('Annotation scope. Defaults to "project".'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      content: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            project_id: input.project_id,
            content: input.content,
            upstream_response: null,
          },
          audit: { before: null, after: { content: input.content, date_marker: input.date_marker } },
          summary: `DRY RUN: would create annotation on PostHog project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createAnnotation({
        project_id: input.project_id,
        content: input.content,
        date_marker: input.date_marker,
        scope: input.scope,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          project_id: input.project_id,
          content: input.content,
          upstream_response: upstream,
        },
        audit: { before: null, after: { content: input.content, date_marker: input.date_marker } },
        summary: `PostHog annotation created on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
