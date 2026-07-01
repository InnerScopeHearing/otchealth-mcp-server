import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateBulkIssues } from '../../sentry/full-client.js';

export function registerSentryIssueUpdateBulk(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_issue_update_bulk',
    category: 'write_simple',
    annotations: {
      title: 'Bulk-update Sentry issues',
      description: 'Update all issues matching a query in a project (resolve, ignore, assign, etc.). MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      query: z.string().describe('Sentry issue query string, e.g. "is:unresolved assigned:me".'),
      status: z.enum(['resolved', 'ignored', 'unresolved']).optional().describe('New status to apply.'),
      assigned_to: z.string().optional().describe('Username or team slug to assign matching issues to.'),
      has_seen: z.boolean().optional().describe('Mark issues as seen/unseen.'),
      is_bookmarked: z.boolean().optional().describe('Set bookmark state.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), upstream_response: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, upstream_response: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would bulk-update issues in "${input.project_slug}" matching query "${input.query}". Pass dry_run=false to apply.`,
        };
      }
      const result = await updateBulkIssues({
        projectSlug: input.project_slug,
        query: input.query,
        status: input.status,
        assignedTo: input.assigned_to,
        hasSeen: input.has_seen,
        isBookmarked: input.is_bookmarked,
      });
      return {
        data: { executed: true, dry_run: false, upstream_response: result },
        audit: { before: null, after: input },
        summary: `Bulk update applied to issues in "${input.project_slug}".`,
      };
    },
  }, callerHash);
}
