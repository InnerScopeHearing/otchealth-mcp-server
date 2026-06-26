import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateIssue } from '../../sentry/write-client.js';

export function registerSentryUpdateIssue(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_update_issue',
    category: 'write_simple',
    annotations: {
      title: 'Update Sentry issue (resolve / ignore / assign)',
      description:
        'Update a Sentry issue: set status (resolved, ignored, unresolved) and/or assignedTo. MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      issue_id: z.string().min(1).describe('Sentry issue numeric ID (e.g. "123456789").'),
      project_slug: z
        .string()
        .min(1)
        .describe('Project slug the issue belongs to (used for PHI guard). MedReview projects are blocked.'),
      status: z
        .enum(['resolved', 'ignored', 'unresolved'])
        .optional()
        .describe('New issue status.'),
      assigned_to: z
        .string()
        .optional()
        .describe('Username or team slug to assign the issue to (e.g. "jane@example.com" or "team:backend").'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      issue_id: z.string(),
      project_slug: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            issue_id: input.issue_id,
            project_slug: input.project_slug,
            upstream_response: null,
          },
          audit: { before: null, after: { status: input.status, assigned_to: input.assigned_to } },
          summary: `DRY RUN: would update Sentry issue ${input.issue_id} in project "${input.project_slug}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateIssue({
        issueId: input.issue_id,
        projectSlug: input.project_slug,
        status: input.status,
        assignedTo: input.assigned_to,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          issue_id: input.issue_id,
          project_slug: input.project_slug,
          upstream_response: upstream,
        },
        audit: { before: null, after: { status: input.status, assigned_to: input.assigned_to } },
        summary: `Sentry issue ${input.issue_id} updated.`,
      };
    },
  }, callerHash);
}
