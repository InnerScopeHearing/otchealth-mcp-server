import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { pushFiles } from '../../github/api-client.js';

/**
 * github_push_files — commit multiple files to a branch in ONE commit (Git Data API).
 * CTO-gated (governance) + write-gated. Creates the branch from default if missing.
 * This is the custom-gateway, governed replacement for the native GitHub MCP push.
 */
export function registerGitHubPushFiles(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'github_push_files',
      category: 'write_simple',
      annotations: {
        title: 'GitHub: push files (single commit)',
        description: 'Commit multiple files to a branch in one commit via the App installation token. Creates the branch from the default branch if it does not exist. CTO-only; honors dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string().describe('Repo owner/org, e.g. "InnerScopeHearing".'),
        repo: z.string().describe('Repository name.'),
        branch: z.string().describe('Target branch (created from default if missing).'),
        message: z.string().describe('Commit message.'),
        files: z.array(z.object({ path: z.string(), content: z.string() })).min(1).describe('Files to commit (path + UTF-8 content).'),
      },
      outputShape: { commit: z.string().optional(), branch: z.string(), files: z.number(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return { data: { branch: input.branch, files: input.files.length, planned: true }, summary: `DRY RUN: would commit ${input.files.length} file(s) to ${input.owner}/${input.repo}@${input.branch}. Pass dry_run=false to execute.` };
        }
        const r = await pushFiles(input.owner, input.repo, input.branch, input.files, input.message);
        return { data: r, summary: `Pushed ${r.files} file(s) to ${input.owner}/${input.repo}@${r.branch} (commit ${r.commit.slice(0, 12)}).`, audit: { after: r } };
      },
    },
    callerHash,
  );
}
