import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { mergeIssues } from '../../sentry/full-client.js';

export function registerSentryIssueMerge(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_issue_merge',
    category: 'write_simple',
    annotations: {
      title: 'Merge Sentry issues',
      description: 'Merge two or more Sentry issues into a single issue. MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug the issues belong to (PHI guard). MedReview blocked.'),
      issue_ids: z.array(z.string().min(1)).min(2).describe('Array of at least two Sentry issue IDs to merge.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), upstream_response: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, upstream_response: null },
          audit: { before: null, after: { project_slug: input.project_slug, issue_ids: input.issue_ids } },
          summary: `DRY RUN: would merge issues [${input.issue_ids.join(', ')}] in "${input.project_slug}". Pass dry_run=false to apply.`,
        };
      }
      const result = await mergeIssues(input.project_slug, input.issue_ids);
      return {
        data: { executed: true, dry_run: false, upstream_response: result },
        audit: { before: null, after: { project_slug: input.project_slug, issue_ids: input.issue_ids } },
        summary: `Merged ${input.issue_ids.length} issues in "${input.project_slug}".`,
      };
    },
  }, callerHash);
}
