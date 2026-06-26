import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { commentOnIssue } from '../../github/write-client.js';

/**
 * github_comment_on_issue — post a comment on an issue or PR.
 * CTO-gated + write-gated; honors dry_run.
 */
export function registerGitHubCommentOnIssue(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'github_comment_on_issue',
      category: 'write_simple',
      annotations: {
        title: 'GitHub: comment on issue or PR',
        description:
          'Post a comment on an existing issue or pull request (they share the same endpoint). CTO-only; honors dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string().describe('Repository owner or organisation.'),
        repo: z.string().describe('Repository name.'),
        issue_number: z.number().int().positive().describe('Issue or pull request number.'),
        body: z.string().min(1).describe('Comment body (Markdown supported).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        comment_id: z.number().optional(),
        url: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true },
            audit: { before: null, after: input },
            summary: `DRY RUN: would post a comment on ${input.owner}/${input.repo}#${input.issue_number}. Pass dry_run=false to execute.`,
          };
        }
        const r = await commentOnIssue(input.owner, input.repo, input.issue_number, input.body);
        return {
          data: { executed: true, dry_run: false, comment_id: r.id, url: r.url },
          audit: { before: null, after: r },
          summary: `Posted comment (id ${r.id}) on ${input.owner}/${input.repo}#${input.issue_number}: ${r.url}`,
        };
      },
    },
    callerHash,
  );
}
