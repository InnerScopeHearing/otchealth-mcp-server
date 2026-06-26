import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createIssue } from '../../github/write-client.js';

/** github_create_issue — open a new issue. CTO-gated + write-gated; honors dry_run. */
export function registerGitHubCreateIssue(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'github_create_issue',
      category: 'write_simple',
      annotations: {
        title: 'GitHub: create issue',
        description:
          'Open a new issue in a repository via the App installation token. Supports labels, assignees, and milestone. CTO-only; honors dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string().describe('Repository owner or organisation.'),
        repo: z.string().describe('Repository name.'),
        title: z.string().min(1).describe('Issue title.'),
        body: z.string().optional().describe('Issue body (Markdown supported).'),
        labels: z
          .array(z.string())
          .optional()
          .describe('Label names to attach. Labels must already exist in the repo.'),
        assignees: z
          .array(z.string())
          .optional()
          .describe('GitHub usernames to assign.'),
        milestone: z.number().int().optional().describe('Milestone number to associate.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        number: z.number().optional(),
        url: z.string().optional(),
        state: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true },
            audit: { before: null, after: input },
            summary: `DRY RUN: would open issue "${input.title}" in ${input.owner}/${input.repo}. Pass dry_run=false to execute.`,
          };
        }
        const r = await createIssue({
          owner: input.owner,
          repo: input.repo,
          title: input.title,
          body: input.body,
          labels: input.labels,
          assignees: input.assignees,
          milestone: input.milestone,
        });
        return {
          data: { executed: true, dry_run: false, number: r.number, url: r.url, state: r.state },
          audit: { before: null, after: r },
          summary: `Opened issue #${r.number} in ${input.owner}/${input.repo}: ${r.url}`,
        };
      },
    },
    callerHash,
  );
}
