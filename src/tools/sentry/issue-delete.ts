import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteIssue } from '../../sentry/full-client.js';

export function registerSentryIssueDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_issue_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Sentry issue',
      description: 'Permanently delete a Sentry issue. Irreversible. MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      issue_id: z.string().min(1).describe('Sentry issue numeric ID to delete.'),
      project_slug: z.string().min(1).describe('Project slug the issue belongs to (PHI guard). MedReview blocked.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), issue_id: z.string() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, issue_id: input.issue_id },
          audit: { before: null, after: { issue_id: input.issue_id } },
          summary: `DRY RUN: would permanently delete Sentry issue ${input.issue_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteIssue(input.issue_id, input.project_slug);
      return {
        data: { executed: true, dry_run: false, issue_id: input.issue_id },
        audit: { before: { issue_id: input.issue_id }, after: null },
        summary: `Sentry issue ${input.issue_id} deleted.`,
      };
    },
  }, callerHash);
}
