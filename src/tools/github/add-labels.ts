import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addLabels } from '../../github/write-client.js';

/** github_add_labels — add labels to an issue or PR. CTO-gated + write-gated; honors dry_run. */
export function registerGitHubAddLabels(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'github_add_labels',
      category: 'write_simple',
      annotations: {
        title: 'GitHub: add labels to issue or PR',
        description:
          'Add one or more labels to an existing issue or pull request. Labels must already exist in the repository. CTO-only; honors dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string().describe('Repository owner or organisation.'),
        repo: z.string().describe('Repository name.'),
        issue_number: z.number().int().positive().describe('Issue or pull request number.'),
        labels: z
          .array(z.string().min(1))
          .min(1)
          .describe('One or more label names to add. Labels must already exist in the repo.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        labels: z.array(z.string()).optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, labels: input.labels },
            audit: { before: null, after: input },
            summary: `DRY RUN: would add labels [${input.labels.join(', ')}] to ${input.owner}/${input.repo}#${input.issue_number}. Pass dry_run=false to execute.`,
          };
        }
        const r = await addLabels(input.owner, input.repo, input.issue_number, input.labels);
        return {
          data: { executed: true, dry_run: false, labels: r.labels },
          audit: { before: null, after: r },
          summary: `Labels on ${input.owner}/${input.repo}#${input.issue_number}: [${r.labels.join(', ')}].`,
        };
      },
    },
    callerHash,
  );
}
